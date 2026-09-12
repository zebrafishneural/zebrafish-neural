import * as THREE from '../vendor/three.module.js';
import {OrbitControls} from '../vendor/OrbitControls.js';
import {createFish} from './fish-model.js';

const DIRECTIONS={oblique:[-3,2.6,9.1],side:[0,.1,9.8],top:[0,9.8,.025]};
const finite=value=>typeof value==='number'&&Number.isFinite(value);

/**
 * A rendering-only zebrafish view. It never generates controller activity.
 * Advancing input time permits 1.5 seconds of smooth artistic body motion with
 * held actual rates. Repeated timestamps never extend that freshness window.
 * Camera interaction remains available when the supplied controller is paused.
 */
export class FishView {
  constructor(canvas,{mode='body',interactive=true}={}) {
    if(!canvas||typeof canvas.getContext!=='function')throw new TypeError('FishView requires a canvas element.');
    if(mode!=='body'&&mode!=='neural')throw new RangeError('Fish mode must be body or neural.');
    this.canvas=canvas;
    this.interactive=Boolean(interactive);
    this._active=true;
    this._disposed=false;
    this._contextLost=false;
    this._sized=false;
    this._raf=0;
    this._dirty=true;
    this._pendingState=true;
    this._clockReset=true;
    this._lastAppliedTime=null;
    this._lastReceivedTime=null;
    this._freshUntil=0;
    this._lastFrameAt=null;
    this._poseTime=0;
    this._view='oblique';
    this._interacting=false;
    this._state={rates:Array(8).fill(0),drive:0,turn:0,time:0,paused:true};
    this._ownedGeometries=new Set();
    this._ownedMaterials=new Set();
    this._ownedTextures=new Set();
    this._frame=this._frame.bind(this);
    this._resize=this._resize.bind(this);
    this._controlChange=()=>{this._dirty=true;this._schedule();};
    this._controlStart=()=>{this._interacting=true;this._dirty=true;this._schedule();};
    this._controlEnd=()=>{this._interacting=false;this._schedule();};
    this._visibility=()=>{
      this._clockReset=true;this._lastFrameAt=null;
      if(document.hidden)this._cancel();
      else {this._pendingState=true;this._dirty=true;this._schedule();}
    };
    this._lost=event=>{event.preventDefault();this._contextLost=true;this._cancel();};
    this._restored=()=>{this._contextLost=false;this._clockReset=true;this._lastFrameAt=null;this._pendingState=true;this._dirty=true;this._resize();this._schedule();};
    try {
      this._setup();
      this.fish.setMode(mode);
      this.mode=mode;
      this.controls.addEventListener('change',this._controlChange);
      this.controls.addEventListener('start',this._controlStart);
      this.controls.addEventListener('end',this._controlEnd);
      this._observer=new ResizeObserver(this._resize);
      this._observer.observe(canvas.parentElement||canvas);
      this._observer.observe(canvas);
      document.addEventListener('visibilitychange',this._visibility);
      window.addEventListener('resize',this._resize);
      canvas.addEventListener('webglcontextlost',this._lost,false);
      canvas.addEventListener('webglcontextrestored',this._restored,false);
      this._resize();
      this.setView('oblique');
    } catch(error) {
      this.dispose();
      throw new Error('The zebrafish viewer could not initialize WebGL 2.',{cause:error});
    }
  }

