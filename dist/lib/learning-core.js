import {makeState,renderRetina,snapshot,REGIONS,DT as BASE_DT,clamp,wrap,
  MODEL_VERSION as BASELINE_MODEL_VERSION} from './model.js';

export {BASELINE_MODEL_VERSION};
export const MODEL_VERSION='zebra-rate-trainable-0.1.0';
export const TASK_VERSION='learning-target-0.1.0';
export const REWARD_VERSION='reach-time-path-0.1.0';
export const DT=BASE_DT,DURATION=30,CONTACT_RADIUS=.065;
export const PARAMS=Object.freeze([
  {id:'visualIntegrator',label:'Visual → integrator',base:.5,min:.1,max:1.5},
  {id:'visualDrive',label:'Visual → shared drive',base:.45,min:.1,max:1.35},
  {id:'visualMotor',label:'Visual → motor',base:1,min:.25,max:2.5},
  {id:'integratorMotor',label:'Integrator → motor',base:.12,min:0,max:.5},
  {id:'sharedMotor',label:'Shared drive → motor',base:.08,min:0,max:.35},
  {id:'motorSpinal',label:'Motor → spinal drive',base:.55,min:.15,max:1.65}
].map(Object.freeze));
export const BASE_WEIGHTS=Object.freeze(PARAMS.map(parameter=>parameter.base));

const SPLITS=Object.freeze({train:0,validation:1,test:2});
const COUNTS=Object.freeze({train:24,validation:24,test:48});
const PROTOCOLS=Object.freeze(['reach','reversal','occlusion']);
const TIME_PENALTY=.2,PATH_PENALTY=.02;
const MAX_PATH=.15*DURATION;

function uint32(value,label){
  if(!Number.isSafeInteger(value)||value<0||value>0xffffffff)throw new RangeError(`${label} must be an unsigned 32-bit integer`);
  return value>>>0;
}
function mix(value){
  value=Math.imul(value^(value>>>16),0x21f0aaad);
  value=Math.imul(value^(value>>>15),0x735a2d97);
  return (value^(value>>>15))>>>0;
}
function random(seed){
  let state=seed>>>0;
  return ()=>{
    state=(state+0x6d2b79f5)>>>0;
    let value=Math.imul(state^(state>>>15),1|state);
    value^=value+Math.imul(value^(value>>>7),61|value);
    return ((value^(value>>>14))>>>0)/4294967296;
  };
}
function bounded(value,min,max,label){
  if(!Number.isFinite(value)||value<min||value>max)throw new RangeError(`${label} must be finite and in [${min}, ${max}]`);
  return value;
}
function point(value,label,initial=false){
  if(!value||typeof value!=='object')throw new TypeError(`${label} is required`);
  return Object.freeze({x:bounded(value.x,initial?.045:.1,initial?.955:.9,`${label}.x`),
    y:bounded(value.y,initial?.055:.1,initial?.945:.85,`${label}.y`)});
}
function checkedWeights(weights){
  if(!(Array.isArray(weights)||ArrayBuffer.isView(weights))||weights.length!==PARAMS.length)throw new TypeError('Expected six controller weights');
  return Object.freeze(Array.from(weights,(value,index)=>bounded(value,PARAMS[index].min,PARAMS[index].max,PARAMS[index].id)));
}
function checkedScenario(scenario){
  if(!scenario||!PROTOCOLS.includes(scenario.protocol))throw new TypeError('Unknown target protocol');
  const target=point(scenario.target,'target'),position=point(scenario.initial,'initial',true);
  const heading=bounded(scenario.initial.heading,-Math.PI,Math.PI,'initial.heading');
  if(Math.hypot(position.x-target.x,position.y-target.y)<=CONTACT_RADIUS)throw new RangeError('The initial target must be outside the contact radius');
  if(scenario.reversalAt!==undefined&&scenario.reversalAt!==4)throw new RangeError('The fixed reversal time is 4 seconds');
  if(scenario.occlusion!==undefined&&(!Array.isArray(scenario.occlusion)||scenario.occlusion.length!==2||scenario.occlusion[0]!==3||scenario.occlusion[1]!==8))throw new RangeError('The fixed occlusion interval is 3–8 seconds');
  const mirroredX=Math.abs(target.x-.5)<.01?.8:1-target.x;
  const secondTarget=point(scenario.secondTarget??{x:mirroredX,y:target.y},'secondTarget');
  if(scenario.protocol==='reversal'&&secondTarget.x===target.x&&secondTarget.y===target.y)throw new RangeError('A reversal must change the target position');
  if(scenario.noInput!==undefined&&typeof scenario.noInput!=='boolean')throw new TypeError('noInput must be a boolean');
  return Object.freeze({id:String(scenario.id??'custom'),split:scenario.split??'custom',
    seed:scenario.seed===undefined?null:uint32(scenario.seed,'scenario.seed'),index:scenario.index??null,
    protocol:scenario.protocol,target,initial:Object.freeze({...position,heading}),
    intensity:bounded(scenario.intensity,0,1,'intensity'),secondTarget,
    reversalAt:4,occlusion:Object.freeze([3,8]),noInput:scenario.noInput??false});
}

