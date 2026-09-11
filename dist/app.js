import {renderRetina,getTarget,REGIONS,MODEL_VERSION,DT,csv,clamp} from './lib/model.js';
import {BrainView} from './lib/brain-view.js';
import {ModelSession} from './lib/session.js';
const $=id=>document.getElementById(id);
const ui={run:$('run'),reset:$('reset'),stim:$('stimulus'),intensity:$('intensity'),status:$('status'),clock:$('clock'),announce:$('announcement')};
const session=new ModelSession({mode:ui.stim.value,intensity:Number(ui.intensity.value)/100});
session.setHidden(document.hidden);
let state=session.state,samples=session.samples,lastTime=performance.now(),selected=-1;
let anatomy=null,anatomyMeta=null,loadingAnatomy=false;
const brain=new BrainView($('brain'));
const retina=$('retina'),retinaCtx=retina.getContext('2d');
const retinaSmall=document.createElement('canvas');retinaSmall.width=32;retinaSmall.height=16;
const retinaSmallCtx=retinaSmall.getContext('2d');
const retinaImage=retinaSmallCtx.createImageData(32,16);
const arena=$('arena'),arenaCtx=arena.getContext('2d');
const trace=$('trace'),traceCtx=trace.getContext('2d');
const bars=REGIONS.map((region,i)=>{
 const button=document.createElement('button');button.className='region';button.type='button';button.setAttribute('aria-pressed','false');
 button.innerHTML=`<span class="region-row"><span>${region.name}</span><output>0.00</output></span><span class="region-meter"><span></span></span>`;
 button.addEventListener('click',()=>{selected=selected===i?-1:i;bars.forEach((b,j)=>{b.button.classList.toggle('selected',selected===j);b.button.setAttribute('aria-pressed',String(selected===j));});brain.select(brain.mode==='model'?selected:-1);$('region-note').textContent=brain.mode==='anatomy'?'The measured positions have no population labels. Highlighting is available in the model view.':selected<0?'Select a population to highlight its illustrative geometry.':`${region.name}: ${region.tau.toFixed(2)} s model time constant. Activity is dimensionless.`;});
 $('region-list').appendChild(button);return {button,value:button.querySelector('output'),bar:button.querySelector('.region-meter span')};
});
function syncControls(){
 ui.stim.disabled=!session.paused;ui.intensity.disabled=!session.paused;
 ui.run.innerHTML=session.paused?'Resume <span aria-hidden="true">▶</span>':'Pause <span aria-hidden="true">Ⅱ</span>';
 ui.status.textContent=session.paused?'Paused':session.hidden?'Suspended':'Running';
 $('state-dot').classList.toggle('running',session.running);ui.announce.textContent=ui.status.textContent;lastTime=performance.now();
}
function reset(){session.restart({mode:ui.stim.value,intensity:Number(ui.intensity.value)/100});state=session.state;samples=session.samples;renderRetina(state);syncControls();update();ui.announce.textContent=session.paused?'Session reset and paused. Previous samples have been cleared.':'Session restarted automatically. Previous samples have been cleared.';}
function format(n,digits=2){return n.toFixed(digits);}
function update(){
 brain.setRates(state.rates);bars.forEach((b,i)=>{b.value.value=format(state.rates[i]);b.bar.style.width=(state.rates[i]*100)+'%';b.button.setAttribute('aria-label',`${REGIONS[i].name}, activity ${format(state.rates[i])}`);});
 ui.clock.textContent=state.time.toFixed(2).padStart(5,'0')+' s';$('speed').textContent=format(state.fish.speed,3)+' arena/s';
 $('sample-count').textContent=samples.length+' samples';$('export-json').disabled=!samples.length;$('export-csv').disabled=!samples.length;
 const delta=state.rates[6]-state.rates[5];$('turn-value').textContent=Math.abs(delta)<.025?'Balanced':delta>0?'Turning right':'Turning left';$('balance').style.left=`calc(${50+clamp(delta,-1,1)*47}% - 3px)`;
 $('behavior').textContent=state.fish.speed<.002?(state.time?'Low motor activity':'Awaiting input'):state.features.threat>.15?'Escape drive':Math.abs(delta)>.03?'Turning':'Forward swimming';
 drawRetina();drawArena();drawTrace();
}
function fitCanvas(canvas){const {width,height}=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);if(canvas.width!==Math.round(width*ratio)||canvas.height!==Math.round(height*ratio)){canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);}const c=canvas.getContext('2d');c.setTransform(ratio,0,0,ratio,0,0);return {c,w:width,h:height};}
function drawRetina(){for(let i=0;i<state.retina.length;i++){const v=Math.round(state.retina[i]*255);retinaImage.data[i*4]=v;retinaImage.data[i*4+1]=v;retinaImage.data[i*4+2]=v;retinaImage.data[i*4+3]=255;}retinaSmallCtx.putImageData(retinaImage,0,0);retinaCtx.imageSmoothingEnabled=false;retinaCtx.drawImage(retinaSmall,0,0,retina.width,retina.height);}
function drawArena(){
 const {c,w,h}=fitCanvas(arena);c.clearRect(0,0,w,h);const pad=17, W=w-pad*2,H=h-pad*2;const point=p=>({x:pad+p.x*W,y:pad+p.y*H});
 c.strokeStyle='#1a333d';c.lineWidth=.7;for(let x=pad;x<w-pad;x+=W/12){c.beginPath();c.moveTo(x,pad);c.lineTo(x,h-pad);c.stroke();}for(let y=pad;y<h-pad;y+=H/4){c.beginPath();c.moveTo(pad,y);c.lineTo(w-pad,y);c.stroke();}
 if(state.config.mode!=='dark'){
  const t=point(getTarget(state)),shadow=state.config.mode==='looming';const alpha=shadow?clamp((3-state.time)/.7):1;
  const r=shadow?9+24*clamp(state.time/1.5):8;
  c.globalAlpha=alpha*state.config.intensity;c.fillStyle=shadow?'#e2a65f':'#eccc88';c.beginPath();c.arc(t.x,t.y,r,0,Math.PI*2);c.fill();c.globalAlpha=alpha*.2*state.config.intensity;c.beginPath();c.arc(t.x,t.y,r+10,0,Math.PI*2);c.fill();c.globalAlpha=1;
  c.font='12px "DM Sans",sans-serif';c.fillStyle='#a3b7bf';c.textAlign='center';c.fillText(shadow?'Shadow':'Light',t.x,Math.min(h-8,t.y+r+22));
 }
 c.strokeStyle='#569b96';c.lineWidth=1.5;c.globalAlpha=.6;c.beginPath();samples.forEach((p,i)=>{const q=point(p);if(i===0)c.moveTo(q.x,q.y);else c.lineTo(q.x,q.y);});c.stroke();c.globalAlpha=1;
 const pos=point(state.fish);const angle=Math.atan2(Math.sin(state.fish.heading)*H,Math.cos(state.fish.heading)*W);c.save();c.translate(pos.x,pos.y);c.rotate(angle);
 const amp=Math.min(1,state.fish.speed*14),wave=Math.sin(state.time*23)*amp;
 c.strokeStyle='#afd4cf';c.lineWidth=2;c.beginPath();c.moveTo(-7,0);c.bezierCurveTo(-15,4*wave,-20,-5*wave,-29,3*wave);c.stroke();
 c.fillStyle='#69aeb080';c.beginPath();c.moveTo(-15,-2);c.lineTo(-24,-8+4*wave);c.lineTo(-22,7+4*wave);c.closePath();c.fill();
 c.fillStyle='#c3e2df';c.beginPath();c.ellipse(0,0,11,4.8,0,0,Math.PI*2);c.fill();c.fillStyle='#527c81';for(let i=-6;i<5;i+=3){c.fillRect(i,-3,1,6);}c.fillStyle='#07191f';c.beginPath();c.arc(5,-3,1.8,0,Math.PI*2);c.arc(5,3,1.8,0,Math.PI*2);c.fill();c.restore();
}
function drawTrace(){
 const {c,w,h}=fitCanvas(trace);c.clearRect(0,0,w,h);const left=27,right=w-7,top=12,bottom=h-25;const start=Math.max(0,state.time-12),end=Math.max(12,state.time);
 c.font='12px "IBM Plex Mono",monospace';c.lineWidth=.7;
 for(const v of [0,.5,1]){const y=bottom-v*(bottom-top);c.strokeStyle='#ced6dc';c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();c.fillStyle='#566773';c.textAlign='right';c.fillText(v===.5?'0.5':String(v),left-6,y+4);}
 const ticks=w<300?3:5;for(let i=0;i<ticks;i++){const f=i/(ticks-1),x=left+f*(right-left);c.textAlign=i===0?'left':i===ticks-1?'right':'center';c.fillStyle='#566773';c.fillText((start+(end-start)*f).toFixed(0),x,h-6);}
 for(const [idx,color] of [[5,'#186854'],[6,'#a46b25']]){c.beginPath();c.lineWidth=1.7;c.strokeStyle=color;let begun=false;for(const s of samples){if(s.t<start)continue;const x=left+(s.t-start)/(end-start)*(right-left),y=bottom-s.rates[idx]*(bottom-top);if(!begun){c.moveTo(x,y);begun=true;}else c.lineTo(x,y);}c.stroke();}
}
function animate(now){
 if(session.running){session.advance(Math.max(0,(now-lastTime)/1000));update();}
 lastTime=now;requestAnimationFrame(animate);
}
ui.run.addEventListener('click',()=>{session.setPaused(!session.paused);syncControls();});ui.reset.addEventListener('click',reset);
ui.stim.addEventListener('change',reset);ui.intensity.addEventListener('input',()=>{$('intensity-value').value=format(Number(ui.intensity.value)/100);reset();});
$('reset-view').addEventListener('click',()=>brain.reset());
function setGeometry(mode){
 const isModel=mode==='model';brain.setData(isModel?null:anatomy,mode);brain.select(isModel?selected:-1);
 $('brain-heading').textContent=isModel?'Neural controller':'Spatial reference';
 $('view-model').classList.toggle('active',isModel);$('view-anatomy').classList.toggle('active',!isModel);$('view-model').setAttribute('aria-pressed',String(isModel));$('view-anatomy').setAttribute('aria-pressed',String(!isModel));
 $('geometry-note').textContent=isModel?'Illustrative layout · simulated activity':'ZAPBench · measured cell centroids';$('geometry-count').textContent=isModel?'8 SIMULATED STATES':'71,721 CELL CENTROIDS';
 $('geometry-source').textContent=isModel?'5,220 display points':'CC BY 4.0 · source positions in µm';$('color-key').innerHTML=isModel?'<i></i>Brightness: simulated activity':'<i></i>Measured geometry · no activity mapping';
 $('region-note').textContent=isModel?'Select a population to highlight its illustrative geometry.':'This asset has no regional labels or connections. Model activity is not assigned to these cells.';
 ui.announce.textContent=isModel?'Showing the illustrative population model.':'Showing 71,721 measured cell centroids without activity mapping.';
}
$('view-model').addEventListener('click',()=>setGeometry('model'));
$('view-anatomy').addEventListener('click',async()=>{
 if(anatomy){setGeometry('anatomy');return;}if(loadingAnatomy)return;loadingAnatomy=true;$('view-anatomy').textContent='Loading…';
 try {
  const [res,metaRes]=await Promise.all([fetch('./data/zapbench-centroids-71721.f32'),fetch('./data/zapbench-centroids.metadata.json')]);
  if(!res.ok||!metaRes.ok)throw new Error('Data unavailable');const buffer=await res.arrayBuffer();if(buffer.byteLength!==71721*12)throw new Error('Unexpected anatomy size');anatomyMeta=await metaRes.json();
  const view=new DataView(buffer), raw=new Float32Array(71721*3),min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
  for(let i=0;i<raw.length;i++){const v=view.getFloat32(i*4,true);if(!Number.isFinite(v))throw new Error('Invalid coordinate');raw[i]=v;min[i%3]=Math.min(min[i%3],v);max[i%3]=Math.max(max[i%3],v);}
  const center=min.map((v,i)=>(v+max[i])/2),scale=Math.max(...min.map((v,i)=>max[i]-v))/3.4;anatomy=new Float32Array(71721*4);
  for(let i=0;i<71721;i++){anatomy[i*4]=(raw[i*3]-center[0])/scale;anatomy[i*4+1]=(raw[i*3+1]-center[1])/scale+.25;anatomy[i*4+2]=(raw[i*3+2]-center[2])/scale;anatomy[i*4+3]=-1;}
  setGeometry('anatomy');
 }catch(err){$('geometry-note').textContent='Anatomy could not load. Select the tab to retry.';ui.announce.textContent='Measured anatomy could not load. The population model remains available.';console.error(err);}
 finally{loadingAnatomy=false;$('view-anatomy').textContent='ZAPBench anatomy';}
});
function download(name,content,type){const url=URL.createObjectURL(new Blob([content],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);ui.announce.textContent='Recent session data downloaded.';}
$('export-json').addEventListener('click',()=>download('zebrafish-neural-experiment.json',JSON.stringify({schemaVersion:2,modelVersion:MODEL_VERSION,createdAt:new Date().toISOString(),config:state.config,dtSeconds:DT,sampleIntervalSeconds:.1,durationSeconds:state.time,totalSteps:session.steps,recording:session.recordingWindow(),units:{rates:'dimensionless 0–1',position:'normalized arena',time:'s',heading:'rad'},provenance:{dynamics:'synthetic population model; not fitted to biological activity',retina:'synthetic arena luminance',anatomy:'ZAPBench measured centroids in separate viewer only; not used by dynamics'},samples},null,2),'application/json'));
$('export-csv').addEventListener('click',()=>download('zebrafish-neural-activity.csv',csv(samples),'text/csv;charset=utf-8'));
new ResizeObserver(()=>{drawArena();drawTrace();}).observe($('arena'));
new ResizeObserver(drawTrace).observe($('trace'));
document.addEventListener('visibilitychange',()=>{session.setHidden(document.hidden);syncControls();});
// Show actual simulated activity first. Measured anatomy remains a separate, optional view.
setGeometry('model');renderRetina(state);syncControls();update();requestAnimationFrame(animate);