  _setup() {
    this.renderer=new THREE.WebGLRenderer({canvas:this.canvas,antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.setClearColor(0xffffff,1);
    this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure=.94;
    this.scene=new THREE.Scene();
    this.camera=new THREE.PerspectiveCamera(37,1,.05,80);
    this.controls=new OrbitControls(this.camera,this.canvas);
    this.controls.enabled=this.interactive;
    this.controls.enableDamping=true;
    this.controls.dampingFactor=.065;
    this.controls.enablePan=false;
    this.controls.minDistance=4;
    this.controls.maxDistance=22;
    this.controls.minPolarAngle=.02;
    this.controls.maxPolarAngle=Math.PI-.1;
    this.controls.target.set(.1,.05,0);
    this.scene.add(new THREE.HemisphereLight(0xe6f4ff,0x6a7483,1.6));
    for(const [hex,intensity,position] of [[0xfff9ed,2.1,[-3,5,7]],[0xcfe8ff,2,[4,3,-4]],[0xffffff,.8,[-7,0,2]]]) {
      const light=new THREE.DirectionalLight(hex,intensity);light.position.set(...position);this.scene.add(light);
    }

    // Geometry-lit studio reflection, copied from the successful body study.
    const room=new THREE.Scene();room.background=new THREE.Color(0xc9d5de);
    room.add(new THREE.Mesh(new THREE.BoxGeometry(30,30,30),new THREE.MeshBasicMaterial({color:0xdde6ee,side:THREE.BackSide})));
    for(const [x,y,z,sx,sy,sz,intensity] of [[-5,5,5,5,2,4,5],[5,4,-4,3,5,3,3],[-7,0,0,1,5,4,1.5]]) {
      const panel=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),new THREE.MeshBasicMaterial({color:new THREE.Color(intensity,intensity,intensity)}));panel.position.set(x,y,z);room.add(panel);
    }
    const pmrem=new THREE.PMREMGenerator(this.renderer);
    try {this._environment=pmrem.fromScene(room,.04);this.scene.environment=this._environment.texture;this.scene.environmentIntensity=.85;}
    finally {pmrem.dispose();room.traverse(item=>{item.geometry?.dispose();item.material?.dispose();});}

    this.fish=createFish(THREE);this.scene.add(this.fish.group);
    const grid=new THREE.GridHelper(20,40,0xdce5e6,0xf0f3f3);grid.position.y=-1.12;
    const gridMaterials=Array.isArray(grid.material)?grid.material:[grid.material];
    for(const material of gridMaterials){material.transparent=true;material.opacity=.46;this._ownedMaterials.add(material);}
    this._ownedGeometries.add(grid.geometry);this.scene.add(grid);
    const shadowCanvas=document.createElement('canvas');shadowCanvas.width=128;shadowCanvas.height=128;
    const context=shadowCanvas.getContext('2d');
    if(context) {
      const gradient=context.createRadialGradient(64,64,4,64,64,64);gradient.addColorStop(0,'rgba(50,75,85,.15)');gradient.addColorStop(1,'rgba(50,75,85,0)');context.fillStyle=gradient;context.fillRect(0,0,128,128);
      const texture=new THREE.CanvasTexture(shadowCanvas),geometry=new THREE.PlaneGeometry(7.5,2.5),material=new THREE.MeshBasicMaterial({map:texture,transparent:true,depthWrite:false});
      this._ownedTextures.add(texture);this._ownedGeometries.add(geometry);this._ownedMaterials.add(material);
      const shadow=new THREE.Mesh(geometry,material);shadow.rotation.x=-Math.PI/2;shadow.position.set(0,-1.1,0);this.scene.add(shadow);
    }
  }

  _schedule() {
    if(this._disposed||!this._active||this._contextLost||document.hidden||!this._sized||this._raf)return;
    this._raf=requestAnimationFrame(this._frame);
  }
  _cancel() {if(this._raf){cancelAnimationFrame(this._raf);this._raf=0;}}
  _frame(now=performance.now()) {
    this._raf=0;
    if(this._disposed||!this._active||this._contextLost||document.hidden||!this._sized)return;
    const dt=this._lastFrameAt===null?0:Math.max(0,Math.min(.05,(now-this._lastFrameAt)/1000));
    this._lastFrameAt=now;
    const animate=!this._state.paused&&this._freshUntil>now;
    if(this._pendingState||animate) {
      if(animate&&!this._clockReset)this._poseTime+=dt;
      this.fish.update({...this._state,time:this._poseTime,paused:!animate||this._clockReset});
      this._lastAppliedTime=this._state.time;
      this._pendingState=false;this._clockReset=false;this._dirty=true;
    }
    const changed=this.controls.update();
    if(this._dirty||changed){this.renderer.render(this.scene,this.camera);this._dirty=false;}
    // Body motion is an artistic display of held real outputs, not interpolated
    // telemetry. Stale packets stop this loop; camera damping remains available.
    if(animate||changed||this._interacting)this._schedule();
  }

