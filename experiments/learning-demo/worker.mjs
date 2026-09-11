import {parentPort,workerData} from 'node:worker_threads';
import {createTrainer,trainGeneration,evaluateFinal,exportCheckpoint,importCheckpoint} from './trainer.js';

let trainer,status='idle',error=null,running=false,epoch=0;
function publish(id=null){
  parentPort.postMessage({type:'state',id,status,trainer,checkpoint:exportCheckpoint(trainer),evaluation:trainer.lastTest?{...trainer.lastTest,trained:trainer.lastTest.best}:null,error});
}
function fail(id,err){error=err.message;parentPort.postMessage({type:'failure',id,error});}
function pump(token){
  if(!running||token!==epoch)return;
  try{
    trainGeneration(trainer);
    if(trainer.generation>=trainer.config.generations){running=false;status='complete';}
    publish();
    if(running)setImmediate(()=>pump(token));
  }catch(err){running=false;status='error';error=err.message;publish();}
}
try{
  trainer=workerData?.checkpoint?importCheckpoint(workerData.checkpoint):createTrainer({seed:20260911});
  status=trainer.evaluated||trainer.generation>=trainer.config.generations?'complete':trainer.generation?'paused':'idle';
  publish();
}catch(err){parentPort.postMessage({type:'fatal',error:err.message});}

parentPort.on('message',({id,command,body={}})=>{
  try{
    if(!trainer&&command!=='reset')throw Error('The saved checkpoint could not be loaded. Reset this isolated demo to start a new run.');
    if(command==='train'){
      if(running){publish(id);return;}
      if(trainer.evaluated)throw Error('This run has been evaluated. Reset with a new seed to start another run.');
      if(trainer.generation===0&&Object.keys(body).length)trainer=createTrainer(body);
      else if((body.seed!==undefined&&body.seed!==trainer.config.seed)||(body.generations!==undefined&&body.generations!==trainer.config.generations))throw Error('Reset the demo before changing the training configuration.');
      if(trainer.generation>=trainer.config.generations)throw Error('Training is complete. Evaluate this run or reset with a new seed.');
      error=null;running=true;status='training';const token=++epoch;publish(id);setImmediate(()=>pump(token));
    }else if(command==='pause'){
      running=false;epoch++;status=trainer.evaluated||trainer.generation>=trainer.config.generations?'complete':'paused';publish(id);
    }else if(command==='evaluate'){
      if(running)throw Error('Pause training before evaluating the held-out test.');
      evaluateFinal(trainer);status='complete';error=null;publish(id);
    }else if(command==='reset'){
      if(running)throw Error('Pause training before resetting this demo.');
      if(trainer?.evaluated&&body.seed===trainer.config.seed)throw Error('Choose a new seed after final evaluation.');
      trainer=createTrainer({seed:body.seed??20260911,...body});status='idle';error=null;publish(id);
    }else if(command==='restore'){
      if(running)throw Error('Pause training before importing a checkpoint.');
      const imported=importCheckpoint(body);
      trainer=imported;status=trainer.evaluated||trainer.generation>=trainer.config.generations?'complete':trainer.generation?'paused':'idle';error=null;publish(id);
    }else throw Error('Unknown worker command.');
  }catch(err){fail(id,err);}
});
