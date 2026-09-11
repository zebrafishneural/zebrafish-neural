import test from 'node:test';
import assert from 'node:assert/strict';
import {BASE_WEIGHTS,PARAMS} from '../learning-demo/core.js';
import {DEFAULT_CONFIG,HISTORY_LIMIT,createLearner,advanceLearner,exportLearner,importLearner,assessPromotion,scenarioSeed} from './learner.js';

const SMALL={seed:2026091101,trainCount:3,validationCount:3,auditCount:3,pairs:1,auditEvery:2};
const clone=value=>structuredClone(value);
function gateEvaluation(hits,meanReward){
  const names=['reach','reversal','occlusion'];
  const caseResults=hits.map((reached,index)=>({id:`case-${index}`,protocol:names[index%3],reached}));
  return {successes:hits.filter(Boolean).length,meanReward,caseResults,
    protocols:Object.fromEntries(names.map(protocol=>[protocol,{successes:caseResults.filter(item=>item.protocol===protocol&&item.reached).length}]))};
}

test('initial state evaluates fixed validation and a separate audit with both no-input controls',()=>{
  assert.deepEqual([DEFAULT_CONFIG.trainCount,DEFAULT_CONFIG.validationCount,DEFAULT_CONFIG.auditCount],[24,48,96]);
  const state=createLearner(SMALL);
  assert.deepEqual(state.weights,BASE_WEIGHTS);assert.deepEqual(state.championWeights,BASE_WEIGHTS);
  assert.equal(state.championGeneration,0);assert.equal(state.generation,0);assert.equal(state.lastTrain,null);
  assert.deepEqual(state.currentValidation,state.baselineValidation);assert.deepEqual(state.championValidation,state.baselineValidation);
  assert.deepEqual(state.counters,{trainRollouts:0,validationRollouts:3,auditRollouts:6,noInputRollouts:6,candidateEvaluations:0,auditEvaluations:1,totalRollouts:15});
  assert.equal(state.latestAudit.generation,0);
  for(const name of ['baseline','champion']){
    const noInput=state.latestAudit.noInput[name];assert.equal(noInput.successes,0);
    assert.equal(noInput.meanPathLength,0);assert.equal(noInput.meanTimeCost,30);
  }
  assert.deepEqual(importLearner(exportLearner(state)),state);
});

test('training manifests change every generation while validation cases remain fixed',()=>{
  const state=createLearner(SMALL),validation=clone(state.baselineValidation.caseResults.map(item=>item.id));
  const rows=[advanceLearner(state),advanceLearner(state),advanceLearner(state)];
  assert.equal(new Set(rows.map(row=>row.trainSeed)).size,3);
  for(const row of rows){
    assert.equal(row.trainSeed,scenarioSeed(SMALL.seed,'train',row.generation));
    assert.deepEqual(row.validation.caseResults.map(item=>item.id),validation);
    assert.ok(row.train.caseResults.every(item=>item.id.startsWith('train-')));
    assert.ok(row.validation.caseResults.every(item=>item.id.startsWith('validation-')));
    assert.equal(row.train.episodes,3);
    for(const protocol of ['reach','reversal','occlusion'])assert.equal(row.validation.protocols[protocol].episodes,1);
  }
  assert.notDeepEqual(rows[0].train.caseResults.map(item=>item.id),rows[1].train.caseResults.map(item=>item.id));
  assert.equal(rows[0].audit,null);assert.equal(rows[1].audit.generation,2);assert.equal(rows[2].audit,null);
  assert.ok(rows[1].audit.baseline.caseResults.every(item=>item.id.startsWith('test-')));
  assert.notEqual(rows[1].audit.seed,scenarioSeed(SMALL.seed,'audit',0));
});

test('promotion rejects an incumbent hit becoming a miss even when totals and each protocol stay equal',()=>{
  const previous=gateEvaluation([true,true,true,false,true,true],.8);
  const exchanged=gateEvaluation([false,true,true,true,true,true],.9);
  const gate=assessPromotion(exchanged,previous,.0001);
  assert.equal(gate.totalSuccessChange,0);
  assert.deepEqual(gate.protocolSuccessChange,{reach:0,reversal:0,occlusion:0});
  assert.equal(gate.promoted,false);assert.deepEqual(gate.lostCaseIds,['case-0']);
  assert.ok(gate.reasons.some(reason=>reason.includes('previously reached')));
  const improved=gateEvaluation([true,true,true,true,true,true],.9);
  assert.equal(assessPromotion(improved,previous,.0001).promoted,true);
  const exactThreshold=assessPromotion(gateEvaluation([true,true,true],.0001),gateEvaluation([true,true,true],0),.0001);
  assert.equal(exactThreshold.promoted,false,'reward gain must strictly exceed the declared threshold');
  improved.caseResults[0].id='different-set';assert.throws(()=>assessPromotion(improved,previous,.0001),/matched validation/);
});

