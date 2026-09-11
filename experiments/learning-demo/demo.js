import {BrainView} from '/baseline/lib/brain-view.js';
import {REGIONS} from '/baseline/lib/model.js';
import {BASE_WEIGHTS,PARAMS,MODEL_VERSION,TASK_VERSION,REWARD_VERSION,DT,DURATION,CONTACT_RADIUS,scenarioSet,makeRollout,tickRollout} from './core.js';

const $=id=>document.getElementById(id);
const number=(value,digits=3)=>Number.isFinite(value)?value.toFixed(digits):'—';
const count=value=>Number.isFinite(value)?value.toLocaleString('en-US'):'—';
const percentage=value=>Number.isFinite(value)?`${(value*100).toFixed(1)}%`:'—';
const labelProtocol={reach:'Target reaching',reversal:'Target reversal',occlusion:'Input occlusion'};
const initialSeed=20260911;
let serverState={status:'idle',trainer:null,evaluation:null};
let requestBusy=false,pollTimer=null,polling=false,pauseRequested=false,lastFetchFailed=false;
let selectedWeights=[...BASE_WEIGHTS],replayWeights=[...BASE_WEIGHTS],replayGeneration=0;
let scenarios=[],baselineRollout,selectedRollout,replayPaused=false,replayAccumulator=0,lastFrame=performance.now();
let scenarioSeed=initialSeed,scenarioCount=24,historySignature='',checkpointSignature='';
const brain=new BrainView($('brain'));
const retinaScratch=document.createElement('canvas');
retinaScratch.width=32;retinaScratch.height=16;
const retinaScratchContext=retinaScratch.getContext('2d');
const retinaContext=$('live-retina').getContext('2d');
const rateRows=REGIONS.map(region=>{
  const row=document.createElement('div');row.className='live-rate';
  const name=document.createElement('span');name.textContent=region.name;
  const value=document.createElement('output');value.textContent='0.000';
  const meter=document.createElement('div');meter.className='live-rate-meter';
  const bar=document.createElement('i');meter.append(bar);row.append(name,value,meter);$('live-rates').append(row);
  return {value,bar};
});
$('version-label').textContent=`${MODEL_VERSION} · ${TASK_VERSION}`;

