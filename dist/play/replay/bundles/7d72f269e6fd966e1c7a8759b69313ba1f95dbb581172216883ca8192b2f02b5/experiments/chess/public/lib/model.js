/** Zebrafish Neural population model v0.1. Continuous, unitless rates; not measured spikes. */
export const MODEL_VERSION = 'zebra-rate-0.1.0';
export const DT = 0.02;
export const RETINA_WIDTH = 32;
export const RETINA_HEIGHT = 16;
export const REGIONS = [
  {id:'visualL',name:'Visual L',short:'Visual',side:'L',tau:.12},
  {id:'visualR',name:'Visual R',short:'Visual',side:'R',tau:.12},
  {id:'integratorL',name:'Integrator L',short:'Integrator',side:'L',tau:.45},
  {id:'integratorR',name:'Integrator R',short:'Integrator',side:'R',tau:.45},
  {id:'gain',name:'Shared drive',short:'Shared drive',side:'',tau:.2},
  {id:'motorL',name:'Motor L',short:'Motor',side:'L',tau:.14},
  {id:'motorR',name:'Motor R',short:'Motor',side:'R',tau:.14},
  {id:'spinal',name:'Spinal drive',short:'Spinal',side:'',tau:.12}
];
export const MODES = {
  'light-left':{label:'Light · left',target:{x:.2,y:.22}},
  'light-right':{label:'Light · right',target:{x:.8,y:.22}},
  'moving-dot':{label:'Moving target',target:{x:.5,y:.22}},
  'looming':{label:'Looming shadow',target:{x:.35,y:.22}},
  'dark':{label:'No stimulus',target:{x:.5,y:.22}}
};
export const clamp=(v,lo=0,hi=1)=>Math.max(lo,Math.min(hi,v));
export const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
export function makeState(config={}) {
  const mode=Object.hasOwn(MODES,config.mode)?config.mode:'light-left';
  return {time:0,rates:new Float64Array(8),fish:{x:.5,y:.75,heading:-Math.PI/2,speed:0,turn:0},
    config:{mode,intensity:clamp(Number.isFinite(config.intensity)?config.intensity:.7),inputSource:config.inputSource==='browser'?'browser':'synthetic'},
    target:{...MODES[mode].target},retina:new Float32Array(RETINA_WIDTH*RETINA_HEIGHT),
    features:{left:0,right:0,center:0,threat:0},distance:0};
}
export function getTarget(state) {
  return state.config.mode==='moving-dot'?{x:.5+.28*Math.sin(state.time*.55),y:.22}:state.target;
}
/** A synthetic pinhole-like retinal image. No browser screenshots or live camera input. */
export function renderRetina(state){
  const {mode,intensity}=state.config, target=getTarget(state),fish=state.fish;
  const bearing=wrap(Math.atan2(target.y-fish.y,target.x-fish.x)-fish.heading);
  const distance=Math.max(.04,Math.hypot(target.x-fish.x,target.y-fish.y));
  const shadow=mode==='looming';
  const envelope=shadow?clamp((3-state.time)/.7):1;
  const radius=shadow?.10+.48*clamp(state.time/1.5):clamp(.048/distance,.07,.36);
  const baseline=shadow?.78:.05;
  const centerX=bearing/1.45,centerY=0;
  let left=0,right=0,center=0;
  for(let y=0;y<RETINA_HEIGHT;y++)for(let x=0;x<RETINA_WIDTH;x++){
    const px=(x+.5)/RETINA_WIDTH*2-1, py=(y+.5)/RETINA_HEIGHT*2-1;
    const d2=(px-centerX)**2+(py*.65-centerY)**2;
    const shape=Math.exp(-d2/(2*radius*radius));
    const contrast=(mode==='dark'?0:intensity*envelope*shape);
    const luminance=clamp(baseline+(shadow?-1:1)*contrast);
    state.retina[y*RETINA_WIDTH+x]=luminance;
    const feature=shadow?baseline-luminance:luminance-baseline;
    if(x<RETINA_WIDTH/2)left+=feature;else right+=feature;
    if(Math.abs(px)<.16)center+=feature;
  }
  const count=RETINA_WIDTH*RETINA_HEIGHT;
  state.features={left:clamp(left/count*19),right:clamp(right/count*19),center:clamp(center/count*9),threat:shadow?clamp((left+right)/count*5):0};
  return state.retina;
}
export function step(state,dt=DT){
  if(!Number.isFinite(dt)||dt<=0||dt>.05)throw new RangeError('dt must be in (0, 0.05] seconds');
  if(state.config.inputSource!=='browser')renderRetina(state);
  const r=state.rates,f=state.features;
  const escape=f.threat;
  // Designer-selected aversive routing. This rule is not inferred from a fish connectome.
  const aversive=state.config.inputSource!=='browser'&&state.config.mode==='looming';
  const go=1-.7*f.center*(1-escape);
  const drive=[f.left,f.right,.50*r[0],.50*r[1],.45*(r[0]+r[1]),
    go*(aversive?1.8*r[1]:r[0])+.12*(aversive?r[3]:r[2])+.08*r[4],
    go*(aversive?1.8*r[0]:r[1])+.12*(aversive?r[2]:r[3])+.08*r[4],
    .55*(r[5]+r[6])+.25*escape];
  for(let i=0;i<8;i++)r[i]=clamp(r[i]+dt/REGIONS[i].tau*(clamp(drive[i]+.10*r[i])-r[i]));
  const fish=state.fish;
  fish.turn=3.2*(r[6]-r[5]);
  fish.heading=wrap(fish.heading+fish.turn*dt);
  fish.speed=.15*r[7];
  const nextX=fish.x+Math.cos(fish.heading)*fish.speed*dt;
  const nextY=fish.y+Math.sin(fish.heading)*fish.speed*dt;
  if(nextX<.045||nextX>.955)fish.heading=wrap(Math.PI-fish.heading);
  if(nextY<.055||nextY>.945)fish.heading=wrap(-fish.heading);
  fish.x=clamp(nextX,.045,.955);fish.y=clamp(nextY,.055,.945);
  state.distance+=fish.speed*dt;
  state.time+=dt;
  return state;
}
export function snapshot(state){return {t:Number(state.time.toFixed(3)),x:state.fish.x,y:state.fish.y,heading:state.fish.heading,speed:state.fish.speed,turn:state.fish.turn,rates:Array.from(state.rates),features:{...state.features}};}
export function experiment(config,duration=6){const state=makeState(config);for(let i=0;i<Math.round(duration/DT);i++)step(state);return state;}
export function csv(samples){
  const header=['time_s','x_arena','y_arena','heading_rad','speed_arena_per_s','turn_rad_per_s',...REGIONS.map(r=>r.id+'_rate')];
  const rows=samples.map(s=>[s.t,s.x,s.y,s.heading,s.speed,s.turn,...s.rates].map(v=>Number(v).toFixed(6)).join(','));
  return [header.join(','),...rows].join('\n');
}
