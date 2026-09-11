import {BASE_WEIGHTS,PARAMS,MODEL_VERSION,TASK_VERSION,REWARD_VERSION,scenarioSet,runTrial} from '../learning-demo/core.js';

export const LEARNER_VERSION='continuous-bounded-es-adam-v1';
export const DEFAULT_CONFIG=Object.freeze({seed:2026091101,trainCount:24,validationCount:48,auditCount:96,
  pairs:4,sigma:.04,learningRate:.01,auditEvery:10,minRewardGain:.0001});
export const HISTORY_LIMIT=100;
const KIND='zebrafish-continuous-learning',SCHEMA=1;
const PROTOCOLS=['reach','reversal','occlusion'];
const METRICS=['episodes','successes','successRate','meanReward','meanTimeCost','meanPathLength','meanDuration'];
const COUNTERS=['trainRollouts','validationRollouts','auditRollouts','noInputRollouts','candidateEvaluations','auditEvaluations','totalRollouts'];
const STATE_KEYS=['kind','schemaVersion','learnerVersion','modelVersion','taskVersion','rewardVersion','config','validationSeed',
  'generation','weights','championWeights','championGeneration','baselineValidation','championValidation','currentValidation',
  'lastTrain','optimizer','rng','counters','history','historyAnchor','latestAudit'];
const ROW_KEYS=['generation','trainSeed','train','validation','gate','championGeneration','championWeights','championValidationScore',
  'weights','candidateMeanReward','gradientNorm','gradient','optimizer','audit','counters'];
const ANCHOR_KEYS=['generation','weights','optimizer','championGeneration','championWeights','championValidation'];
const CASE_KEYS=['id','seed','protocol','reached','duration','timeCost','pathLength','reward'];
const clone=value=>JSON.parse(JSON.stringify(value));
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const fail=message=>{throw new TypeError(`Invalid learner state: ${message}`);};
function exact(value,keys,label){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(`${label} must be an object`);
  const actual=Object.keys(value).sort(),expected=keys.slice().sort();
  if(actual.length!==expected.length||actual.some((key,i)=>key!==expected[i]))fail(`${label} has missing or unknown fields`);
}
function finite(value,min,max,label){if(!Number.isFinite(value)||value<min||value>max)fail(`${label} is outside its bounds`);}
function integer(value,min,max,label){finite(value,min,max,label);if(!Number.isSafeInteger(value))fail(`${label} must be an integer`);}
function same(a,b){
  if(a===b)return true;
  if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
  const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&same(a[key],b[key]));
}
function weightsValid(weights,label){
  if(!Array.isArray(weights)||weights.length!==6)fail(`${label} must have six values`);
  weights.forEach((value,i)=>finite(value,PARAMS[i].min,PARAMS[i].max,`${label}[${i}]`));
}
function configValid(config){
  exact(config,Object.keys(DEFAULT_CONFIG),'config');integer(config.seed,0,0xffffffff,'seed');
  for(const key of ['trainCount','validationCount','auditCount']){
    integer(config[key],3,192,key);if(config[key]%3)fail(`${key} must balance the three protocols`);
  }
  integer(config.pairs,1,16,'pairs');integer(config.auditEvery,1,1000,'auditEvery');
  finite(config.sigma,.001,.25,'sigma');finite(config.learningRate,.0001,.1,'learningRate');
  finite(config.minRewardGain,1e-8,.1,'minRewardGain');
}
function mix(value){
  value=Math.imul(value^(value>>>16),0x21f0aaad);value=Math.imul(value^(value>>>15),0x735a2d97);
  return (value^(value>>>15))>>>0;
}
const SALTS={train:0x243f6a88,validation:0x85a308d3,audit:0x13198a2e};
/** Generation-specific manifests do not consume optimizer randomness. */
export function scenarioSeed(seed,purpose,generation){
  if(!Object.hasOwn(SALTS,purpose))fail('unknown scenario purpose');
  integer(seed,0,0xffffffff,'scenario master seed');integer(generation,0,100000000,'scenario generation');
  return mix(((seed^SALTS[purpose])+Math.imul(generation,0x9e3779b9))>>>0);
}
function casesFor(config,purpose,generation=0){
  const split=purpose==='audit'?'test':purpose;
  return scenarioSet(split,scenarioSeed(config.seed,purpose,generation),config[`${purpose}Count`]);
}
function uniform(state){
  const draw=state.rng.draws++;
  const low=draw>>>0,high=Math.floor(draw/4294967296);
  return (mix(state.rng.seed^mix(low)^mix(high+0x9e3779b9))+.5)/4294967296;
}
function normal(state){return Math.sqrt(-2*Math.log(uniform(state)))*Math.cos(2*Math.PI*uniform(state));}
function normalized(weights){return weights.map((value,i)=>(value-PARAMS[i].min)/(PARAMS[i].max-PARAMS[i].min));}
function physical(weights){return weights.map((value,i)=>PARAMS[i].min+clamp(value,0,1)*(PARAMS[i].max-PARAMS[i].min));}
function metrics(results){
  const episodes=results.length,successes=results.reduce((sum,item)=>sum+Number(item.reached),0);
  const result={episodes,successes,successRate:successes/episodes};
  for(const [key,source] of [['meanReward','reward'],['meanTimeCost','timeCost'],['meanPathLength','pathLength'],['meanDuration','duration']]){
    result[key]=results.reduce((sum,item)=>sum+item[source],0)/episodes;
  }
  return result;
}
function evaluation(results){
  return {...metrics(results),protocols:Object.fromEntries(PROTOCOLS.map(protocol=>[protocol,metrics(results.filter(item=>item.protocol===protocol))])),caseResults:results};
}
function evaluate(weights,cases){
  const results=cases.map(scenario=>{
    const result=runTrial(scenario,weights);
    return {id:scenario.id,seed:scenario.seed,protocol:scenario.protocol,reached:result.reached,
      duration:result.duration,timeCost:result.timeCost,pathLength:result.pathLength,reward:result.reward};
  });
  return evaluation(results);
}
function counted(state,weights,cases,kind){
  const result=evaluate(weights,cases);
  state.counters[kind]+=cases.length;state.counters.totalRollouts+=cases.length;
  return result;
}

