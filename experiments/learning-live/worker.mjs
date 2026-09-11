import {parentPort, workerData} from 'node:worker_threads';
import {createLearner, advanceLearner, exportLearner, importLearner} from './learner.js';

let learner, proposed = null;
try {
  learner = workerData.checkpoint ? importLearner(workerData.checkpoint) : createLearner(workerData.config);
  parentPort.postMessage({type:'ready', learner:exportLearner(learner)});
} catch (error) {parentPort.postMessage({type:'failure', error:error.message});}
parentPort.on('message', ({command}) => {
  try {
    if (command === 'advance') {
      if (!learner || proposed) throw new Error('No committed learner is ready');
      proposed = importLearner(exportLearner(learner));
      const row = advanceLearner(proposed);
      parentPort.postMessage({type:'proposal', learner:exportLearner(proposed), row});
    } else if (command === 'commit') {
      if (!proposed) throw new Error('No proposal to commit');
      learner = proposed; proposed = null;
    } else if (command === 'discard') {proposed = null;}
  } catch (error) {parentPort.postMessage({type:'failure', error:error.message});}
});