test('current candidates continue from learned weights while a rejected champion remains unchanged',()=>{
  const state=createLearner({...SMALL,minRewardGain:.1});
  const first=advanceLearner(state),second=advanceLearner(state);
  assert.equal(first.gate.promoted,false);assert.equal(second.gate.promoted,false);
  assert.deepEqual(state.championWeights,BASE_WEIGHTS);assert.equal(state.championGeneration,0);
  assert.notDeepEqual(first.weights,BASE_WEIGHTS);assert.notDeepEqual(second.weights,first.weights);
  assert.deepEqual(state.weights,second.weights);assert.equal(state.optimizer.step,2);
  state.weights.forEach((value,i)=>assert.ok(value>=PARAMS[i].min&&value<=PARAMS[i].max));
  assert.equal(state.rng.draws,2*SMALL.pairs*6*2);
});

test('audit frequency and audit sample count cannot influence updates or champion selection',()=>{
  const frequent=createLearner({...SMALL,auditEvery:1,auditCount:6});
  const sparse=createLearner({...SMALL,auditEvery:3,auditCount:3});
  for(let i=0;i<3;i++){
    const left=advanceLearner(frequent),right=advanceLearner(sparse);
    for(const key of ['weights','championWeights','championGeneration','optimizer','rng','currentValidation','lastTrain'])assert.deepEqual(frequent[key],sparse[key],key);
    assert.deepEqual(left.gate,right.gate);assert.deepEqual(left.gradient,right.gradient);
    assert.deepEqual(left.train,right.train);
  }
  assert.notEqual(frequent.counters.auditRollouts,sparse.counters.auditRollouts);
  assert.equal(frequent.latestAudit.generation,3);assert.equal(sparse.latestAudit.generation,3);
});

test('export/import preserves the exact future updates and does not consume extra episodes',()=>{
  const uninterrupted=createLearner(SMALL);advanceLearner(uninterrupted);
  const checkpoint=exportLearner(uninterrupted),resumed=importLearner(JSON.parse(JSON.stringify(checkpoint)));
  assert.deepEqual(resumed,uninterrupted);
  checkpoint.weights[0]=0;assert.notEqual(resumed.weights[0],0);
  for(let i=0;i<3;i++){
    assert.deepEqual(advanceLearner(resumed),advanceLearner(uninterrupted));
    assert.deepEqual(exportLearner(resumed),exportLearner(uninterrupted));
  }
  const c=resumed.counters;
  assert.equal(c.totalRollouts,c.trainRollouts+c.validationRollouts+c.auditRollouts+c.noInputRollouts);
});

test('checkpoint validation rejects inconsistent manifests, outcomes, gates, optimizer and accounting',()=>{
  const source=createLearner(SMALL);advanceLearner(source);advanceLearner(source);
  const changes=[state=>{state.schemaVersion=2;},state=>{state.extra='unknown';},state=>{state.weights[0]=NaN;},
    state=>{state.championGeneration=99;},state=>{state.counters.noInputRollouts--;},state=>{state.rng.draws++;},
    state=>{state.validationSeed++;},state=>{state.currentValidation.meanReward+=.001;},
    state=>{state.history[0].gate.promoted=!state.history[0].gate.promoted;},
    state=>{state.history[0].optimizer.m[0]+=.01;},state=>{state.optimizer.v[0]=Infinity;},
    state=>{state.history[0].train.caseResults[0].id='test-leak';},
    state=>{state.history[0].validation.caseResults[0].reward+=.1;},
    state=>{state.latestAudit.seed++;},state=>{state.latestAudit.noInput.baseline.meanPathLength=1;},
    state=>{state.historyAnchor.generation=1;},state=>{state.history.pop();}];
  for(const change of changes){const state=clone(source);change(state);assert.throws(()=>importLearner(state),/Invalid learner state/);}
  assert.deepEqual(exportLearner(source),source);
});

test('history stays bounded after 100 generations and its anchor permits exact continuation',()=>{
  const state=createLearner({...SMALL,auditEvery:1000,minRewardGain:.1});
  let generationOne;
  for(let i=0;i<=HISTORY_LIMIT;i++){
    const row=advanceLearner(state);if(i===0)generationOne=row;
  }
  assert.equal(state.generation,101);assert.equal(state.history.length,100);
  assert.equal(state.history[0].generation,2);assert.equal(state.historyAnchor.generation,1);
  assert.deepEqual(state.historyAnchor.weights,generationOne.weights);
  assert.deepEqual(state.historyAnchor.optimizer,generationOne.optimizer);
  assert.equal(state.counters.totalRollouts,15+101*12);
  const resumed=importLearner(exportLearner(state));
  assert.deepEqual(advanceLearner(resumed),advanceLearner(state));
  assert.equal(resumed.history.length,100);assert.equal(resumed.historyAnchor.generation,2);
});

test('configuration rejects unbalanced sets, unknown fields and unsafe numeric values',()=>{
  for(const options of [{trainCount:4},{validationCount:2},{auditCount:64},{pairs:0},{auditEvery:0},
    {learningRate:NaN},{sigma:0},{minRewardGain:0},{generations:12},{seed:-1}]){
    assert.throws(()=>createLearner(options),/Invalid learner state/);
  }
});
