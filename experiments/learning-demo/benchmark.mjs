import {mkdir,writeFile} from 'node:fs/promises';
import {createTrainer,trainGeneration,evaluateFinal,exportCheckpoint,TRAINER_VERSION} from './trainer.js';
import {MODEL_VERSION,TASK_VERSION,REWARD_VERSION,PARAMS,scenarioSet,BASE_WEIGHTS} from './core.js';
import {evaluateWeights} from './trainer.js';

// Declared before evaluation. Every run is retained; no seed is selected on test performance.
const seeds=[20260911,20260912,20260913,20260914,20260915];
const settings={generations:12,pairs:4,trainCount:6,validationCount:6,testCount:32,sigma:.08,learningRate:.025};
const resultDir=new URL('./results/',import.meta.url);
await mkdir(resultDir,{recursive:true});
const runs=[];
for(const seed of seeds){
  const started=performance.now(),trainer=createTrainer({seed,...settings});
  while(trainer.generation<trainer.config.generations)trainGeneration(trainer);
  const test=evaluateFinal(trainer);
  const noInput=evaluateWeights(trainer.bestWeights,scenarioSet('test',seed,settings.testCount).map(s=>({...s,noInput:true})));
  const run={seed,bestGeneration:trainer.bestGeneration,weights:trainer.weights,bestWeights:trainer.bestWeights,test,noInput,counters:trainer.counters,seconds:(performance.now()-started)/1000};
  runs.push(run);
  await writeFile(new URL(`./checkpoint-${seed}.json`,resultDir),JSON.stringify(exportCheckpoint(trainer),null,2));
  console.log(JSON.stringify(run));
}
const report={createdAt:new Date().toISOString(),scope:'Exploratory software benchmark. Five predeclared seeds; 32 held-out tasks per run; not biological validation or a statistical claim of superiority.',versions:{model:MODEL_VERSION,task:TASK_VERSION,reward:REWARD_VERSION,trainer:TRAINER_VERSION},seeds,settings,parameters:PARAMS,baseline:BASE_WEIGHTS,runs};
await writeFile(new URL('./initial-evaluation.json',resultDir),JSON.stringify(report,null,2));