/** Validation-only promotion: an incumbent success can never be traded for another task. */
export function assessPromotion(candidate,incumbent,minRewardGain){
  if(!Array.isArray(candidate?.caseResults)||!Array.isArray(incumbent?.caseResults)||candidate.caseResults.length!==incumbent.caseResults.length||
    candidate.caseResults.some((item,i)=>item.id!==incumbent.caseResults[i].id||item.protocol!==incumbent.caseResults[i].protocol))fail('promotion requires matched validation cases');
  const lostCaseIds=incumbent.caseResults.filter((item,i)=>item.reached&&!candidate.caseResults[i].reached).map(item=>item.id);
  const totalSuccessChange=candidate.successes-incumbent.successes;
  const protocolSuccessChange=Object.fromEntries(PROTOCOLS.map(protocol=>[protocol,candidate.protocols[protocol].successes-incumbent.protocols[protocol].successes]));
  const rewardGain=candidate.meanReward-incumbent.meanReward,reasons=[];
  if(lostCaseIds.length)reasons.push(`${lostCaseIds.length} previously reached validation tasks became misses.`);
  if(totalSuccessChange<0)reasons.push('Total validation successes decreased.');
  for(const protocol of PROTOCOLS)if(protocolSuccessChange[protocol]<0)reasons.push(`${protocol} validation successes decreased.`);
  if(!(rewardGain>minRewardGain))reasons.push(`Mean validation reward did not increase by more than ${minRewardGain}.`);
  return {promoted:reasons.length===0,reasons,rewardGain,lostCaseIds,totalSuccessChange,protocolSuccessChange,minRewardGain};
}
function adam(weights,optimizer,gradient,learningRate){
  const next=clone(optimizer);next.step++;
  const proposed=normalized(weights).map((value,i)=>{
    next.m[i]=.9*next.m[i]+.1*gradient[i];next.v[i]=.999*next.v[i]+.001*gradient[i]**2;
    const mHat=next.m[i]/(1-.9**next.step),vHat=next.v[i]/(1-.999**next.step);
    return clamp(value+learningRate*mHat/(Math.sqrt(vHat)+1e-8),0,1);
  });
  return {weights:physical(proposed),optimizer:next};
}
function audit(state){
  const cases=casesFor(state.config,'audit',state.generation),noInput=cases.map(item=>({...item,noInput:true}));
  const result={generation:state.generation,seed:scenarioSeed(state.config.seed,'audit',state.generation),
    championGeneration:state.championGeneration,championWeights:state.championWeights.slice(),
    baseline:counted(state,BASE_WEIGHTS,cases,'auditRollouts'),champion:counted(state,state.championWeights,cases,'auditRollouts'),
    noInput:{baseline:counted(state,BASE_WEIGHTS,noInput,'noInputRollouts'),champion:counted(state,state.championWeights,noInput,'noInputRollouts')}};
  state.counters.auditEvaluations++;state.latestAudit=result;
  return result;
}
function anchor(state){
  return {generation:state.generation,weights:state.weights.slice(),optimizer:clone(state.optimizer),
    championGeneration:state.championGeneration,championWeights:state.championWeights.slice(),championValidation:clone(state.championValidation)};
}

