import {SharedFeed} from './lib/shared-feed.js';
import {BrainView} from './lib/brain-view.js';
import {REGIONS,DT} from './lib/model.js';
import {Session,PROTOCOLS,DURATION,CONTACT_RADIUS} from './lib/target-task.js';

const $=id=>document.getElementById(id),put=(id,value)=>{if($(id))$(id).textContent=value;};
const brain=new BrainView($('brain')),session=new Session();
const arena=$('target-arena'),g=arena.getContext('2d'),retina=$('live-retina'),rc=retina.getContext('2d');
const small=document.createElement('canvas');small.width=32;small.height=16;
const sc=small.getContext('2d'),pixels=sc.createImageData(32,16);
const box={x:74,y:42,size:574},point=p=>({x:box.x+p.x*box.size,y:box.y+p.y*box.size});
const stateStarted=performance.now();
let mode='wikipedia',paused=false,speed=1,accumulator=0,lastFrame=performance.now(),lastPaint=0,holdUntil=0;
let latestWiki=null,wikiReceived=0,eventKey='',tableKey='';
const rateRows=REGIONS.map(region=>{
  const row=document.createElement('div');row.className='live-rate';
  const label=document.createElement('span');label.textContent=region.name;
  const value=document.createElement('output');value.textContent='—';
  const meter=document.createElement('span');meter.className='live-rate-meter';const fill=document.createElement('i');meter.append(fill);
  row.append(label,value,meter);$('live-rates').append(row);return {value,fill};
});
brain.setData(null,'model');
const duration=seconds=>{if(!Number.isFinite(seconds))return '—';const s=Math.floor(seconds);return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m ${s%60}s`:`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`;};
function connection(label,detail,live=false){put('connection-state',label);$('connection-state').dataset.live=String(live);put('connection-detail',detail);}
function modelView(rates,input){
  brain.setRates(rates);
  rateRows.forEach((row,i)=>{row.value.textContent=rates[i].toFixed(2);row.fill.style.width=`${Math.max(0,Math.min(1,rates[i]))*100}%`;});
  if(input?.length===512){for(let i=0;i<512;i++){const v=Math.round(Math.max(0,Math.min(1,input[i]))*255);pixels.data.set([v,v,v,255],i*4);}sc.putImageData(pixels,0,0);rc.imageSmoothingEnabled=false;rc.drawImage(small,0,0,320,160);}
}
function events(rows,key,local=false){
  if(key===eventKey)return;eventKey=key;$('events-list').replaceChildren();
  for(const e of rows.slice(0,6)){
    const li=document.createElement('li'),time=document.createElement('time'),body=document.createElement('div'),kind=document.createElement('span');
    time.textContent=local?`${e.t.toFixed(2)}s`:new Date(e.at).toLocaleTimeString('en-GB',{hour12:false});
    kind.className='event-kind';kind.textContent=e.kind;body.append(kind,document.createTextNode(local?e.detail:e.text));li.append(time,body);$('events-list').append(li);
  }
}
function text(value,x,y,size=13,color='#93abb8'){g.font=`${size}px 'IBM Plex Mono',Consolas,monospace`;g.fillStyle=color;g.fillText(value,x,y);}
function circle(x,y,r,fill,stroke){g.beginPath();g.arc(x,y,r,0,Math.PI*2);if(fill){g.fillStyle=fill;g.fill();}if(stroke){g.strokeStyle=stroke;g.stroke();}}
function drawTask(){
  const s=session.state,target=point(s.target),fish=point(s.fish);
  g.fillStyle='#101c24';g.fillRect(0,0,1120,700);g.strokeStyle='#243943';g.lineWidth=1;
  for(let i=0;i<=10;i++){const p=i/10*box.size;g.beginPath();g.moveTo(box.x+p,box.y);g.lineTo(box.x+p,box.y+box.size);g.moveTo(box.x,box.y+p);g.lineTo(box.x+box.size,box.y+p);g.stroke();}
  for(let i=0;i<=4;i++){const v=i/4;text(v.toFixed(2),box.x+v*box.size-15,box.y+box.size+25,12);text(v.toFixed(2),box.x-46,box.y+v*box.size+5,12);}
  text('NORMALIZED ARENA COORDINATES',box.x+120,box.y+box.size+52,12);
  g.save();g.beginPath();g.rect(box.x,box.y,box.size,box.size);g.clip();
  if(session.trace.length>1){g.beginPath();session.trace.forEach((p,i)=>{const q=point(p);if(i===0)g.moveTo(q.x,q.y);else g.lineTo(q.x,q.y);});g.lineTo(fish.x,fish.y);g.strokeStyle='#82bfb3';g.lineWidth=2;g.stroke();}
  const origin=point({x:.5,y:.75});circle(origin.x,origin.y,5,'#101c24','#617b88');
  g.setLineDash([5,6]);g.lineWidth=1.5;circle(target.x,target.y,CONTACT_RADIUS*box.size,null,session.hidden?'#6e8088':'#e6c478');g.setLineDash([]);
  circle(target.x,target.y,12,session.hidden?'#101c24':'#e6c478',session.hidden?'#6e8088':'#e6c478');
  text(session.hidden?'HIDDEN TARGET':'TARGET',target.x+17,target.y-17,12,session.hidden?'#6e8088':'#e6c478');
  g.strokeStyle='#82bfb3';g.beginPath();g.moveTo(fish.x,fish.y);g.lineTo(fish.x+Math.cos(s.fish.heading)*27,fish.y+Math.sin(s.fish.heading)*27);g.stroke();g.restore();
  $('live-cursor').setAttribute('visibility','visible');$('live-cursor').setAttribute('transform',`translate(${fish.x},${fish.y})`);
  const x=730;
  text('CONTROLLED VISUAL TASK',x,75,13);text(PROTOCOLS[session.protocol],x,116,21,'#e1ebee');
  text('INPUT',x,177,12);text(session.hidden?'Off · activity decays':'On · synthetic retina',x,204,17,session.hidden?'#b7c5cb':'#82bfb3');
  text('TURN / MOTOR DIFFERENCE',x,266,12);text(`${s.fish.turn>=0?'+':''}${s.fish.turn.toFixed(3)} rad/s`,x,299,25,'#e1ebee');
  text('SPEED',x,359,12);text(`${s.fish.speed.toFixed(3)} units/s`,x,391,25,'#e1ebee');
  text('Click to reposition the target.',x,465,13);text('Arrow keys also move the target.',x,489,13);
  text('Existing model · fixed coefficients',x,556,12);text('Synthetic input · browser session',x,578,12);
  if(session.finished){g.fillStyle='#0b1821ed';g.fillRect(box.x+70,box.y+218,box.size-140,80);g.textAlign='center';text(session.result.toUpperCase(),box.x+box.size/2,box.y+250,23,'#e1ebee');text(`${s.time.toFixed(2)} model seconds`,box.x+box.size/2,box.y+277,14);g.textAlign='left';}
}
function trialTable(){
  const key=session.id+':'+session.records.length;
  if(key===tableKey)return;tableKey=key;
  const body=$('trials');body.replaceChildren();
  if(!session.records.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=6;td.textContent='Completed and interrupted attempts will appear here.';tr.append(td);body.append(tr);}
  for(const item of session.records.slice(-8).reverse()){
    const row=document.createElement('tr');
    for(const v of [String(item.trial).padStart(2,'0'),PROTOCOLS[item.protocol],item.input,item.result+(item.standard?'':' *'),item.firstContactSeconds===null?'—':item.firstContactSeconds.toFixed(2),item.pathLength.toFixed(3)]){const td=document.createElement('td');td.textContent=v;row.append(td);}body.append(row);
  }
}
function paintTarget(){
  const s=session.state,summary=session.summary();
  connection(document.hidden?'Experiment paused':paused?'Experiment paused':'Interactive experiment','Synthetic input · unchanged model equations');
  put('live-time',`${s.time.toFixed(2)}s`);put('live-uptime',duration((performance.now()-stateStarted)/1000));put('frame-age','Synthetic');put('click-count',`${summary.reached} / ${summary.completed}`);
  put('page-title','Target test · independent browser session');put('run-id','Session '+session.id.slice(0,8));
  const link=$('page-link');link.removeAttribute('href');link.setAttribute('aria-disabled','true');link.textContent=PROTOCOLS[session.protocol]+' / browser session';
  put('frame-caption',`TARGET TEST · TRIAL ${session.counter} · ${speed}× MODEL TIME${paused?' · PAUSED':''}`);
  put('trial-number',String(session.counter).padStart(2,'0'));put('remaining',`${Math.max(0,DURATION-s.time).toFixed(1)}s`);put('success',`${summary.reached} / ${summary.completed}`);
  put('first-contact',session.result==='Reached'?`${s.time.toFixed(2)}s`:'—');put('path-length',`${session.path.toFixed(3)} units`);put('result-label',session.finished?session.result:session.manual?'Custom input':'Running');
  put('protocol-note',({reach:'Fixed target · 30 s limit · contact radius 0.065 units.',reversal:'Target changes position at 4 s. Contact is scored after that change.',occlusion:'Visual stimulus off at 3 s, back at 8 s if the trial is still running.'})[session.protocol]);
  put('result-summary',`Standard ${PROTOCOLS[session.protocol].toLowerCase()} trials only. Observer interventions (*) and interrupted attempts are excluded from success counts; all attempts remain in the JSON.`);
  $('pause').textContent=paused?'Resume':'Pause';$('pause').setAttribute('aria-pressed',String(paused));$('cover').textContent=session.manualHidden?'Restore stimulus':'Hide stimulus';$('cover').setAttribute('aria-pressed',String(session.manualHidden));
  $('download-run').disabled=false;
  drawTask();modelView(s.rates,s.retina);events(session.events.slice().reverse(),'target:'+session.id+':'+session.events.length,true);trialTable();
}
function setEmpty(title,detail){$('stream-empty').hidden=false;put('empty-title',title);put('empty-detail',detail);$('live-cursor').setAttribute('visibility','hidden');}
function renderWiki(data){
  if(mode!=='wikipedia')return;
  latestWiki=data;wikiReceived=performance.now();
  if(data.frame?.jpeg&&/^[-A-Za-z0-9+/=]+$/.test(data.frame.jpeg)){$('browser-frame').src='data:image/jpeg;base64,'+data.frame.jpeg;$('browser-frame').hidden=false;}
  const fresh=data.status==='running'&&data.frame?.ageMs!==null&&data.frame?.ageMs<4000;
  connection(fresh?'Live':'Waiting for input',fresh?'Shared Wikipedia run · read-only observer':data.message,fresh);
  put('live-time',duration(data.modelTime));put('live-uptime',duration(data.uptimeSeconds));put('frame-age',data.frame?.ageMs===null?'—':`${(data.frame.ageMs/1000).toFixed(1)}s`);put('click-count',String(data.stats?.clicks??0));
  put('page-title',data.page?.title||'Waiting for a page');put('run-id','Session '+data.runId.slice(0,8));
  const link=$('page-link');try{const u=new URL(data.page.url);if(u.protocol!=='https:')throw Error();link.href=u.href;link.textContent=u.hostname+decodeURIComponent(u.pathname);link.removeAttribute('aria-disabled');}catch{link.removeAttribute('href');link.textContent='Waiting for a page';}
  if(fresh){$('stream-empty').hidden=true;$('live-cursor').setAttribute('visibility','visible');$('live-cursor').setAttribute('transform',`translate(${data.cursor.xPx},${data.cursor.yPx})`);put('frame-caption',`LIVE · FRAME ${data.frame.id}`);$('download-run').disabled=false;}
  else{setEmpty('Waiting for fresh browser input',data.message||'The shared process will resume when available.');$('download-run').disabled=true;put('frame-caption','LAST FRAME · NOT LIVE');}
  modelView(data.rates,data.retina);events(data.events||[],'wiki:'+data.runId+':'+(data.events?.[0]?.id||0));
}
const feed=new SharedFeed({onData:renderWiki,onStatus:status=>{
  if(mode!=='wikipedia')return;
  connection(status.label,status.detail);
  setEmpty(status.label==='Connecting'?'Connecting to the shared run':status.label,status.detail);
  $('download-run').disabled=true;put('frame-caption',latestWiki?.frame?.id?'LAST FRAME · NOT LIVE':'Waiting for a fresh frame');
}});
function switchMode(next){
  feed.stop();mode=next;accumulator=0;lastFrame=performance.now();eventKey='';
  const target=next==='target';
  $('mode-target').setAttribute('aria-pressed',String(target));$('mode-wikipedia').setAttribute('aria-pressed',String(!target));
  for(const id of ['target-controls','task-results','trial-records'])if($(id))$(id).hidden=!target;
  arena.hidden=!target;$('browser-frame').hidden=target||!latestWiki?.frame?.jpeg;
  const labels=document.querySelectorAll('.live-metrics > div > span');
  labels[1].textContent=target?'Tab uptime':'Browser uptime';labels[2].textContent=target?'Visual input':'Frame age';labels[3].textContent=target?'Reached / trials':'Model link clicks';
  put('input-description',target?'A synthetic retinal field generated from target bearing and distance. The existing eight-state equations drive movement.':'A cursor-centered, heading-oriented crop of the real browser image. Local contrast drives the model.');
  put('experiment-footnote',target?'Independent browser session using the existing model and a synthetic stimulus. It pauses when this tab is hidden or Wikipedia is selected. No learning or desktop capture.':'This tab observes the existing shared Wikipedia process. Switching experiments here does not control or interrupt that process.');
  put('download-run',target?'Export session JSON ↗':'Download recent run ↗');
  $('input-method').href=target?'./docs.html#target-test':'./docs.html#live';
  $('events-list').replaceChildren();
  if(target){$('stream-empty').hidden=true;paintTarget();}
  else{setEmpty('Connecting to the shared run','Loading the current Wikipedia frame.');$('download-run').disabled=true;modelView(new Array(8).fill(0),new Array(512).fill(0));latestWiki=null;connection('Connecting','Read-only Wikipedia observer');feed.start();}
}
function change(){accumulator=0;holdUntil=0;paintTarget();}
$('mode-target').addEventListener('click',()=>{history.replaceState(null,'','#target-test');switchMode('target');});
$('mode-wikipedia').addEventListener('click',()=>{history.replaceState(null,'','#live-browser');switchMode('wikipedia');});
$('protocol').addEventListener('change',e=>{session.next(e.target.value);change();});
$('speed').addEventListener('change',e=>{speed=Number(e.target.value);session.log('observer',`Playback ${speed}×; model step unchanged`);change();});
$('pause').addEventListener('click',()=>{paused=!paused;session.log('observer',paused?'Paused':'Resumed');change();});
$('reset').addEventListener('click',()=>{session.reset();paused=false;$('protocol').value='reach';change();});
$('cover').addEventListener('click',()=>{session.toggleInput();change();});
$('move-target').addEventListener('click',()=>{session.next();change();});
$('reset-view').addEventListener('click',()=>brain.reset());
arena.addEventListener('click',e=>{const rect=arena.getBoundingClientRect(),x=(e.clientX-rect.left)/rect.width*1120,y=(e.clientY-rect.top)/rect.height*700;if(x<box.x||x>box.x+box.size||y<box.y||y>box.y+box.size)return;session.moveTarget((x-box.x)/box.size,(y-box.y)/box.size);change();});
arena.addEventListener('keydown',e=>{const deltas={ArrowLeft:[-.05,0],ArrowRight:[.05,0],ArrowUp:[0,-.05],ArrowDown:[0,.05]};if(!deltas[e.key])return;e.preventDefault();const [dx,dy]=deltas[e.key];session.moveTarget(session.state.target.x+dx,session.state.target.y+dy);change();});
$('download-run').addEventListener('click',async()=>{
  const target=mode==='target';let blob;
  try{
    if(target){const data=session.export();data.playback={speed,paused};blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});}
    else{blob=await feed.getRecording();}
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=target?'zebrafish-target-test.json':'zebrafish-neural-live-run.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);
  }catch{connection('Export unavailable','The recording could not be downloaded.');}
});
document.addEventListener('visibilitychange',()=>{lastFrame=performance.now();accumulator=0;});
setInterval(()=>{if(mode==='wikipedia'&&latestWiki){const age=(latestWiki.frame?.ageMs||0)+performance.now()-wikiReceived;put('frame-age',`${(age/1000).toFixed(1)}s`);if(age>6000){connection('Interrupted','Waiting for fresh frames from the existing controller.');setEmpty('Live feed interrupted','No fresh frame has arrived from the shared controller.');}}},500);
function frame(now){
  const elapsed=Math.min(.1,(now-lastFrame)/1000);lastFrame=now;
  if(mode==='target'){
    if(!paused&&!document.hidden){
      if(session.finished){if(!holdUntil)holdUntil=now+1600;if(now>=holdUntil){session.start();holdUntil=0;accumulator=0;}}
      else{accumulator+=elapsed*speed;while(accumulator>=DT&&!session.finished){session.tick();accumulator-=DT;}if(session.finished)holdUntil=now+1600;}
    }
    if(now-lastPaint>=40){paintTarget();lastPaint=now;}
  }
  requestAnimationFrame(frame);
}
window.addEventListener('pagehide',()=>feed.stop());
window.addEventListener('pageshow',event=>{if(event.persisted&&mode==='wikipedia')feed.start();});
window.addEventListener('hashchange',()=>{if(location.hash==='#target-test')switchMode('target');else if(location.hash==='#live-browser')switchMode('wikipedia');});
switchMode(location.hash==='#target-test'?'target':'wikipedia');requestAnimationFrame(frame);