  _fitDistance() {
    const tan=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2));
    const horizontal=this._view==='top'?6.8:6.7;
    return Math.max(5.7,horizontal/(2*tan*this.camera.aspect*.82));
  }
  _resize() {
    if(this._disposed||!this.renderer)return;
    const rect=this.canvas.getBoundingClientRect(),width=Math.round(rect.width),height=Math.round(rect.height);
    if(width<=0||height<=0){this._sized=false;this._cancel();return;}
    const ratio=Math.min(window.devicePixelRatio||1,1.5);
    if(width===this._width&&height===this._height&&ratio===this._ratio)return;
    const oldFit=this._sized?this._fitDistance():null;
    this._width=width;this._height=height;this._ratio=ratio;this._sized=true;
    this.renderer.setPixelRatio(ratio);this.renderer.setSize(width,height,false);
    this.camera.aspect=width/height;this.camera.fov=width<600?45:37;this.camera.updateProjectionMatrix();
    if(oldFit) {
      // Keep an operator's orbit and zoom proportion when a card resizes.
      const offset=this.camera.position.clone().sub(this.controls.target);
      if(offset.lengthSq()>0)this.camera.position.copy(this.controls.target).add(offset.multiplyScalar(this._fitDistance()/oldFit));
    }
    this.controls.maxDistance=Math.max(22,this._fitDistance()*2.2);
    this.controls.update();this._dirty=true;this._schedule();
  }

  setMode(mode) {
    if(this._disposed)return;
    if(mode!=='body'&&mode!=='neural')throw new RangeError('Fish mode must be body or neural.');
    this.fish.setMode(mode);this.mode=mode;this._dirty=true;this._schedule();
  }
  setState(state) {
    if(this._disposed)return;
    if(!state||!Array.isArray(state.rates)||state.rates.length!==8||!Array.from(state.rates).every(value=>finite(value)&&value>=0&&value<=1)||!finite(state.drive)||!finite(state.turn)||!finite(state.time)||state.time<0||state.paused!==undefined&&typeof state.paused!=='boolean')throw new TypeError('FishView expects eight finite normalized rates, drive, turn, model time, and an optional boolean paused flag.');
    const next={rates:[...state.rates],drive:Math.max(0,Math.min(1,state.drive)),turn:state.turn,time:state.time,paused:state.paused??false};
    const advancing=this._lastReceivedTime===null?next.time>0:next.time>this._lastReceivedTime;
    if(this._lastReceivedTime!==null&&next.time<this._lastReceivedTime){this._clockReset=true;this._lastFrameAt=null;this._freshUntil=0;}
    this._lastReceivedTime=next.time;
    if(next.paused)this._freshUntil=0;
    else if(advancing)this._freshUntil=performance.now()+1500;
    if(next.time===this._state.time&&next.drive===this._state.drive&&next.turn===this._state.turn&&next.paused===this._state.paused&&next.rates.every((value,index)=>value===this._state.rates[index]))return;
    this._state=next;
    this._pendingState=true;this._schedule();
  }
  setActive(active) {
    if(this._disposed)return;
    const next=Boolean(active);if(next===this._active)return;
    this._active=next;this._interacting=false;this._clockReset=true;this._lastFrameAt=null;
    this.controls.enabled=this.interactive&&next;
    if(!next)this._cancel();
    else {this._pendingState=true;this._dirty=true;this._resize();this._schedule();}
  }
  setView(view) {
    if(this._disposed)return;
    if(!Object.hasOwn(DIRECTIONS,view))throw new RangeError('Fish view must be oblique, side, or top.');
    this._view=view;
    this.controls.target.set(.1,.05,0);
    this.camera.position.set(...DIRECTIONS[view]).normalize().multiplyScalar(this._fitDistance()).add(this.controls.target);
    this.camera.lookAt(this.controls.target);this.controls.update();this._dirty=true;this._schedule();
  }
  resetView() {this.setView('oblique');}
  dispose() {
    if(this._disposed)return;this._disposed=true;this._cancel();
    this._observer?.disconnect();
    document.removeEventListener('visibilitychange',this._visibility);
    window.removeEventListener('resize',this._resize);
    this.canvas.removeEventListener('webglcontextlost',this._lost,false);
    this.canvas.removeEventListener('webglcontextrestored',this._restored,false);
    if(this.controls) {
      this.controls.removeEventListener('change',this._controlChange);this.controls.removeEventListener('start',this._controlStart);this.controls.removeEventListener('end',this._controlEnd);this.controls.dispose();
    }
    this.fish?.dispose();
    for(const geometry of this._ownedGeometries)geometry.dispose();
    for(const material of this._ownedMaterials)material.dispose();
    for(const texture of this._ownedTextures)texture.dispose();
    this._environment?.dispose();
    this.scene?.clear();
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
  }
}

export default FishView;