export function createLearner(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options))fail('options');
  for(const key of Object.keys(options))if(!Object.hasOwn(DEFAULT_CONFIG,key))fail(`unknown option ${key}`);
  const config={...DEFAULT_CONFIG,...options};configValid(config);
  const state={kind:KIND,schemaVersion:SCHEMA,learnerVersion:LEARNER_VERSION,modelVersion:MODEL_VERSION,taskVersion:TASK_VERSION,rewardVersion:REWARD_VERSION,
    config,validationSeed:scenarioSeed(config.seed,'validation',0),generation:0,weights:BASE_WEIGHTS.slice(),championWeights:BASE_WEIGHTS.slice(),championGeneration:0,
    baselineValidation:null,championValidation:null,currentValidation:null,lastTrain:null,
    optimizer:{step:0,m:Array(6).fill(0),v:Array(6).fill(0)},rng:{seed:mix(config.seed^0xa4093822),draws:0},
    counters:Object.fromEntries(COUNTERS.map(key=>[key,0])),history:[],historyAnchor:null,latestAudit:null};
  state.baselineValidation=counted(state,BASE_WEIGHTS,casesFor(config,'validation'),'validationRollouts');
  state.championValidation=clone(state.baselineValidation);state.currentValidation=clone(state.baselineValidation);
  state.historyAnchor=anchor(state);audit(state);
  return state;
}

