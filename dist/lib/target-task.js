import {makeState, step, snapshot, DT, MODEL_VERSION, clamp} from './model.js';

export const TASK_VERSION='target-task-0.1.0';
export const DURATION=30, CONTACT_RADIUS=.065, INTENSITY=.85;
export const PROTOCOLS={reach:'Target reaching',reversal:'Target reversal',occlusion:'Visual interruption'};
export const TARGETS=[{x:.25,y:.25},{x:.75,y:.25},{x:.5,y:.22},{x:.2,y:.4},{x:.8,y:.4},{x:.35,y:.18},{x:.65,y:.18},{x:.5,y:.35}];

// The task owns stimuli and scoring. Only model.js computes motor output and movement.
export class Session {
  constructor(){this.reset();}
  reset(){
    this.id=globalThis.crypto.randomUUID();this.startedAt=new Date().toISOString();
    this.records=[];this.events=[];this.protocolCounts={reach:0,reversal:0,occlusion:0};
    this.counter=0;this.protocol='reach';this.start('reach');
  }
  log(kind,detail){this.events.push({trial:this.counter,t:+this.state.time.toFixed(3),kind,detail});}
  start(protocol=this.protocol){
    if(!Object.hasOwn(PROTOCOLS,protocol))throw Error('Unknown protocol');
    this.protocol=protocol;
    const index=this.protocolCounts[protocol]++%TARGETS.length;
    this.state=makeState({mode:'light-left',inputSource:'synthetic',intensity:INTENSITY});
    this.state.target={...TARGETS[index]};
    this.counter++;this.targetIndex=index;this.initialTarget={...this.state.target};
    this.path=0;this.trace=[];this.samples=[];this.manual=false;this.manualHidden=false;
    this.reversed=false;this.hidden=false;this.finished=false;this.result=null;
    this.closest=Infinity;this.sampleSteps=0;this.lastInputPosition={...this.state.fish};
    this.log('start',`${PROTOCOLS[protocol]}; target ${index+1}`);
    this.sample();
  }
  sample(){
    const s={...snapshot(this.state),target:{...this.state.target},visible:!this.hidden,path:this.path};
    this.samples.push(s);this.trace.push({x:s.x,y:s.y});
  }
  next(protocol=this.protocol){
    if(!this.finished)this.finish('Interrupted');
    this.start(protocol);
  }
  moveTarget(x,y){
    if(this.finished)this.start(this.protocol);
    this.state.target={x:clamp(x,.1,.9),y:clamp(y,.1,.85)};
    this.manual=true;this.closest=Infinity;
    this.log('intervention',`Target moved to ${this.state.target.x.toFixed(3)}, ${this.state.target.y.toFixed(3)}`);
  }
  toggleInput(){
    if(this.finished)this.start(this.protocol);
    this.manualHidden=!this.manualHidden;this.manual=true;
    this.log('intervention',this.manualHidden?'Stimulus hidden by observer':'Stimulus restored by observer');
  }
  tick(){
    if(this.finished)return;
    const t=this.state.time;
    if(this.protocol==='reversal'&&!this.reversed&&t>=4-1e-9){
      // A scheduled stimulus change, not a controller decision.
      this.state.target.x=1-this.state.target.x;
      if(Math.abs(this.state.target.x-.5)<.01)this.state.target.x=.8;
      this.reversed=true;this.closest=Infinity;
      this.log('stimulus','Target changed position at 4 model seconds');
    }
    const hidden=this.manualHidden||(this.protocol==='occlusion'&&t>=3-1e-9&&t<8-1e-9);
    if(hidden!==this.hidden){this.hidden=hidden;this.log('stimulus',hidden?'Visual input off':'Visual input on');}
    this.state.config.mode=hidden?'dark':'light-left';
    const previous={...this.state.fish};this.lastInputPosition=previous;
    step(this.state,DT);
    this.path+=Math.hypot(this.state.fish.x-previous.x,this.state.fish.y-previous.y);
    const distance=Math.hypot(this.state.fish.x-this.state.target.x,this.state.fish.y-this.state.target.y);
    this.closest=Math.min(this.closest,distance);
    this.sampleSteps++;
    if(this.sampleSteps%5===0)this.sample();
    if(distance<=CONTACT_RADIUS+1e-12&&(this.protocol!=='reversal'||this.reversed))this.finish('Reached');
    else if(this.state.time>=DURATION-1e-9)this.finish('Timed out');
  }
  finish(result){
    if(this.finished)return;
    this.finished=true;this.result=result;this.sample();
    this.log('result',result);
    const record={trial:this.counter,protocol:this.protocol,targetIndex:this.targetIndex,
      initialTarget:{...this.initialTarget},finalTarget:{...this.state.target},result,
      standard:!this.manual&&result!=='Interrupted',input:this.manual?'Observer intervention':this.protocol==='occlusion'?'Off at 3–8 s':'On',
      duration:+this.state.time.toFixed(3),firstContactSeconds:result==='Reached'?+this.state.time.toFixed(3):null,
      pathLength:this.path,closestDistance:Number.isFinite(this.closest)?this.closest:null,
      samples:this.samples.slice()};
    this.records.push(record);
  }
  summary(){
    const trials=this.records.filter(r=>r.protocol===this.protocol&&r.standard);
    const hits=trials.filter(r=>r.result==='Reached');
    return {completed:trials.length,reached:hits.length,meanContactSeconds:hits.length?hits.reduce((s,r)=>s+r.firstContactSeconds,0)/hits.length:null};
  }
  export(){
    return {schemaVersion:1,taskVersion:TASK_VERSION,sessionId:this.id,startedAt:this.startedAt,exportedAt:new Date().toISOString(),
      model:{version:MODEL_VERSION,source:'zebrafish-neural/dist/lib/model.js',trained:false,
        states:8,input:'Synthetic 32 × 16 Gaussian retinal stimulus, derived from virtual target bearing and distance; not browser screenshot contrast.'},
      settings:{dtSeconds:DT,intensity:INTENSITY,trialLimitSeconds:DURATION,contactRadius:CONTACT_RADIUS,
        initialState:{x:.5,y:.75,heading:-Math.PI/2,rates:[0,0,0,0,0,0,0,0]},
        targets:TARGETS,reversalAtSeconds:4,occlusionSeconds:[3,8],
        observerInterventions:'Recorded; excluded from standard success counts',
        units:{position:'normalized arena coordinates',path:'normalized arena units',rates:'normalized 0–1',time:'model seconds',turn:'radians / model second'},
        sampling:'Every 0.1 model seconds plus start and finish; hidden browser pauses model time'},
      trials:this.records,events:this.events,
      current:this.finished?null:{trial:this.counter,protocol:this.protocol,manual:this.manual,hidden:this.hidden,samples:this.samples,snapshot:snapshot(this.state),target:{...this.state.target}},
      limitations:['Local browser simulation; not connected to the shared controller stream.','Fixed coefficients; no learning or biological validation.','Synthetic retinal input differs from the Wikipedia screenshot adapter.','Contact scoring uses task coordinates; target coordinates never directly set model position or motor output.']};
  }
}
