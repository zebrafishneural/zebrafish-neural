import test from 'node:test';
import assert from 'node:assert/strict';
import {makeState,renderRetina,step as baselineStep} from '../../dist/lib/model.js';
import {BASE_WEIGHTS,PARAMS,DT,DURATION,CONTACT_RADIUS,scenarioSet,makeRollout,tickRollout,runTrial} from './core.js';

function scenario(overrides={}){
  return {id:'fixed-example',split:'custom',seed:1,index:0,protocol:'reach',
    target:{x:.25,y:.25},initial:{x:.5,y:.75,heading:-Math.PI/2},intensity:.85,
    secondTarget:{x:.75,y:.25},reversalAt:4,occlusion:[3,8],noInput:false,...overrides};
}
function near(actual,expected,tolerance=1e-10){
  assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);
}
function allFinite(value){
  if(typeof value==='number')assert.ok(Number.isFinite(value));
  else if(Array.isArray(value))value.forEach(allFinite);
  else if(value&&typeof value==='object')Object.values(value).forEach(allFinite);
}

test('six default weights reproduce the frozen baseline step for step in all task protocols',()=>{
  for(const protocol of ['reach','reversal','occlusion']){
    const spec=scenario({protocol}),rollout=makeRollout(spec);
    const baseline=makeState({mode:'light-left',intensity:spec.intensity});
    Object.assign(baseline.fish,spec.initial);baseline.target={...spec.target};renderRetina(baseline);
    assert.deepEqual(rollout.state,baseline);
    let index=0;
    while(!rollout.finished){
      if(protocol==='reversal'&&index===200)baseline.target={...spec.secondTarget};
      baseline.config.mode=protocol==='occlusion'&&index>=150&&index<400?'dark':'light-left';
      baselineStep(baseline,DT);tickRollout(rollout);index++;
      assert.deepEqual(rollout.state,baseline,`${protocol}, step ${index}`);
    }
  }
});

test('every exposed weight changes the computed neural response and weights cannot mutate mid-trial',()=>{
  const reference=makeRollout(scenario());
  for(let i=0;i<100;i++)tickRollout(reference);
  for(let index=0;index<PARAMS.length;index++){
    const weights=Array.from(BASE_WEIGHTS);weights[index]+=(PARAMS[index].max-weights[index])*.2;
    const rollout=makeRollout(scenario(),weights);
    weights[index]=PARAMS[index].min;
    assert.notEqual(rollout.weights[index],weights[index]);
    for(let i=0;i<100;i++)tickRollout(rollout);
    assert.notDeepEqual(rollout.state.rates,reference.state.rates,PARAMS[index].id);
    assert.notDeepEqual(rollout.state.fish,reference.state.fish,PARAMS[index].id);
    assert.throws(()=>{rollout.weights[index]=0;},TypeError);
  }
});

test('parameter bounds reject invalid weights without changing the frozen defaults',()=>{
  assert.deepEqual(BASE_WEIGHTS,[.5,.45,1,.12,.08,.55]);
  for(const bad of [[],Array(6).fill(NaN),Array(6).fill(Infinity)])assert.throws(()=>makeRollout(scenario(),bad));
  for(let index=0;index<PARAMS.length;index++){
    for(const bad of [PARAMS[index].min-.001,PARAMS[index].max+.001]){
      const weights=Array.from(BASE_WEIGHTS);weights[index]=bad;
      assert.throws(()=>makeRollout(scenario(),weights),RangeError);
    }
  }
  assert.throws(()=>{BASE_WEIGHTS[0]=0;},TypeError);
  assert.throws(()=>{PARAMS[0].max=100;},TypeError);
});

test('scenario sets are immutable, deterministic prefixes with disjoint split seed namespaces',()=>{
  const seen=new Set();
  for(const split of ['train','validation','test']){
    const cases=scenarioSet(split,20260911,128);
    assert.deepEqual(cases,scenarioSet(split,20260911,128));
    assert.deepEqual(cases.slice(0,6),scenarioSet(split,20260911,6));
    assert.deepEqual(new Set(cases.map(item=>item.protocol)),new Set(['reach','reversal','occlusion']));
    for(const spec of cases){
      assert.ok(!seen.has(spec.seed));seen.add(spec.seed);
      assert.equal(spec.split,split);
      assert.throws(()=>{spec.target.x=0;},TypeError);
      if(spec.protocol==='occlusion'){
        const shortest=Math.hypot(spec.initial.x-spec.target.x,spec.initial.y-spec.target.y)-CONTACT_RADIUS;
        assert.ok(shortest/.15>3,'An occlusion trial must not finish before its scheduled interruption');
      }
    }
    assert.throws(()=>cases.push(cases[0]),TypeError);
  }
  assert.notDeepEqual(scenarioSet('train',20260911,6),scenarioSet('train',20260912,6));
  for(const args of [['unknown'],['train',-1],['test',1,0],['validation',1,1.5]])assert.throws(()=>scenarioSet(...args));
});