/** One generation, committed atomically after all evaluations finish. No audit value selects weights. */
export function advanceLearner(state){
  validateState(state);if(state.generation>=100000000)fail('safe generation counter limit reached');
  const next=clone(state),generation=next.generation+1,c=next.config;
  const cases=casesFor(c,'train',generation),x=normalized(next.weights),gradient=Array(6).fill(0);
  let candidateReward=0;
  for(let pair=0;pair<c.pairs;pair++){
    const epsilon=PARAMS.map(()=>normal(next));
    const plus=physical(x.map((value,i)=>value+c.sigma*epsilon[i])),minus=physical(x.map((value,i)=>value-c.sigma*epsilon[i]));
    const positive=counted(next,plus,cases,'trainRollouts'),negative=counted(next,minus,cases,'trainRollouts');
    const difference=positive.meanReward-negative.meanReward;
    epsilon.forEach((value,i)=>{gradient[i]+=difference*value/(2*c.pairs*c.sigma);});
    candidateReward+=positive.meanReward+negative.meanReward;next.counters.candidateEvaluations+=2;
  }
  const update=adam(next.weights,next.optimizer,gradient,c.learningRate);
  next.weights=update.weights;next.optimizer=update.optimizer;next.generation=generation;
  next.lastTrain=counted(next,next.weights,cases,'trainRollouts');
  next.currentValidation=counted(next,next.weights,casesFor(c,'validation'),'validationRollouts');
  const gate=assessPromotion(next.currentValidation,next.championValidation,c.minRewardGain);
  if(gate.promoted){next.championWeights=next.weights.slice();next.championGeneration=generation;next.championValidation=clone(next.currentValidation);}
  const currentAudit=generation%c.auditEvery===0?audit(next):null;
  const row={generation,trainSeed:scenarioSeed(c.seed,'train',generation),train:clone(next.lastTrain),validation:clone(next.currentValidation),gate,
    championGeneration:next.championGeneration,championWeights:next.championWeights.slice(),championValidationScore:next.championValidation.meanReward,
    weights:next.weights.slice(),candidateMeanReward:candidateReward/(2*c.pairs),gradientNorm:Math.hypot(...gradient),gradient,
    optimizer:clone(next.optimizer),audit:currentAudit?clone(currentAudit):null,counters:clone(next.counters)};
  next.history.push(row);
  if(next.history.length>HISTORY_LIMIT){
    const removed=next.history.shift();
    next.historyAnchor={generation:removed.generation,weights:removed.weights.slice(),optimizer:clone(removed.optimizer),
      championGeneration:removed.championGeneration,championWeights:removed.championWeights.slice(),
      championValidation:clone(removed.gate.promoted?removed.validation:next.historyAnchor.championValidation)};
  }
  Object.assign(state,next);return clone(row);
}