function showError(error){$('api-error').hidden=false;$('api-error').textContent=error instanceof Error?error.message:String(error);}
function clearError(){$('api-error').hidden=true;$('api-error').textContent='';}
async function request(path,body){
  const response=await fetch(path,{cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
  const raw=await response.text();let data;
  try{data=raw?JSON.parse(raw):{};}catch{throw Error(`The local server returned an unreadable response (${response.status}).`);}
  if(!response.ok)throw Error(data.error||data.message||`The local server returned HTTP ${response.status}.`);
  return data;
}
function stopPolling(){clearTimeout(pollTimer);pollTimer=null;}
function schedulePoll(){
  stopPolling();
  if(lastFetchFailed)pollTimer=setTimeout(refreshStatus,2500);
  else if(serverState.status==='starting')pollTimer=setTimeout(refreshStatus,500);
  else if(serverState.status==='training')pollTimer=setTimeout(refreshStatus,1000);
}
async function refreshStatus(){
  if(polling)return;polling=true;
  try{const data=await request('/api/status');clearError();applyStatus(data);lastFetchFailed=false;}catch(error){lastFetchFailed=true;showError(error);$('training-status').textContent='Connection interrupted';$('training-detail').textContent='The display retains the last received state. Training may still be running on the local server.';}
  finally{polling=false;schedulePoll();}
}
async function mutate(path,body={}){
  if(requestBusy)return;
  requestBusy=true;updateButtons();
  try{clearError();await request(path,body);await refreshStatus();}
  catch(error){if(path==='/api/pause')pauseRequested=false;showError(error);if(error instanceof TypeError){lastFetchFailed=true;schedulePoll();}}
  finally{requestBusy=false;updateButtons();}
}
function trainer(){return serverState.trainer||null;}
function isEvaluated(){return Boolean(trainer()?.evaluated||serverState.evaluation||trainer()?.lastTest);}
function updateButtons(){
  const running=serverState.status==='training',evaluated=isEvaluated(),hasTraining=(trainer()?.generation||0)>0;
  const budgetComplete=Boolean(trainer()&&trainer().generation>=trainer().config.generations);
  $('start-training').disabled=requestBusy||running||evaluated||budgetComplete;
  $('start-training').textContent=hasTraining?'Continue training':'Start training';
  if(budgetComplete)$('start-training').textContent='Training complete';
  $('pause-training').disabled=requestBusy||!running||pauseRequested;
  $('pause-training').textContent=pauseRequested?'Pause requested':'Pause after generation';
  $('evaluate').disabled=requestBusy||running||!hasTraining||evaluated;
  $('evaluate').textContent=evaluated?'Test evaluated · frozen':'Evaluate unseen test';
  $('reset-training').disabled=requestBusy||running;
  $('import-checkpoint').disabled=requestBusy||running;
  $('export-checkpoint').disabled=requestBusy||!trainer();
  $('seed').disabled=requestBusy||running;
  $('generations').disabled=requestBusy||running||hasTraining||evaluated;
}
function applyStatus(data){
  if(!data||typeof data!=='object')throw Error('Missing local training status.');
  const priorSeed=trainer()?.config?.seed,priorStatus=serverState.status;
  serverState={...data,trainer:data.trainer||null};
  const state=trainer(),generation=state?.generation||0,history=Array.isArray(state?.history)?state.history:[];
  const trained=generation>0;
  selectedWeights=Array.isArray(state?.bestWeights)&&state.bestWeights.length===PARAMS.length?[...state.bestWeights]:[...BASE_WEIGHTS];
  const counters=state?.counters||{};
  $('generation').textContent=`${generation}${state?.config?.generations?` / ${state.config.generations}`:''}`;
  $('train-episodes').textContent=count(counters.trainRollouts??0);
  $('validation-episodes').textContent=count(counters.validationRollouts??0);
  $('selected-generation').textContent=trained?`${state.bestGeneration??0}${state.bestGeneration===0?' (baseline)':''}`:'Not trained';
  $('best-validation').textContent=number(state?.bestValidation?.meanReward??state?.bestValidationScore);
  if(serverState.status!=='training')pauseRequested=false;
  const statuses={idle:trained?'Ready':'Not trained',training:'Training',paused:'Paused',complete:'Training complete',error:'Training error'};
  $('training-status').textContent=isEvaluated()?'Final test complete':statuses[serverState.status]||serverState.status;
  $('training-status').dataset.live=String(serverState.status==='training');
  $('training-detail').textContent=isEvaluated()?'This run is frozen after held-out evaluation. Reset with a new seed for a new run.':
    serverState.status==='training'?'Computing actual trial outcomes. Updates arrive after each completed generation.':
    serverState.status==='paused'?'Paused between generations. The selected checkpoint is retained.':
    trained?'Parameters were selected using validation reward. The final test remains separate.':'Both replay panels currently use the original parameters.';
  $('training-guidance').textContent=isEvaluated()?'Held-out evaluation freezes this run. Reset starts a new seed; you can enter one above.':
    trained?'Continue keeps this run’s configuration. To change the seed, enter it above and use Reset this training.':
    'Training adjusts parameters using training episodes. Validation selects a checkpoint. The final test is kept separate.';
  if(state?.config){
    if(document.activeElement!==$('seed')&&(priorSeed!==state.config.seed||serverState.status==='training'))$('seed').value=state.config.seed;
    if(document.activeElement!==$('generations')&&state.config.generations)$('generations').value=state.config.generations;
  }
  const nextSeed=state?.config?.seed??initialSeed,nextCount=state?.config?.trainCount??24;
  if(nextSeed!==scenarioSeed||nextCount!==scenarioCount){scenarioSeed=nextSeed;scenarioCount=nextCount;populateScenarios();restartReplay();}
  const nextCheckpoint=JSON.stringify({seed:scenarioSeed,generation:state?.bestGeneration??0,weights:selectedWeights});
  if(nextCheckpoint!==checkpointSignature){
    checkpointSignature=nextCheckpoint;
    renderParameters();
    // Keep an in-progress replay internally consistent; apply a new checkpoint on Replay.
    if(!baselineRollout||(baselineRollout.finished&&selectedRollout.finished)||(!trained&&generation===0))restartReplay();
    else if(JSON.stringify(replayWeights)!==JSON.stringify(selectedWeights))$('replay-generation').textContent=`Replay: generation ${replayGeneration} · newer checkpoint available`;
  }
  if(priorStatus==='training'&&serverState.status!=='training')restartReplay();
  else if(trained&&JSON.stringify(replayWeights)===JSON.stringify(selectedWeights)){
    $('selected-title').textContent='Selected parameters';
    $('replay-generation').textContent=`Selected checkpoint: generation ${replayGeneration}`;
  }
  const nextHistorySignature=JSON.stringify(history);
  if(nextHistorySignature!==historySignature){historySignature=nextHistorySignature;renderHistory(history);}
  const last=history.at(-1);
  $('latest-train').textContent=formatMetricLine(state?.lastTrain||last?.train);
  $('latest-validation').textContent=formatMetricLine(state?.lastValidation||last?.validation);
  renderEvaluation(serverState.evaluation||state?.lastTest);
  updateButtons();
  if(data.error)showError(data.error);
}
function formatMetricLine(metric){return metric?`${percentage(metric.successRate)} reached · ${number(metric.meanReward)} reward`:'—';}

function populateScenarios(){
  const prior=$('scenario').value;
  scenarios=scenarioSet('train',scenarioSeed,scenarioCount);
  const filtered=scenarios.filter(s=>s.protocol===$('protocol').value);
  $('scenario').replaceChildren(...filtered.map(s=>{const option=document.createElement('option');option.value=s.id;option.textContent=`Training case ${s.index+1}`;return option;}));
  if(filtered.some(s=>s.id===prior))$('scenario').value=prior;
}
function restartReplay(){
  const scenario=scenarios.find(s=>s.id===$('scenario').value)||scenarios.find(s=>s.protocol===$('protocol').value)||scenarios[0];
  if(!scenario)return;
  replayWeights=[...selectedWeights];replayGeneration=trainer()?.bestGeneration??0;
  baselineRollout=makeRollout(scenario,BASE_WEIGHTS,{record:true});
  selectedRollout=makeRollout(scenario,replayWeights,{record:true});
  replayAccumulator=0;lastFrame=performance.now();replayPaused=false;
  $('pause-replay').textContent='Pause replay';
  $('replay-source').textContent=`${labelProtocol[scenario.protocol]} · training case ${scenario.index+1}`;
  const trained=(trainer()?.generation||0)>0;
  $('replay-generation').textContent=trained?`Selected checkpoint: generation ${replayGeneration}`:'Not trained · baseline values';
  $('selected-title').textContent=trained?'Selected parameters':'Not trained · original values';
  $('replay-note').textContent=`Same starting pose and task. Intensity ${number(scenario.intensity,2)} · ${DURATION} model-second limit.`;
  renderReplay();
}
function renderParameters(){
  $('parameter-rows').replaceChildren(...PARAMS.map((parameter,index)=>{
    const row=document.createElement('tr');
    [parameter.label,number(parameter.base),number(selectedWeights[index]),`${number(parameter.min,2)}–${number(parameter.max,2)}`].forEach((value,column)=>{
      const cell=document.createElement('td');cell.textContent=value;
      if(column===2&&Math.abs(selectedWeights[index]-parameter.base)>1e-9)cell.className='parameter-changed';
      row.append(cell);
    });return row;
  }));
}
function renderHistory(history){
  $('history-count').textContent=`${history.length} RECORDED POINT${history.length===1?'':'S'}`;
  const records=history.filter(point=>Number.isFinite(point.generation));
  $('history-note').textContent=records.length?'Each point is a completed evaluation. Higher reward is better; it combines contact, elapsed time and path length.':'No completed generations yet. No result is assumed.';
  if(!records.length){const row=document.createElement('tr');const cell=document.createElement('td');cell.colSpan=6;cell.textContent='No completed generations.';row.append(cell);$('history-rows').replaceChildren(row);}
  else $('history-rows').replaceChildren(...records.map(point=>{
    const row=document.createElement('tr');
    [point.generation,number(point.train?.meanReward),point.train?`${point.train.successes} / ${point.train.episodes}`:'—',number(point.validation?.meanReward),point.validation?`${point.validation.successes} / ${point.validation.episodes}`:'—',point.generation===trainer()?.bestGeneration?'Current selection':point.improved?'Selected at this step':'—'].forEach((value,index)=>{const cell=document.createElement('td');cell.textContent=String(value);if(index===5&&point.generation===trainer()?.bestGeneration)cell.className='selected-tag';row.append(cell);});return row;
  }));
  drawHistory(records);
}
function drawHistory(history){
  const canvas=$('history-chart'),c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  c.clearRect(0,0,w,h);c.fillStyle='#f8f9fa';c.fillRect(0,0,w,h);
  const l=51,r=w-18,t=20,b=h-37;
  c.font='12px monospace';c.textBaseline='middle';
  const y=value=>b-(value+.25)/1.25*(b-t);
  for(const value of [-.25,0,.5,1]){c.strokeStyle='#dbe1e4';c.lineWidth=1;c.beginPath();c.moveTo(l,y(value));c.lineTo(r,y(value));c.stroke();c.fillStyle='#6b7b84';c.textAlign='right';c.fillText(value.toFixed(2),l-9,y(value));}
  if(!history.length){c.fillStyle='#687781';c.textAlign='center';c.fillText('No completed generations',w/2,h/2);return;}
  const max=Math.max(1,...history.map(row=>row.generation));
  const x=g=>l+g/max*(r-l);
  for(const [key,color]of [['train','#126958'],['validation','#bf853b']]){
    const points=history.filter(row=>Number.isFinite(row[key]?.meanReward));
    c.strokeStyle=color;c.fillStyle=color;c.lineWidth=2;c.beginPath();
    points.forEach((row,index)=>{const px=x(row.generation),py=y(row[key].meanReward);if(index)c.lineTo(px,py);else c.moveTo(px,py);});c.stroke();
    for(const row of points){c.beginPath();c.arc(x(row.generation),y(row[key].meanReward),3.1,0,Math.PI*2);c.fill();}
  }
  c.fillStyle='#6b7b84';c.textBaseline='top';c.textAlign='left';c.fillText('0',l,b+12);c.textAlign='right';c.fillText(String(max),r,b+12);c.textAlign='center';c.fillText('Generation',(l+r)/2,b+12);
}
function renderEvaluation(evaluation){
  const original=evaluation?.baseline,selected=evaluation?.trained||evaluation?.best;
  const rows=[['Original parameters',original],['Selected parameters',selected]];
  $('evaluation-rows').replaceChildren(...rows.map(([label,metric])=>{
    const row=document.createElement('tr');
    [label,metric?`${metric.successes} / ${metric.episodes}`:'—',percentage(metric?.successRate),Number.isFinite(metric?.meanTimeCost)?`${number(metric.meanTimeCost,2)} s`:'—',number(metric?.meanPathLength),number(metric?.meanReward)].forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});return row;
  }));
  $('test-state').textContent=original&&selected?'HELD-OUT TEST · RUN FROZEN':'NOT EVALUATED';
  $('evaluation-note').textContent=original&&selected?
    `Both controllers were evaluated on the same ${original.episodes} held-out scenarios. This run is now frozen. These results have not been used to select another checkpoint.`:
    'Run the final test after training. Both controllers are evaluated on the same held-out scenarios. Evaluating freezes this training run so the test cannot be used to keep selecting parameters.';
}
async function loadRecordedEvaluation(){
  try{
    const report=await request('/results/initial-evaluation.json');
    if(!Array.isArray(report.runs)||!report.runs.length)throw Error('The recorded evaluation contains no runs.');
    const totals={baselineHits:0,selectedHits:0,baselineEpisodes:0,selectedEpisodes:0,baselineTime:0,selectedTime:0};
    const rows=report.runs.map(run=>{
      const baseline=run.test?.baseline,selected=run.test?.best;
      if(!baseline||!selected)throw Error('A recorded run is missing its baseline or selected result.');
      totals.baselineHits+=baseline.successes;totals.selectedHits+=selected.successes;
      totals.baselineEpisodes+=baseline.episodes;totals.selectedEpisodes+=selected.episodes;
      totals.baselineTime+=baseline.meanTimeCost*baseline.episodes;totals.selectedTime+=selected.meanTimeCost*selected.episodes;
      const row=document.createElement('tr');
      [String(run.seed),`${baseline.successes} / ${baseline.episodes}`,`${selected.successes} / ${selected.episodes}`,`${number(baseline.meanTimeCost,3)} s`,`${number(selected.meanTimeCost,3)} s`].forEach(value=>{const cell=document.createElement('td');cell.textContent=value;row.append(cell);});return row;
    });
    $('recorded-rows').replaceChildren(...rows);
    const difference=totals.selectedHits<totals.baselineHits?'The selected parameters reached fewer targets in this recorded set.':totals.selectedHits===totals.baselineHits?'Both reached the same total number of targets in this recorded set.':'The selected parameters reached more targets in this recorded set.';
    $('recorded-summary').textContent=`Across ${report.runs.length} seeds: original ${totals.baselineHits}/${totals.baselineEpisodes} reached; selected ${totals.selectedHits}/${totals.selectedEpisodes}. Mean time including failures: ${number(totals.baselineTime/totals.baselineEpisodes,3)} s versus ${number(totals.selectedTime/totals.selectedEpisodes,3)} s. ${difference}`;
    $('recorded-scope').textContent=report.scope||'Exploratory software evaluation; no claim of statistical superiority or biological validation.';
  }catch(error){
    const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=5;cell.textContent='Recorded evaluation unavailable.';row.append(cell);$('recorded-rows').replaceChildren(row);
    $('recorded-summary').textContent=error.message;
  }
}
function drawArena(canvas,rollout,color){
  const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height,s=rollout.state;
  c.clearRect(0,0,w,h);c.fillStyle='#101c24';c.fillRect(0,0,w,h);
  c.lineWidth=1;c.strokeStyle='#20313b';
  for(let i=1;i<10;i++){c.beginPath();c.moveTo(i*w/10,0);c.lineTo(i*w/10,h);c.stroke();c.beginPath();c.moveTo(0,i*h/10);c.lineTo(w,i*h/10);c.stroke();}
  c.strokeStyle='#35505d';c.strokeRect(.045*w,.055*h,.91*w,.89*h);
  const points=rollout.samples;
  c.strokeStyle=color+'99';c.lineWidth=2;c.beginPath();
  points.forEach((point,index)=>{if(index)c.lineTo(point.x*w,point.y*h);else c.moveTo(point.x*w,point.y*h);});
  c.lineTo(s.fish.x*w,s.fish.y*h);c.stroke();
  const target=s.target;
  c.save();c.strokeStyle=rollout.hidden?'#7b8b94':'#e4c678';c.fillStyle=rollout.hidden?'#74818b0d':'#e4c67813';c.lineWidth=1.5;
  if(rollout.hidden)c.setLineDash([5,4]);
  c.beginPath();c.ellipse(target.x*w,target.y*h,CONTACT_RADIUS*w,CONTACT_RADIUS*h,0,0,Math.PI*2);c.fill();c.stroke();
  c.setLineDash([]);c.fillStyle=rollout.hidden?'#7b8b94':'#e4c678';c.beginPath();c.arc(target.x*w,target.y*h,5,0,Math.PI*2);c.fill();c.restore();
  c.save();c.translate(s.fish.x*w,s.fish.y*h);c.rotate(s.fish.heading);c.strokeStyle=color;c.lineWidth=2;
  c.beginPath();c.arc(0,0,10,0,Math.PI*2);c.stroke();c.fillStyle=color;c.beginPath();c.moveTo(18,0);c.lineTo(4,-5);c.lineTo(4,5);c.closePath();c.fill();c.restore();
  c.fillStyle='#9bb0bc';c.font='12px monospace';c.textAlign='left';c.fillText(rollout.hidden?'VISUAL INPUT OFF':'VISUAL INPUT ON',18,h-15);
  if(rollout.reversed){c.textAlign='right';c.fillText('TARGET REVERSED',w-18,h-15);}
}
function renderReplay(){
  if(!selectedRollout)return;
  drawArena($('baseline-arena'),baselineRollout,'#9aaebb');drawArena($('selected-arena'),selectedRollout,'#8bd1ba');
  for(const [prefix,rollout]of [['baseline',baselineRollout],['selected',selectedRollout]]){
    $(`${prefix}-time`).textContent=`${number(rollout.state.time,2)} s`;
    $(`${prefix}-result`).textContent=rollout.finished?(rollout.result.reached?'Reached':'Timed out'):replayPaused?'Paused':'Running';
    $(`${prefix}-path`).textContent=`Path ${number(rollout.pathLength)}`;
  }
  const s=selectedRollout.state;
  brain.setRates(s.rates);
  rateRows.forEach((row,index)=>{row.value.textContent=number(s.rates[index]);row.bar.style.width=`${s.rates[index]*100}%`;});
  const pixels=retinaScratchContext.createImageData(32,16);
  s.retina.forEach((value,index)=>{const gray=Math.round(Math.max(0,Math.min(1,value))*255);pixels.data[index*4]=gray;pixels.data[index*4+1]=gray;pixels.data[index*4+2]=gray;pixels.data[index*4+3]=255;});
  retinaScratchContext.putImageData(pixels,0,0);retinaContext.imageSmoothingEnabled=false;retinaContext.drawImage(retinaScratch,0,0,320,160);
  $('visual-left').textContent=number(s.features.left);$('visual-right').textContent=number(s.features.right);
  $('input-description').textContent=selectedRollout.hidden?'Visual contrast is currently off. The remaining activity and movement come from the controller’s existing state.':'A Gaussian target stimulus is generated from this controller’s bearing and distance. It is not a screenshot of the arena.';
}
function frame(now){
  const elapsed=Math.min(.1,Math.max(0,(now-lastFrame)/1000));lastFrame=now;
  if(!document.hidden&&!replayPaused&&baselineRollout&&(!baselineRollout.finished||!selectedRollout.finished)){
    replayAccumulator+=elapsed*Number($('replay-speed').value);
    let steps=0;
    while(replayAccumulator>=DT&&steps<32){if(!baselineRollout.finished)tickRollout(baselineRollout);if(!selectedRollout.finished)tickRollout(selectedRollout);replayAccumulator-=DT;steps++;}
    renderReplay();
  }
  requestAnimationFrame(frame);
}