/** A deterministic prefix per split; reserved seed bits prevent overlap between splits. */
export function scenarioSet(split,seed=20260911,count=COUNTS[split]){
  if(!Object.hasOwn(SPLITS,split))throw new TypeError('Split must be train, validation or test');
  const masterSeed=uint32(seed,'seed');
  if(!Number.isSafeInteger(count)||count<1||count>4096)throw new RangeError('Scenario count must be an integer from 1 to 4096');
  return Object.freeze(Array.from({length:count},(_,index)=>{
    const low=(mix(masterSeed)+Math.imul(index+1,0x1e35a7bd))&0x3fffffff;
    const scenarioSeed=((SPLITS[split]<<30)|low)>>>0,rng=random(scenarioSeed);
    let target={x:.12+.76*rng(),y:.13+.37*rng()};
    const initial={x:.35+.3*rng(),y:.70+.15*rng(),heading:-Math.PI/2+(rng()-.5)*1.3};
    const protocol=PROTOCOLS[index%PROTOCOLS.length];
    // At the unchanged maximum speed, these trials cannot finish before input is
    // removed at 3 s. Without this constraint, an "occlusion" trial may skip it.
    if(protocol==='occlusion')while(Math.hypot(initial.x-target.x,initial.y-target.y)<=.56){
      target={x:.12+.76*rng(),y:.13+.37*rng()};
    }
    return checkedScenario({id:`${split}-${masterSeed}-${index}`,split,seed:scenarioSeed,index,
      protocol,target,initial,intensity:.55+.4*rng(),
      secondTarget:{x:Math.abs(target.x-.5)<.01?.8:1-target.x,y:target.y},
      reversalAt:4,occlusion:[3,8],noInput:false});
  }));
}

// Only these six bilateral connection gains differ from the frozen controller.
// Targets reach the policy solely through the unchanged synthetic retina encoder.
function parameterStep(state,weights){
  renderRetina(state);
  const r=state.rates,f=state.features,escape=f.threat;
  const aversive=state.config.mode==='looming';
  const go=1-.7*f.center*(1-escape);
  const drive=[f.left,f.right,weights[0]*r[0],weights[0]*r[1],weights[1]*(r[0]+r[1]),
    go*weights[2]*(aversive?1.8*r[1]:r[0])+weights[3]*(aversive?r[3]:r[2])+weights[4]*r[4],
    go*weights[2]*(aversive?1.8*r[0]:r[1])+weights[3]*(aversive?r[2]:r[3])+weights[4]*r[4],
    weights[5]*(r[5]+r[6])+.25*escape];
  for(let i=0;i<8;i++)r[i]=clamp(r[i]+DT/REGIONS[i].tau*(clamp(drive[i]+.10*r[i])-r[i]));
  const fish=state.fish;
  fish.turn=3.2*(r[6]-r[5]);
  fish.heading=wrap(fish.heading+fish.turn*DT);
  fish.speed=.15*r[7];
  const nextX=fish.x+Math.cos(fish.heading)*fish.speed*DT;
  const nextY=fish.y+Math.sin(fish.heading)*fish.speed*DT;
  if(nextX<.045||nextX>.955)fish.heading=wrap(Math.PI-fish.heading);
  if(nextY<.055||nextY>.945)fish.heading=wrap(-fish.heading);
  fish.x=clamp(nextX,.045,.955);fish.y=clamp(nextY,.055,.945);
  state.distance+=fish.speed*DT;state.time+=DT;
}

