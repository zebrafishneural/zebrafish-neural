import {BrainView} from './lib/brain-view.js';
import {REGIONS} from './lib/model.js';
const $=id=>document.getElementById(id),brain=new BrainView($('brain'));
const retina=$('live-retina'),rc=retina.getContext('2d'),small=document.createElement('canvas');small.width=32;small.height=16;
const sc=small.getContext('2d'),pixels=sc.createImageData(32,16);
let socket=null,latest=null,endpoint='',lastReceived=0,socketOpenedAt=0,socketMessageAt=0,stopped=false,retryTimer=null,lastEventKey='',retries=0;
const rates=REGIONS.map(region=>{
 const row=document.createElement('div');row.className='live-rate';
 const label=document.createElement('span');label.textContent=region.name;
 const value=document.createElement('output');value.textContent='—';
 const meter=document.createElement('span');meter.className='live-rate-meter';const fill=document.createElement('i');meter.append(fill);row.append(label,value,meter);$('live-rates').append(row);return {value,fill};
});
function duration(sec){if(!Number.isFinite(sec))return '—';const s=Math.floor(sec);return s<60?`${s}s`:s<3600?`${Math.floor(s/60)}m ${s%60}s`:`${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`;}
function connection(label,detail,live=false){$('connection-state').textContent=label;$('connection-state').dataset.live=String(live);$('connection-detail').textContent=detail;}
function unavailable(title,detail){$('stream-empty').hidden=false;$('empty-title').textContent=title;$('empty-detail').textContent=detail;$('live-cursor').setAttribute('visibility','hidden');$('download-run').disabled=true;}
function renderEvents(data){
 const key=data.runId+':'+(data.events?.[0]?.id||0);if(key===lastEventKey)return;lastEventKey=key;
 $('events-list').replaceChildren();
 for(const e of (data.events||[]).slice(0,6)){
  const item=document.createElement('li'),time=document.createElement('time'),body=document.createElement('div'),kind=document.createElement('span');
  const date=new Date(e.at);time.dateTime=e.at;time.textContent=Number.isFinite(date.getTime())?date.toLocaleTimeString('en-GB',{hour12:false}):'—';kind.className='event-kind';kind.textContent=e.kind;body.append(kind,document.createTextNode(e.text));
  if(e.url){const url=document.createElement('span');url.className='event-url';url.textContent=e.url;body.append(url);}
  item.append(time,body);$('events-list').append(item);
 }
}
function render(data){
 if(data.schemaVersion!==1||!Array.isArray(data.rates)||data.rates.length!==8||!data.rates.every(Number.isFinite))return;
 lastReceived=performance.now();latest=data;retries=0;
 const fresh=data.status==='running'&&data.frame?.ageMs!==null&&data.frame.ageMs<4000;
 connection(fresh?'Live':data.status==='navigating'?'Changing page':data.status==='recovering'?'Reconnecting':'Waiting for input',fresh?'Shared run · independent of this tab':data.message,fresh);
 $('live-time').textContent=duration(data.modelTime);$('live-uptime').textContent=duration(data.uptimeSeconds);$('frame-age').textContent=data.frame?.ageMs===null?'—':`${(data.frame.ageMs/1000).toFixed(1)}s`;
 $('click-count').textContent=String(data.stats?.clicks??0);$('run-id').textContent='Session '+data.runId.slice(0,8);
 $('page-title').textContent=data.page?.title||'Waiting for a page';
 const link=$('page-link');
 try{const u=new URL(data.page.url);if(u.protocol!=='https:')throw Error();link.href=u.href;link.textContent=u.hostname+decodeURIComponent(u.pathname);link.removeAttribute('aria-disabled');}catch{link.removeAttribute('href');link.textContent='Waiting for a page';link.setAttribute('aria-disabled','true');}
 if(data.frame?.jpeg&&/^[-A-Za-z0-9+/=]+$/.test(data.frame.jpeg)){$('browser-frame').src='data:image/jpeg;base64,'+data.frame.jpeg;$('browser-frame').hidden=false;}
 if(fresh){$('stream-empty').hidden=true;$('live-cursor').setAttribute('visibility','visible');$('live-cursor').setAttribute('transform',`translate(${data.cursor.xPx},${data.cursor.yPx})`);$('frame-caption').textContent=`LIVE · FRAME ${data.frame.id}`;$('download-run').disabled=false;}
 else{unavailable(data.status==='navigating'?'Opening the next page':'Waiting for fresh browser input',data.message||'The stream will resume automatically.');$('frame-caption').textContent=data.frame?.id?`LAST FRAME ${data.frame.id} · NOT LIVE`:'No frame received';}
 brain.setRates(data.rates);rates.forEach((r,i)=>{r.value.textContent=data.rates[i].toFixed(2);r.fill.style.width=`${Math.max(0,Math.min(1,data.rates[i]))*100}%`;});
 if(Array.isArray(data.retina)&&data.retina.length===512){for(let i=0;i<512;i++){const v=Math.round(Math.max(0,Math.min(1,data.retina[i]))*255);pixels.data.set([v,v,v,255],i*4);}sc.putImageData(pixels,0,0);rc.imageSmoothingEnabled=false;rc.drawImage(small,0,0,320,160);}
 renderEvents(data);
}
function schedule(){if(stopped||retryTimer)return;retryTimer=setTimeout(()=>{retryTimer=null;connect();},Math.min(15000,2000*2**Math.min(retries++,3)));}
async function connect(){
 if(stopped)return;
 try{
  const res=await fetch('./live-config.json',{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!res.ok)throw Error('config');
  const config=await res.json(),url=new URL(config.endpoint);
  if(url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)&&['127.0.0.1','localhost'].includes(location.hostname)))throw Error('endpoint');
  endpoint=url.origin;const wsUrl=new URL('/ws',endpoint);wsUrl.protocol=url.protocol==='https:'?'wss:':'ws:';
  socket=new WebSocket(wsUrl);const opening=socket;
  const deadline=setTimeout(()=>{if(opening.readyState!==WebSocket.OPEN)opening.close();},12000);
  socket.addEventListener('open',()=>{clearTimeout(deadline);socketOpenedAt=performance.now();socketMessageAt=0;});
  socket.addEventListener('message',e=>{if(socket!==opening)return;try{const data=JSON.parse(e.data);if(data.schemaVersion!==1)return;render(data);socketMessageAt=performance.now();}catch{}});
  socket.addEventListener('error',()=>opening.close());
  socket.addEventListener('close',()=>{clearTimeout(deadline);if(socket!==opening)return;connection('Offline','The controller host is not reachable. Reconnecting automatically.');unavailable('Controller offline','This page will reconnect when the host is available.');schedule();});
 }catch{connection('Offline','The controller host is not reachable.');unavailable('Controller offline','This page will reconnect when the host is available.');schedule();}
}
setInterval(()=>{
 if(!latest)return;
 const elapsed=performance.now()-lastReceived,age=(latest.frame?.ageMs||0)+elapsed;
 $('frame-age').textContent=latest.frame?.capturedAt?`${(age/1000).toFixed(1)}s`:'—';
 if(elapsed>6000||age>6000){connection('Interrupted','No fresh browser frames. Reconnecting automatically.');unavailable('Live feed interrupted','The last received state is retained. Waiting for the controller.');$('frame-caption').textContent=`LAST FRAME ${latest.frame.id} · NOT LIVE`;if(socket?.readyState===WebSocket.OPEN&&performance.now()-(socketMessageAt||socketOpenedAt)>12000)socket.close();}
},1000);
$('reset-view').addEventListener('click',()=>brain.reset());
$('download-run').addEventListener('click',async()=>{
 const button=$('download-run');button.disabled=true;
 try{const res=await fetch(endpoint+'/recording.json',{signal:AbortSignal.timeout(8000),cache:'no-store'});if(!res.ok)throw Error();const blob=await res.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='zebrafish-neural-live-run.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch{connection('Export unavailable','The controller could not provide the recording. Try again.');}finally{button.disabled=!latest;}
});
window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(retryTimer);socket?.close();});
window.addEventListener('pageshow',e=>{if(e.persisted){stopped=false;retryTimer=null;connect();}});
brain.setData(null,'model');connect();