$('start-training').addEventListener('click',()=>{
  const continuing=(trainer()?.generation||0)>0;
  const seed=continuing?trainer().config.seed:Number($('seed').value),generations=continuing?trainer().config.generations:Number($('generations').value);
  if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff||!Number.isSafeInteger(generations)||generations<1||generations>200){showError('Enter an unsigned integer seed and a generation count from 1 to 200.');return;}
  mutate('/api/train',{seed,generations});
});
$('pause-training').addEventListener('click',async()=>{pauseRequested=true;await mutate('/api/pause',{});});
$('evaluate').addEventListener('click',()=>mutate('/api/evaluate',{}));
$('reset-training').addEventListener('click',async()=>{
  let seed=Number($('seed').value);
  if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff){showError('Enter an unsigned integer seed before resetting.');return;}
  if(isEvaluated()&&seed===trainer()?.config?.seed){seed=(seed+1)>>>0;$('seed').value=seed;}
  await mutate('/api/reset',{seed});
  if(!trainer()?.generation){checkpointSignature='';selectedWeights=[...BASE_WEIGHTS];renderParameters();restartReplay();}
});
$('export-checkpoint').addEventListener('click',async()=>{
  try{const checkpoint=await request('/api/checkpoint');const blob=new Blob([JSON.stringify(checkpoint,null,2)+'\n'],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`zebrafish-learning-${trainer()?.config?.seed??initialSeed}-generation-${trainer()?.generation??0}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){showError(error);}
});
$('import-checkpoint').addEventListener('click',()=>$('checkpoint-file').click());
$('checkpoint-file').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  try{if(file.size>512*1024)throw Error('This checkpoint is too large; the demo accepts files up to 512 KB.');const checkpoint=JSON.parse(await file.text());await mutate('/api/checkpoint',checkpoint);restartReplay();}catch(error){showError(error);}finally{event.target.value='';}
});
$('protocol').addEventListener('change',()=>{populateScenarios();restartReplay();});
$('scenario').addEventListener('change',restartReplay);
$('replay').addEventListener('click',restartReplay);
$('pause-replay').addEventListener('click',()=>{replayPaused=!replayPaused;$('pause-replay').textContent=replayPaused?'Resume replay':'Pause replay';renderReplay();});
$('replay-speed').addEventListener('change',()=>{replayAccumulator=0;lastFrame=performance.now();});
$('reset-view').addEventListener('click',()=>brain.reset());
document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();replayAccumulator=0;});
window.addEventListener('pagehide',stopPolling);
populateScenarios();renderParameters();renderHistory([]);restartReplay();
refreshStatus();loadRecordedEvaluation();requestAnimationFrame(frame);