test('recorded and unrecorded trials agree and repeated runs retain no transient state',()=>{
  const weights=BASE_WEIGHTS.map((value,index)=>Math.min(PARAMS[index].max,value*1.2));
  for(const spec of scenarioSet('train',41,3)){
    const first=runTrial(spec,weights),again=runTrial(spec,weights),recorded=runTrial(spec,weights,{record:true});
    assert.deepEqual(first,again);
    const {samples,...result}=recorded;assert.deepEqual(first,result);
    assert.ok(samples.length>1);
    const restarted=makeRollout(spec,weights);
    assert.equal(restarted.state.time,0);assert.equal(restarted.pathLength,0);
    assert.deepEqual(Array.from(restarted.state.rates),Array(8).fill(0));
    assert.deepEqual(restarted.state.fish,{...spec.initial,speed:0,turn:0});
    assert.deepEqual(restarted.weights,weights);
  }
});

test('no-input controls remain still for every protocol even at maximum connection gains',()=>{
  const weights=PARAMS.map(parameter=>parameter.max);
  for(const source of scenarioSet('validation',9,3)){
    const spec={...source,noInput:true},result=runTrial(spec,weights,{record:true});
    assert.equal(result.reached,false);assert.equal(result.duration,30);assert.equal(result.timeCost,30);
    assert.equal(result.firstContactSeconds,null);assert.equal(result.pathLength,0);near(result.reward,-.2);
    for(const sample of result.samples){
      assert.equal(sample.x,spec.initial.x);assert.equal(sample.y,spec.initial.y);
      assert.deepEqual(sample.rates,Array(8).fill(0));
      assert.equal(sample.visible,false);
    }
  }
});

test('scoring reproduces first contact, includes misses, and uses actual travelled path',()=>{
  const rollout=makeRollout(scenario(),BASE_WEIGHTS,{record:true});
  let path=0;
  while(!rollout.finished){
    const previous={...rollout.state.fish};tickRollout(rollout);
    path+=Math.hypot(rollout.state.fish.x-previous.x,rollout.state.fish.y-previous.y);
  }
  const result=rollout.result,last=result.samples.at(-1),previous=result.samples.at(-2);
  assert.equal(result.reached,true);near(result.firstContactSeconds,7.76);near(result.timeCost,7.76);
  near(result.pathLength,path);near(result.pathLength,.4945,.0001);
  assert.ok(Math.hypot(last.x-.25,last.y-.25)<=CONTACT_RADIUS+1e-12);
  assert.ok(Math.hypot(previous.x-.25,previous.y-.25)>CONTACT_RADIUS);
  near(result.reward,1-.2*7.76/30-.02*Math.min(1,path/4.5));
  const oldTime=rollout.state.time;tickRollout(rollout);assert.equal(rollout.state.time,oldTime);
  allFinite(result);assert.deepEqual(JSON.parse(JSON.stringify(result)),result);
  assert.equal(last.t,result.duration);assert.equal(last.path,result.pathLength);
});

test('a reversal cannot count contact with the original target before its scheduled change',()=>{
  const rollout=makeRollout(scenario({protocol:'reversal',target:{x:.5,y:.35},secondTarget:{x:.8,y:.35}}));
  for(let i=0;i<200;i++)tickRollout(rollout);
  assert.equal(rollout.finished,false);assert.equal(rollout.reversed,false);near(rollout.state.time,4);
  tickRollout(rollout);assert.equal(rollout.reversed,true);
  assert.deepEqual(rollout.state.target,{x:.8,y:.35});
  while(!rollout.finished)tickRollout(rollout);
  assert.equal(rollout.result.events.filter(event=>event.kind==='stimulus').length,1);
  assert.equal(rollout.result.events.find(event=>event.kind==='stimulus').t,4);
  assert.ok(rollout.result.duration>4);
});

test('occlusion removes visual drive at 3 s and permits neural recovery at 8 s',()=>{
  const rollout=makeRollout(scenario({protocol:'occlusion'}));
  for(let i=0;i<150;i++)tickRollout(rollout);
  const before=Array.from(rollout.state.rates);
  for(let i=0;i<245;i++)tickRollout(rollout);
  assert.equal(rollout.finished,false);assert.equal(rollout.hidden,true);
  assert.equal(rollout.state.features.left,0);assert.equal(rollout.state.features.right,0);
  assert.ok(rollout.state.rates[0]+rollout.state.rates[1]<(before[0]+before[1])*.001);
  for(let i=0;i<35;i++)tickRollout(rollout);
  assert.equal(rollout.hidden,false);assert.ok(rollout.state.rates[0]+rollout.state.rates[1]>.1);
  while(!rollout.finished)tickRollout(rollout);
  assert.deepEqual(rollout.result.events.filter(event=>event.kind==='stimulus').map(event=>event.t),[3,8]);
  near(rollout.result.duration,12.72);
});

test('invalid task inputs cannot alter timing, contact or policy bounds',()=>{
  for(const overrides of [{protocol:'unknown'},{intensity:NaN},{intensity:2},{reversalAt:1},{occlusion:[1,2]},
    {initial:{x:.5,y:.75,heading:Infinity}},{target:{x:.5,y:.75}},{noInput:'yes'}]){
    assert.throws(()=>makeRollout(scenario(overrides)));
  }
  assert.equal(DT,.02);assert.equal(DURATION,30);assert.equal(CONTACT_RADIUS,.065);
});