function recordSample(rollout){
  if(!rollout.record)return;
  const last=rollout.samples.at(-1),sample={...snapshot(rollout.state),
    target:{...rollout.state.target},visible:!rollout.hidden,path:rollout.pathLength};
  if(last?.t===sample.t)rollout.samples[rollout.samples.length-1]=sample;
  else rollout.samples.push(sample);
}
function log(rollout,kind,detail){
  rollout.events.push({t:+rollout.state.time.toFixed(3),kind,detail});
}
function finish(rollout,reached){
  rollout.finished=true;recordSample(rollout);
  const duration=+rollout.state.time.toFixed(3),timeCost=reached?duration:DURATION;
  const reward=(reached?1:0)-TIME_PENALTY*timeCost/DURATION-PATH_PENALTY*Math.min(1,rollout.pathLength/MAX_PATH);
  log(rollout,'result',reached?'Reached':'Timed out');
  rollout.result={id:rollout.scenario.id,seed:rollout.scenario.seed,split:rollout.scenario.split,
    protocol:rollout.scenario.protocol,reached,duration,timeCost,
    firstContactSeconds:reached?duration:null,pathLength:rollout.pathLength,reward,
    closestDistance:rollout.closestDistance,weights:Array.from(rollout.weights),
    finalState:snapshot(rollout.state),finalTarget:{...rollout.state.target},
    modelVersion:MODEL_VERSION,taskVersion:TASK_VERSION,rewardVersion:REWARD_VERSION,
    events:rollout.events.slice(),...(rollout.record?{samples:rollout.samples.slice()}:{})};
}

export function makeRollout(scenario,weights=BASE_WEIGHTS,{record=false}={}){
  const spec=checkedScenario(scenario),parameters=checkedWeights(weights);
  const state=makeState({mode:spec.noInput?'dark':'light-left',intensity:spec.intensity});
  state.target={...spec.target};Object.assign(state.fish,spec.initial);
  // Rendering the initial observation does not advance rates, position or time.
  renderRetina(state);
  const rollout={scenario:spec,weights:parameters,state,record:Boolean(record),finished:false,result:null,
    steps:0,pathLength:0,closestDistance:Math.hypot(state.fish.x-spec.target.x,state.fish.y-spec.target.y),
    hidden:spec.noInput,reversed:false,samples:[],events:[]};
  log(rollout,'start',spec.protocol);recordSample(rollout);
  return rollout;
}

/** Advance exactly one model step. The environment changes stimuli and scores contact. */
export function tickRollout(rollout){
  if(rollout.finished)return rollout;
  const {state,scenario}=rollout,t=state.time;
  if(scenario.protocol==='reversal'&&!rollout.reversed&&t>=4-1e-9){
    state.target={...scenario.secondTarget};rollout.reversed=true;
    rollout.closestDistance=Math.hypot(state.fish.x-state.target.x,state.fish.y-state.target.y);
    log(rollout,'stimulus','Target changed position');
  }
  const hidden=scenario.noInput||(scenario.protocol==='occlusion'&&t>=3-1e-9&&t<8-1e-9);
  if(hidden!==rollout.hidden){rollout.hidden=hidden;log(rollout,'stimulus',hidden?'Visual input off':'Visual input on');}
  state.config.mode=hidden?'dark':'light-left';
  const previous={x:state.fish.x,y:state.fish.y};
  parameterStep(state,rollout.weights);rollout.steps++;
  rollout.pathLength+=Math.hypot(state.fish.x-previous.x,state.fish.y-previous.y);
  const distance=Math.hypot(state.fish.x-state.target.x,state.fish.y-state.target.y);
  rollout.closestDistance=Math.min(rollout.closestDistance,distance);
  if(rollout.steps%5===0)recordSample(rollout);
  if(distance<=CONTACT_RADIUS+1e-12&&(scenario.protocol!=='reversal'||rollout.reversed))finish(rollout,true);
  else if(rollout.steps>=Math.round(DURATION/DT))finish(rollout,false);
  return rollout;
}

export function runTrial(scenario,weights=BASE_WEIGHTS,options={}){
  const rollout=makeRollout(scenario,weights,options);
  while(!rollout.finished)tickRollout(rollout);
  return rollout.result;
}
