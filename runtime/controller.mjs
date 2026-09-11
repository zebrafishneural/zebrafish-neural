import {makeState,step,snapshot,DT,clamp,MODEL_VERSION,RETINA_WIDTH as W,RETINA_HEIGHT as H} from '../dist/lib/model.js';

export const ADAPTER_VERSION='zebrafish-browser-0.1.0';
export const FRAME_STALE_MS=4000;
export const VIEWPORT={width:1120,height:700};

// Signed heading sets the retinal orientation. Contrast, not white-page brightness,
// drives the existing population equations. Gains are engineering parameters.
export function sampleRetina(gray,width,height,cursor){
 const pixels=new Float32Array(W*H),contrast=new Float32Array(W*H);
 const forward={x:Math.cos(cursor.heading),y:Math.sin(cursor.heading)};
 const right={x:-forward.y,y:forward.x};
 const at=(x,y)=>gray[Math.round(clamp(y,0,height-1))*width+Math.round(clamp(x,0,width-1))]/255;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  const side=((x+.5)/W-.5)*320, ahead=(1-(y+.5)/H)*200-35;
  pixels[y*W+x]=at(cursor.x*width+right.x*side+forward.x*ahead,cursor.y*height+right.y*side+forward.y*ahead);
 }
 let left=0,rightSum=0,center=0,centerN=0;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){
  let sum=0,n=0;
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
   sum+=pixels[clamp(y+dy,0,H-1)*W+clamp(x+dx,0,W-1)];n++;
  }
  const edge=Math.abs(pixels[y*W+x]-sum/n);contrast[y*W+x]=edge;
  if(x<W/2)left+=edge;else rightSum+=edge;
  if(x>=13&&x<=18){center+=edge;centerN++;}
 }
 return {pixels,contrast,features:{left:clamp(left/(W*H/2)*6),right:clamp(rightSum/(W*H/2)*6),center:clamp(center/centerN*4),threat:0}};
}

export class BrowserController{
 constructor(saved){
  this.state=makeState({inputSource:'browser',mode:'dark',intensity:1});
  if(saved&&saved.adapterVersion===ADAPTER_VERSION&&Array.isArray(saved.rates)&&saved.rates.length===8&&saved.rates.every(v=>Number.isFinite(v)&&v>=0&&v<=1)&&Number.isFinite(saved.time)&&saved.time>=0&&['x','y','heading','speed','turn'].every(k=>Number.isFinite(saved.fish?.[k]))&&saved.fish.x>=.045&&saved.fish.x<=.955&&saved.fish.y>=.055&&saved.fish.y<=.945){
   this.state.rates.set(saved.rates);this.state.time=saved.time;this.state.fish={...saved.fish};
  }
  this.frameAt=0;this.frameId=0;this.steps=Number.isSafeInteger(saved?.steps)&&saved.steps>=0?saved.steps:0;this.accumulator=0;this.samples=[];this.dwell=0;this.lastClick=Number.isFinite(saved?.lastClick)&&saved.lastClick<=this.state.time?saved.lastClick:-Infinity;
 }
 observe(gray,width,height,now=Date.now(),frameId=this.frameId+1,appliedCursor=this.state.fish){
  const input=sampleRetina(gray,width,height,appliedCursor);
  this.state.retina.set(input.pixels);this.state.features=input.features;this.frameAt=now;this.frameId=frameId;
  return input;
 }
 advance(elapsed,now=Date.now(),outputsEnabled=true){
  if(!Number.isFinite(elapsed)||elapsed<0)throw new RangeError('Elapsed time must be finite and non-negative');
  if(!this.frameAt||now-this.frameAt>FRAME_STALE_MS){this.accumulator=0;this.dwell=0;return null;}
  this.accumulator+=Math.min(.1,elapsed);
  while(this.accumulator+1e-12>=DT){
   const previous={...this.state.fish};step(this.state,DT);
   if(!outputsEnabled)this.state.fish=previous;
   this.accumulator=Math.max(0,this.accumulator-DT);this.steps++;
   if(this.steps%5===0){this.samples.push({...snapshot(this.state),frameId:this.frameId});if(this.samples.length>600)this.samples.shift();}
   const r=this.state.rates;
   this.dwell=outputsEnabled&&this.state.features.center>.06&&r[7]>.025&&Math.abs(r[6]-r[5])<.08?this.dwell+DT:0;
  }
  if(!outputsEnabled)return null;
  const click=this.dwell>=1.2&&this.state.time-this.lastClick>=8;
  if(click){this.lastClick=this.state.time;this.dwell=0;}
  return {x:this.state.fish.x*VIEWPORT.width,y:this.state.fish.y*VIEWPORT.height,heading:this.state.fish.heading,click,frameId:this.frameId,modelTime:this.state.time};
 }
 checkpoint(){return {adapterVersion:ADAPTER_VERSION,modelVersion:MODEL_VERSION,time:this.state.time,rates:Array.from(this.state.rates),fish:{...this.state.fish},steps:this.steps,lastClick:Number.isFinite(this.lastClick)?this.lastClick:null};}
}
