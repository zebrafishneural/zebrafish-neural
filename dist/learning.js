import {BrainView} from './lib/brain-view.js';
import {REGIONS} from './lib/model.js';
import {BASE_WEIGHTS,PARAMS,MODEL_VERSION,TASK_VERSION,DT,DURATION,CONTACT_RADIUS,scenarioSet,makeRollout,tickRollout} from './lib/learning-core.js';

const $=id=>document.getElementById(id);
const number=(value,digits=3)=>Number.isFinite(value)?value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits}):'—';
const count=value=>Number.isFinite(value)?value.toLocaleString('en-US'):'—';
const percentage=value=>Number.isFinite(value)?`${number(value*100,1)}%`:'—';
const clockFormatter=new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC'});
const dateFormatter=new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'medium',timeZone:'UTC'});
const dateValid=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
const clock=value=>dateValid(value)?`${clockFormatter.format(new Date(value))} UTC`:'—';
const fullDate=value=>dateValid(value)?`${dateFormatter.format(new Date(value))} UTC`:'—';
const protocolLabels={reach:'Target reaching',reversal:'Target reversal',occlusion:'Input occlusion'};
let apiOrigin=location.origin,lastSnapshot=null,requestInFlight=false,pollTimer=null;
let replaySeed=20260911,replayCount=24,replayScenarios=[],replayPaused=false,replayAccumulator=0,lastFrame=performance.now();
let baselineRollout=null,championRollout=null,championWeights=[...BASE_WEIGHTS],activeWeights=[...BASE_WEIGHTS],activeGeneration=0;
let historySignature='',championSignature='',scenarioSignature='';
const brain=new BrainView($('brain'));
const retinaScratch=document.createElement('canvas');retinaScratch.width=32;retinaScratch.height=16;
const retinaScratchContext=retinaScratch.getContext('2d'),retinaContext=$('live-retina').getContext('2d');
const rateRows=REGIONS.map(region=>{
  const row=document.createElement('div');row.className='live-rate';const name=document.createElement('span');name.textContent=region.name;
  const value=document.createElement('output');value.textContent='—';const meter=document.createElement('div');meter.className='live-rate-meter';const bar=document.createElement('i');meter.append(bar);row.append(name,value,meter);$('live-rates').append(row);return {value,bar};
});
$('model-version').textContent=`${MODEL_VERSION} · ${TASK_VERSION}`;