function evaluationValid(value,cases,label){
  exact(value,[...METRICS,'protocols','caseResults'],label);
  if(!Array.isArray(value.caseResults)||value.caseResults.length!==cases.length)fail(`${label} case count`);
  value.caseResults.forEach((item,i)=>{
    exact(item,CASE_KEYS,`${label}.caseResults[${i}]`);const spec=cases[i];
    if(item.id!==spec.id||item.seed!==spec.seed||item.protocol!==spec.protocol)fail(`${label} scenario manifest mismatch`);
    if(typeof item.reached!=='boolean')fail(`${label} reached`);
    finite(item.duration,.02,30,`${label} duration`);finite(item.timeCost,.02,30,`${label} timeCost`);
    finite(item.pathLength,0,.15*item.duration+1e-8,`${label} pathLength`);finite(item.reward,-1,1,`${label} reward`);
    if(item.timeCost!==(item.reached?item.duration:30)||(!item.reached&&item.duration!==30))fail(`${label} failure cost`);
    if(item.reached&&spec.protocol==='reversal'&&item.duration<=4)fail(`${label} contact before reversal`);
    const reward=(item.reached?1:0)-.2*item.timeCost/30-.02*Math.min(1,item.pathLength/4.5);
    if(Math.abs(item.reward-reward)>1e-12)fail(`${label} reward disagrees with task facts`);
  });
  if(!same(value,evaluation(value.caseResults)))fail(`${label} aggregate metrics disagree with cases`);
}
function optimizerValid(value,generation,label){
  exact(value,['step','m','v'],label);integer(value.step,generation,generation,`${label}.step`);
  for(const key of ['m','v']){
    if(!Array.isArray(value[key])||value[key].length!==6)fail(`${label}.${key}`);
    value[key].forEach((item,i)=>finite(item,key==='v'?0:-1e6,1e6,`${label}.${key}[${i}]`));
  }
  if(!generation&&[...value.m,...value.v].some(item=>item!==0))fail('initial Adam state must be zero');
}
function countersValid(value,config,generation,label){
  exact(value,COUNTERS,label);const audits=1+Math.floor(generation/config.auditEvery);
  const expected={trainRollouts:generation*(2*config.pairs+1)*config.trainCount,
    validationRollouts:(1+generation)*config.validationCount,auditRollouts:audits*2*config.auditCount,
    noInputRollouts:audits*2*config.auditCount,candidateEvaluations:generation*2*config.pairs,auditEvaluations:audits};
  expected.totalRollouts=expected.trainRollouts+expected.validationRollouts+expected.auditRollouts+expected.noInputRollouts;
  for(const key of COUNTERS)integer(value[key],expected[key],expected[key],`${label}.${key}`);
}
function championValid(weights,generation,validation,baseline,config,cases,label){
  weightsValid(weights,`${label}.weights`);evaluationValid(validation,cases,`${label}.validation`);
  if(!generation){if(!same(weights,BASE_WEIGHTS)||!same(validation,baseline))fail(`${label} initial champion differs from baseline`);}
  else{
    const gate=assessPromotion(validation,baseline,config.minRewardGain);
    if(!gate.promoted)fail(`${label} regresses against the original baseline`);
  }
}
function auditValid(value,config,generation,label){
  exact(value,['generation','seed','championGeneration','championWeights','baseline','champion','noInput'],label);
  integer(value.generation,generation,generation,`${label}.generation`);
  if(value.seed!==scenarioSeed(config.seed,'audit',generation))fail(`${label} audit seed`);
  integer(value.championGeneration,0,generation,`${label}.championGeneration`);weightsValid(value.championWeights,`${label}.championWeights`);
  const cases=casesFor(config,'audit',generation);
  evaluationValid(value.baseline,cases,`${label}.baseline`);evaluationValid(value.champion,cases,`${label}.champion`);
  exact(value.noInput,['baseline','champion'],`${label}.noInput`);
  for(const key of ['baseline','champion']){
    evaluationValid(value.noInput[key],cases,`${label}.noInput.${key}`);
    if(value.noInput[key].caseResults.some(item=>item.reached||item.pathLength!==0))fail(`${label} no-input control moved`);
  }
  if(!generation&&(!same(value.championWeights,BASE_WEIGHTS)||value.championGeneration!==0||!same(value.baseline,value.champion)))fail(`${label} initial audit is not the baseline`);
}
function validateState(state){
  exact(state,STATE_KEYS,'checkpoint');
  if(state.kind!==KIND||state.schemaVersion!==SCHEMA||state.learnerVersion!==LEARNER_VERSION||state.modelVersion!==MODEL_VERSION||state.taskVersion!==TASK_VERSION||state.rewardVersion!==REWARD_VERSION)fail('version mismatch');
  configValid(state.config);const c=state.config,g=state.generation;
  integer(g,0,100000000,'generation');integer(state.championGeneration,0,g,'championGeneration');
  if(state.validationSeed!==scenarioSeed(c.seed,'validation',0))fail('validation seed changed');
  const validationCases=casesFor(c,'validation');evaluationValid(state.baselineValidation,validationCases,'baselineValidation');
  weightsValid(state.weights,'weights');championValid(state.championWeights,state.championGeneration,state.championValidation,state.baselineValidation,c,validationCases,'champion');
  evaluationValid(state.currentValidation,validationCases,'currentValidation');
  if(g)evaluationValid(state.lastTrain,casesFor(c,'train',g),'lastTrain');else if(state.lastTrain!==null)fail('initial lastTrain must be null');
  optimizerValid(state.optimizer,g,'optimizer');exact(state.rng,['seed','draws'],'rng');
  if(state.rng.seed!==mix(c.seed^0xa4093822))fail('optimizer RNG seed changed');
  integer(state.rng.draws,g*c.pairs*12,g*c.pairs*12,'rng.draws');countersValid(state.counters,c,g,'counters');
  if(!Array.isArray(state.history)||state.history.length!==Math.min(g,HISTORY_LIMIT))fail('bounded history length');
  const base=state.historyAnchor;exact(base,ANCHOR_KEYS,'historyAnchor');
  integer(base.generation,Math.max(0,g-HISTORY_LIMIT),Math.max(0,g-HISTORY_LIMIT),'historyAnchor.generation');
  integer(base.championGeneration,0,base.generation,'historyAnchor.championGeneration');
  optimizerValid(base.optimizer,base.generation,'historyAnchor.optimizer');weightsValid(base.weights,'historyAnchor.weights');
  championValid(base.championWeights,base.championGeneration,base.championValidation,state.baselineValidation,c,validationCases,'historyAnchor champion');
  if(!base.generation&&!same(base.weights,BASE_WEIGHTS))fail('initial history anchor weights');
  let previous=clone(base);
  for(const [index,row] of state.history.entries()){
    exact(row,ROW_KEYS,`history[${index}]`);const generation=base.generation+index+1;
    integer(row.generation,generation,generation,'history generation');
    if(row.trainSeed!==scenarioSeed(c.seed,'train',generation))fail('history training manifest');
    evaluationValid(row.train,casesFor(c,'train',generation),'history train');evaluationValid(row.validation,validationCases,'history validation');
    weightsValid(row.weights,'history weights');weightsValid(row.championWeights,'history champion weights');
    if(!Array.isArray(row.gradient)||row.gradient.length!==6)fail('history gradient');
    row.gradient.forEach(value=>finite(value,-1e6,1e6,'history gradient'));
    finite(row.gradientNorm,0,1e7,'gradientNorm');finite(row.candidateMeanReward,-1,1,'candidateMeanReward');
    if(row.gradientNorm!==Math.hypot(...row.gradient))fail('gradient norm mismatch');
    optimizerValid(row.optimizer,generation,'history optimizer');
    const update=adam(previous.weights,previous.optimizer,row.gradient,c.learningRate);
    if(!same(update.weights,row.weights)||!same(update.optimizer,row.optimizer))fail('Adam update does not match retained history');
    const gate=assessPromotion(row.validation,previous.championValidation,c.minRewardGain);
    if(!same(row.gate,gate))fail('promotion gate disagrees with validation outcomes');
    const championWeights=gate.promoted?row.weights:previous.championWeights;
    const championGeneration=gate.promoted?generation:previous.championGeneration;
    const championValidation=gate.promoted?row.validation:previous.championValidation;
    if(row.championGeneration!==championGeneration||!same(row.championWeights,championWeights)||row.championValidationScore!==championValidation.meanReward)fail('champion selection mismatch');
    countersValid(row.counters,c,generation,'history counters');
    if(generation%c.auditEvery===0){
      auditValid(row.audit,c,generation,'history audit');
      if(row.audit.championGeneration!==championGeneration||!same(row.audit.championWeights,championWeights))fail('audit checkpoint differs from selected champion');
    }else if(row.audit!==null)fail('unscheduled audit');
    previous={generation,weights:row.weights,optimizer:row.optimizer,championGeneration,championWeights,championValidation};
  }
  if(!same(state.weights,previous.weights)||!same(state.optimizer,previous.optimizer)||state.championGeneration!==previous.championGeneration||!same(state.championWeights,previous.championWeights)||!same(state.championValidation,previous.championValidation))fail('current state disagrees with history');
  const last=state.history.at(-1);
  if(!same(state.currentValidation,last?last.validation:state.baselineValidation)||!same(state.lastTrain,last?last.train:null))fail('latest evaluations disagree with history');
  const lastAuditGeneration=Math.floor(g/c.auditEvery)*c.auditEvery;
  auditValid(state.latestAudit,c,lastAuditGeneration,'latestAudit');
  const matching=state.history.find(row=>row.generation===lastAuditGeneration);
  if(matching&&!same(state.latestAudit,matching.audit))fail('latest audit disagrees with retained history');
}

/** Serialization validates consistency but does not run extra training or audit episodes. */
export function exportLearner(state){validateState(state);return clone(state);}
/** Import restores weights, optimizer and RNG exactly; transient neural state belongs to each rollout. */
export function importLearner(checkpoint){validateState(checkpoint);return clone(checkpoint);}