function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;}
function apiURL(path){return new URL(path,apiOrigin).href;}
async function fetchJSON(url,{optional=false}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(url,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
    if(optional&&response.status===404)return null;
    if(!response.ok)throw Error(`The learning server returned HTTP ${response.status}.`);
    if(!(response.headers.get('content-type')||'').includes('application/json'))throw Error('The learning server did not return a JSON snapshot.');
    return await response.json();
  }finally{clearTimeout(timer);}
}
async function configure(){
  const config=await fetchJSON(new URL('/learning-config.json',location.origin).href,{optional:true});
  if(config===null||config.endpoint===undefined||config.endpoint==='')return;
  if(typeof config.endpoint!=='string')throw Error('The learning endpoint configuration is invalid.');
  const url=new URL(config.endpoint,location.origin);
  if(url.username||url.password||url.search||url.hash||!['https:','http:'].includes(url.protocol)||(url.origin!==location.origin&&url.protocol!=='https:'))throw Error('The configured learning endpoint must be a secure origin.');
  if(url.pathname!=='/'&&url.pathname!=='')throw Error('The learning endpoint must be an origin without a path.');
  apiOrigin=url.origin;
}
function validMetrics(metric){
  if(!metric||typeof metric!=='object')return false;
  return ['episodes','successes','successRate','meanReward','meanTimeCost','meanPathLength'].every(key=>Number.isFinite(metric[key]))&&metric.episodes>0&&metric.successes>=0&&metric.successes<=metric.episodes&&metric.successRate>=0&&metric.successRate<=1;
}
function validateSnapshot(data){
  if(!data||data.schemaVersion!==1||!['starting','training','waiting','paused','error'].includes(data.status)||!dateValid(data.serverAt))throw Error('The learning snapshot has an unsupported format.');
  if(data.learner===null||data.learner===undefined){if(data.status==='starting'||data.status==='error')return data;throw Error('The snapshot contains no learner state.');}
  const state=data.learner;
  if(!Number.isInteger(state.generation)||state.generation<0||!Number.isInteger(state.championGeneration)||state.championGeneration<0||state.championGeneration>state.generation)throw Error('The snapshot has invalid generation counters.');
  if(!Array.isArray(state.championWeights)||state.championWeights.length!==PARAMS.length||state.championWeights.some((value,index)=>!Number.isFinite(value)||value<PARAMS[index].min||value>PARAMS[index].max))throw Error('The snapshot contains invalid retained parameters.');
  if(!Array.isArray(state.history)||state.history.some(row=>!Number.isInteger(row.generation)||!validMetrics(row.validation)||!Number.isFinite(row.championValidationScore)))throw Error('The evaluation history is invalid.');
  for(const name of ['baselineValidation','championValidation','currentValidation'])if(state[name]!==null&&!validMetrics(state[name]))throw Error('The snapshot contains an invalid validation result.');
  if(state.latestAudit&&(!validMetrics(state.latestAudit.baseline)||!validMetrics(state.latestAudit.champion)))throw Error('The snapshot contains an invalid audit.');
  return data;
}
function notice(message,error=false){const node=$('connection-notice');node.hidden=!message;node.textContent=message||'';node.dataset.error=String(error);}
function stopPolling(){clearTimeout(pollTimer);pollTimer=null;}
function schedulePoll(){stopPolling();if(!document.hidden)pollTimer=setTimeout(refreshStatus,3000);}
async function refreshStatus(){
  if(requestInFlight)return;requestInFlight=true;
  try{
    const data=validateSnapshot(await fetchJSON(apiURL('/api/status')));
    applySnapshot(data);
  }catch(error){
    $('learner-status').textContent='Connection unavailable';$('learner-status').dataset.live='false';
    $('learner-detail').textContent=lastSnapshot?`Last received snapshot: ${fullDate(lastSnapshot.serverAt)}.`:'No valid learning snapshot has been received.';
    notice(lastSnapshot?'The connection is unavailable. The values below are retained from the dated snapshot; current server activity is not confirmed.':'The learning server is unavailable. This page will retry; no training results are shown without a valid snapshot.',true);
  }finally{requestInFlight=false;schedulePoll();}
}
function applySnapshot(data){
  lastSnapshot=data;
  const state=data.learner,labels={starting:'Starting',training:'Training',waiting:'Waiting for next generation',paused:'Learning paused',error:'Learner reported an error'};
  $('learner-status').textContent=labels[data.status];$('learner-status').dataset.live=String(data.status==='training');
  $('learner-detail').textContent=`Snapshot ${fullDate(data.serverAt)}. Updates are requested every 3 seconds.`;
  $('snapshot-time').textContent=clock(data.serverAt);
  if(data.error)notice(`The learner reported: ${String(data.error)}. The recorded values remain available.`,true);
  else if(Date.now()-Date.parse(data.serverAt)>90000)notice(`The latest published snapshot is dated ${fullDate(data.serverAt)}. It does not confirm activity after that time.`,true);
  else notice('');
  $('last-save').textContent=clock(data.persistedAt);
  $('next-generation').textContent=data.status==='training'?'Computing':clock(data.nextGenerationAt);
  $('checkpoint-detail').textContent=dateValid(data.persistedAt)?`Latest checkpoint saved ${fullDate(data.persistedAt)}. Training resumes from saved state after a server restart.`:'No saved-checkpoint timestamp has been received.';
  if(!state)return;
  $('generation').textContent=count(state.generation);$('champion-generation').textContent=`Generation ${count(state.championGeneration)}`;
  $('episodes').textContent=count(state.counters?.totalRollouts);
  championWeights=[...state.championWeights];
  const latest=state.history.at(-1);
  $('latest-decision').textContent=latest?(latest.gate?.promoted?'Candidate adopted':'Parameters retained'):'Initial parameters';
  const newChampion=JSON.stringify({weights:championWeights,generation:state.championGeneration});
  if(newChampion!==championSignature){championSignature=newChampion;renderParameters(state.championWeights);}
  const nextSeed=latest?.trainSeed??state.config?.seed??20260911,nextCount=state.config?.trainCount??24;
  const nextScenarioSignature=`${nextSeed}/${nextCount}`;
  if(nextScenarioSignature!==scenarioSignature){scenarioSignature=nextScenarioSignature;replaySeed=nextSeed;replayCount=nextCount;populateScenarios();restartReplay({preservePause:true});}
  else if(!championRollout||(championRollout.finished&&baselineRollout.finished&&JSON.stringify(activeWeights)!==JSON.stringify(championWeights)))restartReplay({preservePause:true});
  else if(JSON.stringify(activeWeights)!==JSON.stringify(championWeights))$('replay-checkpoint').textContent=`Replay generation ${activeGeneration} · newer saved parameters available`;
  const nextHistory=JSON.stringify(state.history);
  if(nextHistory!==historySignature){historySignature=nextHistory;renderHistory(state.history);}
  renderComparison(state);renderAudit(state.latestAudit);
  for(const [id,path]of [['download-checkpoint','/api/checkpoint'],['download-records','/api/records']]){const link=$(id);link.href=apiURL(path);link.removeAttribute('aria-disabled');link.target='_blank';link.rel='noopener noreferrer';}
  $('record-status').textContent=`THROUGH GENERATION ${state.generation}`;
}
function populateScenarios(){
  const prior=$('replay-scenario').value,priorIndex=replayScenarios.find(scenario=>scenario.id===prior)?.index;
  replayScenarios=scenarioSet('train',replaySeed,replayCount);
  const filtered=replayScenarios.filter(scenario=>scenario.protocol===$('replay-protocol').value);
  $('replay-scenario').replaceChildren(...filtered.map(scenario=>{const option=element('option',`Example ${scenario.index+1}`);option.value=scenario.id;return option;}));
  if(filtered.some(scenario=>scenario.id===prior))$('replay-scenario').value=prior;
  else if(filtered.some(scenario=>scenario.index===priorIndex))$('replay-scenario').value=filtered.find(scenario=>scenario.index===priorIndex).id;
}
function restartReplay({preservePause=false}={}){
  if(!lastSnapshot?.learner)return;
  const scenario=replayScenarios.find(item=>item.id===$('replay-scenario').value)||replayScenarios[0];if(!scenario)return;
  activeWeights=[...championWeights];activeGeneration=lastSnapshot.learner.championGeneration;
  baselineRollout=makeRollout(scenario,BASE_WEIGHTS,{record:true});championRollout=makeRollout(scenario,activeWeights,{record:true});
  replayAccumulator=0;lastFrame=performance.now();if(!preservePause)replayPaused=false;$('replay-pause').textContent=replayPaused?'Resume replay':'Pause replay';
  $('replay-description').textContent=`${protocolLabels[scenario.protocol]} · training-task example ${scenario.index+1} · ${DURATION} model-second limit.`;
  $('replay-checkpoint').textContent=`Saved parameters from generation ${activeGeneration}`;
  renderReplay();
}
function renderParameters(weights=null){
  $('parameter-rows').replaceChildren(...PARAMS.map((parameter,index)=>{
    const row=element('tr');[parameter.label,number(parameter.base),weights?number(weights[index]):'Awaiting snapshot',`${number(parameter.min,2)}–${number(parameter.max,2)}`].forEach((value,column)=>{const cell=element('td',value);if(column===2&&weights&&Math.abs(weights[index]-parameter.base)>1e-9)cell.className='parameter-changed';row.append(cell);});return row;
  }));
}
function metricRows(target,rows){
  $(target).replaceChildren(...rows.filter(([,metric])=>validMetrics(metric)).map(([label,metric])=>{
    const row=element('tr');[label,`${metric.successes} / ${metric.episodes}`,percentage(metric.successRate),`${number(metric.meanTimeCost,2)} s`,number(metric.meanPathLength),number(metric.meanReward)].forEach(value=>row.append(element('td',value)));return row;
  }));
}
function renderComparison(state){
  const latest=state.history.at(-1);
  metricRows('gate-rows',[['Original parameters',state.baselineValidation],['Latest candidate',state.currentValidation],['Retained after decision',state.championValidation]]);
  $('gate-label').textContent=latest?`GENERATION ${latest.generation}`:'INITIAL VALIDATION';
  $('gate-description').textContent=latest?
    `${latest.gate?.promoted?'The candidate was adopted.':'The retained parameters were kept.'} These results use the validation set used for checkpoint selection; they are not an unseen-test result.`:
    'The initial controller is evaluated before training begins. Validation results are used for parameter selection, not as independent evidence of improvement.';
}
function renderAudit(audit){
  if(!audit){$('audit-label').textContent='NOT YET REPORTED';return;}
  metricRows('audit-rows',[['Original parameters',audit.baseline],['Saved controller',audit.champion],['Original · no input',audit.noInput?.baseline],['Saved · no input',audit.noInput?.champion]]);
  $('audit-label').textContent=`GENERATION ${audit.generation}`;
  const delta=audit.champion.successes-audit.baseline.successes;
  const comparison=delta<0?`${Math.abs(delta)} fewer targets`:delta>0?`${delta} more targets`:'the same number of targets';
  $('audit-description').textContent=`On this fresh-target evaluation, the saved controller reached ${comparison} than the original controller${delta===0?' did':''}. Each was evaluated on ${audit.baseline.episodes} tasks. These results describe this evaluation; a faster time alone does not establish better overall performance.`;
  if(delta===0)$('audit-description').textContent=`On this fresh-target evaluation, both controllers reached the same number of targets across ${audit.baseline.episodes} tasks each. These results describe this evaluation; a faster time alone does not establish better overall performance.`;
}
function renderHistory(history){
  $('history-count').textContent=`${history.length} RECORDED GENERATIONS`;
  $('history-caption').textContent=history.length?'Actual validation reward after each generation. These repeated selection-set evaluations are not an independent learning benchmark.':'No recorded generations yet. No trend is assumed.';
  const canvas=$('history-chart'),c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  c.clearRect(0,0,w,h);c.fillStyle='#f8f9fa';c.fillRect(0,0,w,h);
  const l=53,r=w-18,t=20,b=h-38,y=value=>b-(value+.25)/1.25*(b-t);
  c.font='12px monospace';c.textBaseline='middle';
  for(const value of [-.25,0,.5,1]){c.strokeStyle='#dbe1e4';c.lineWidth=1;c.beginPath();c.moveTo(l,y(value));c.lineTo(r,y(value));c.stroke();c.fillStyle='#6b7b84';c.textAlign='right';c.fillText(value.toFixed(2),l-9,y(value));}
  if(!history.length){c.fillStyle='#687781';c.textAlign='center';c.fillText('Waiting for recorded evaluations',w/2,h/2);return;}
  const first=Math.min(...history.map(row=>row.generation)),last=Math.max(...history.map(row=>row.generation)),span=Math.max(1,last-first);
  const x=g=>l+(g-first)/span*(r-l);
  for(const [getValue,color]of [[row=>row.championValidationScore,'#126958'],[row=>row.validation.meanReward,'#bf853b']]){
    c.strokeStyle=color;c.fillStyle=color;c.lineWidth=2;c.beginPath();history.forEach((row,index)=>{const px=x(row.generation),py=y(getValue(row));if(index)c.lineTo(px,py);else c.moveTo(px,py);});c.stroke();
    history.forEach(row=>{c.beginPath();c.arc(x(row.generation),y(getValue(row)),3,0,Math.PI*2);c.fill();});
  }
  c.fillStyle='#6b7b84';c.textBaseline='top';c.textAlign='left';c.fillText(String(first),l,b+12);c.textAlign='right';c.fillText(String(last),r,b+12);c.textAlign='center';c.fillText('Generation',(l+r)/2,b+12);
}
function drawArena(canvas,rollout,color){
  const c=canvas.getContext('2d'),w=canvas.width,h=canvas.height;
  c.fillStyle='#101c24';c.fillRect(0,0,w,h);c.lineWidth=1;c.strokeStyle='#20313b';
  for(let i=1;i<10;i++){c.beginPath();c.moveTo(i*w/10,0);c.lineTo(i*w/10,h);c.stroke();c.beginPath();c.moveTo(0,i*h/10);c.lineTo(w,i*h/10);c.stroke();}
  c.strokeStyle='#35505d';c.strokeRect(.045*w,.055*h,.91*w,.89*h);
  if(!rollout){c.fillStyle='#9bb0bc';c.font='14px monospace';c.textAlign='center';c.fillText('Waiting for saved parameters',w/2,h/2);return;}
  const s=rollout.state;
  c.strokeStyle=color+'99';c.lineWidth=2;c.beginPath();rollout.samples.forEach((point,index)=>{if(index)c.lineTo(point.x*w,point.y*h);else c.moveTo(point.x*w,point.y*h);});c.lineTo(s.fish.x*w,s.fish.y*h);c.stroke();
  c.save();c.strokeStyle=rollout.hidden?'#7b8b94':'#e4c678';c.fillStyle=rollout.hidden?'#74818b0d':'#e4c67813';c.lineWidth=1.5;if(rollout.hidden)c.setLineDash([5,4]);c.beginPath();c.ellipse(s.target.x*w,s.target.y*h,CONTACT_RADIUS*w,CONTACT_RADIUS*h,0,0,Math.PI*2);c.fill();c.stroke();c.setLineDash([]);c.fillStyle=rollout.hidden?'#7b8b94':'#e4c678';c.beginPath();c.arc(s.target.x*w,s.target.y*h,5,0,Math.PI*2);c.fill();c.restore();
  c.save();c.translate(s.fish.x*w,s.fish.y*h);c.rotate(s.fish.heading);c.strokeStyle=color;c.lineWidth=2;c.beginPath();c.arc(0,0,10,0,Math.PI*2);c.stroke();c.fillStyle=color;c.beginPath();c.moveTo(18,0);c.lineTo(4,-5);c.lineTo(4,5);c.closePath();c.fill();c.restore();
  c.fillStyle='#9bb0bc';c.font='12px monospace';c.textAlign='left';c.fillText(rollout.hidden?'VISUAL INPUT OFF':'VISUAL INPUT ON',18,h-15);if(rollout.reversed){c.textAlign='right';c.fillText('TARGET REVERSED',w-18,h-15);}
}
function renderReplay(){
  drawArena($('baseline-arena'),baselineRollout,'#9aaebb');drawArena($('champion-arena'),championRollout,'#8bd1ba');if(!championRollout)return;
  for(const [prefix,rollout]of [['baseline',baselineRollout],['champion',championRollout]]){
    $(`${prefix}-time`).textContent=`${number(rollout.state.time,2)} s`;
    $(`${prefix}-result`).textContent=rollout.finished?(rollout.result.reached?'Reached':'Timed out'):replayPaused?'Replay paused':'Replaying';
    $(`${prefix}-path`).textContent=`Path ${number(rollout.pathLength)}`;
  }
  const state=championRollout.state;brain.setRates(state.rates);
  rateRows.forEach((row,index)=>{row.value.textContent=number(state.rates[index]);row.bar.style.width=`${state.rates[index]*100}%`;});
  const image=retinaScratchContext.createImageData(32,16);state.retina.forEach((value,index)=>{const gray=Math.round(Math.min(1,Math.max(0,value))*255);image.data[index*4]=gray;image.data[index*4+1]=gray;image.data[index*4+2]=gray;image.data[index*4+3]=255;});retinaScratchContext.putImageData(image,0,0);retinaContext.imageSmoothingEnabled=false;retinaContext.drawImage(retinaScratch,0,0,320,160);
  $('retina-description').textContent=championRollout.hidden?'Contrast is off in this replay. Existing activity can decay while movement continues.':'A Gaussian stimulus follows the target’s bearing and distance relative to the replayed controller. It is not a browser screenshot.';
}
function frame(now){
  const elapsed=Math.min(.1,Math.max(0,(now-lastFrame)/1000));lastFrame=now;
  if(!document.hidden&&!replayPaused&&championRollout&&(!baselineRollout.finished||!championRollout.finished)){
    replayAccumulator+=elapsed*Number($('replay-speed').value);let steps=0;
    while(replayAccumulator>=DT&&steps<32){if(!baselineRollout.finished)tickRollout(baselineRollout);if(!championRollout.finished)tickRollout(championRollout);replayAccumulator-=DT;steps++;}
    renderReplay();
  }requestAnimationFrame(frame);
}
$('replay-protocol').addEventListener('change',()=>{populateScenarios();restartReplay();});
$('replay-scenario').addEventListener('change',restartReplay);
$('replay-example').addEventListener('click',restartReplay);
$('replay-pause').addEventListener('click',()=>{replayPaused=!replayPaused;$('replay-pause').textContent=replayPaused?'Resume replay':'Pause replay';renderReplay();});
$('replay-speed').addEventListener('change',()=>{lastFrame=performance.now();replayAccumulator=0;});
$('reset-view').addEventListener('click',()=>brain.reset());
document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();replayAccumulator=0;if(document.hidden)stopPolling();else refreshStatus();});
window.addEventListener('pagehide',stopPolling);
renderParameters();renderHistory([]);renderReplay();requestAnimationFrame(frame);
try{await configure();await refreshStatus();}catch(error){notice('The learning connection could not be configured. The recorded state is unavailable; no results are assumed.',true);$('learner-status').textContent='Connection unavailable';}
