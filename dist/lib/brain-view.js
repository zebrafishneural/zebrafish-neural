const GROUPS=[
 [-.67,-.15,0,.39,.61,.32], [.67,-.15,0,.39,.61,.32],
 [-.3,-1.09,0,.29,.38,.29], [.3,-1.09,0,.29,.38,.29],
 [0,.5,.13,.57,.24,.23], [-.23,1.02,0,.27,.55,.23], [.23,1.02,0,.27,.55,.23], [0,1.76,0,.11,.28,.13]
];
function synthetic(){let seed=4517;const rand=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};const out=[];GROUPS.forEach((g,id)=>{for(let i=0;i<(id===7?180:720);i++){const u=rand()*2-1,a=rand()*Math.PI*2,r=Math.cbrt(rand()),s=Math.sqrt(1-u*u);out.push(g[0]+g[3]*r*s*Math.cos(a),g[1]+g[4]*r*u,g[2]+g[5]*r*s*Math.sin(a),id);}});return new Float32Array(out);}
export class BrainView {
 constructor(canvas,onView){
  this.canvas=canvas;this.gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true,preserveDrawingBuffer:true});
  this.yaw=-.16;this.pitch=.3;this.zoom=1;this.mode='model';this.data=synthetic();this.rates=new Float32Array(8);this.selected=-1;this.onView=onView;
  if(this.gl){
   try{this.setup();}catch(error){
    console.warn('WebGL is unavailable; using the canvas projection.',error);
    const replacement=canvas.cloneNode(false);canvas.replaceWith(replacement);canvas=replacement;
    this.canvas=canvas;this.gl=null;this.fallback=canvas.getContext('2d');
   }
  }else this.fallback=canvas.getContext('2d');
  let drag=null;
  canvas.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!drag)return;this.yaw+=(e.clientX-drag.x)*.008;this.pitch=Math.max(-1.3,Math.min(1.3,this.pitch+(e.clientY-drag.y)*.006));drag={x:e.clientX,y:e.clientY};this.draw();});
  canvas.addEventListener('pointerup',()=>drag=null);canvas.addEventListener('pointercancel',()=>drag=null);
  canvas.addEventListener('wheel',e=>{e.preventDefault();this.zoom=Math.max(.65,Math.min(2,this.zoom-e.deltaY*.001));this.draw();},{passive:false});
  canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','-'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')this.yaw-=.15;if(e.key==='ArrowRight')this.yaw+=.15;if(e.key==='ArrowUp')this.pitch-=.12;if(e.key==='ArrowDown')this.pitch+=.12;if(e.key==='+')this.zoom=Math.min(2,this.zoom+.1);if(e.key==='-')this.zoom=Math.max(.65,this.zoom-.1);this.draw();});
  new ResizeObserver(()=>this.resize()).observe(canvas);this.resize();
 }
 setup(){
  const gl=this.gl;
  const vertex=`precision mediump float;attribute vec4 point;uniform vec2 angle;uniform float aspect;uniform float zoom;uniform float ratio;uniform float rates[8];uniform float anatomy;uniform float selected;varying float activity;varying float depth;varying float chosen;
  void main(){vec3 p=point.xyz;p.y-=.25;float x=p.x*cos(angle.x)+p.z*sin(angle.x);float z=-p.x*sin(angle.x)+p.z*cos(angle.x);float y=p.y*cos(angle.y)-z*sin(angle.y);z=p.y*sin(angle.y)+z*cos(angle.y);float perspective=3.8/(3.8+z);gl_Position=vec4(x*.52*perspective*zoom/aspect,-y*.52*perspective*zoom,z*.08,1.);activity=0.;for(int i=0;i<8;i++){if(abs(point.w-float(i))<.1)activity=rates[i];}chosen=abs(point.w-selected)<.1?1.:0.;depth=clamp(.8-z*.23,.3,1.);gl_PointSize=(anatomy>.5?1.6:2.3+activity*1.8+chosen*.5)*ratio;}`;
  const fragment=`precision mediump float;uniform float anatomy;varying float activity;varying float depth;varying float chosen;void main(){float d=length(gl_PointCoord-.5);if(d>.5)discard;float halo=(1.-smoothstep(.08,.5,d));vec3 base=mix(vec3(.25,.62,.66),vec3(.45,1.,.87),activity);base=mix(base,vec3(1.,.73,.32),chosen*.7);if(anatomy>.5)base=vec3(.48,.68,.73);float alpha=(anatomy>.5?.34:.55+activity*.45+chosen*.14)*depth*halo;gl_FragColor=vec4(base,alpha);}`;
  const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;};
  this.program=gl.createProgram();gl.attachShader(this.program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(this.program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(this.program);if(!gl.getProgramParameter(this.program,gl.LINK_STATUS))throw new Error('3D shader link: '+gl.getProgramInfoLog(this.program));
  gl.useProgram(this.program);this.buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);gl.bufferData(gl.ARRAY_BUFFER,this.data,gl.STATIC_DRAW);
  const at=gl.getAttribLocation(this.program,'point');gl.enableVertexAttribArray(at);gl.vertexAttribPointer(at,4,gl.FLOAT,false,0,0);
  this.uniforms=Object.fromEntries(['angle','aspect','zoom','ratio','rates','anatomy','selected'].map(x=>[x,gl.getUniformLocation(this.program,x)]));gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.clearColor(0,0,0,0);
 }
 resize(){const rect=this.canvas.getBoundingClientRect();this.width=rect.width;this.height=rect.height;this.ratio=Math.min(window.devicePixelRatio||1,2);this.canvas.width=Math.round(rect.width*this.ratio);this.canvas.height=Math.round(rect.height*this.ratio);if(this.gl)this.gl.viewport(0,0,this.canvas.width,this.canvas.height);this.draw();}
 setData(data,mode){this.mode=mode;this.data=data||synthetic();if(this.gl){this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.buffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,this.data,this.gl.STATIC_DRAW);}this.draw();}
 setRates(rates){this.rates.set(rates);this.draw();}
 reset(){this.yaw=-.16;this.pitch=.3;this.zoom=1;this.draw();}
 select(index){this.selected=index;this.draw();}
 draw(){
  if(!this.width||!this.height)return;
  if(!this.gl){this.drawFallback();return;}
  const gl=this.gl,u=this.uniforms;gl.useProgram(this.program);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform2f(u.angle,this.yaw,this.pitch);gl.uniform1f(u.aspect,this.width/this.height);gl.uniform1f(u.zoom,this.zoom);gl.uniform1f(u.ratio,this.ratio);gl.uniform1fv(u.rates,this.rates);gl.uniform1f(u.anatomy,this.mode==='anatomy'?1:0);gl.uniform1f(u.selected,this.selected);gl.drawArrays(gl.POINTS,0,this.data.length/4);
 }
 drawFallback(){const c=this.fallback;if(!c)return;c.setTransform(this.ratio,0,0,this.ratio,0,0);c.clearRect(0,0,this.width,this.height);const s=this.height*.25*this.zoom;for(let i=0;i<this.data.length;i+=4){const a=this.rates[this.data[i+3]]||0;const x=this.data[i]*Math.cos(this.yaw)+this.data[i+2]*Math.sin(this.yaw);const y=this.data[i+1]*Math.cos(this.pitch);c.fillStyle=`rgba(91,222,200,${.18+.7*a})`;c.beginPath();c.arc(this.width/2+x*s,this.height/2+(y-.25)*s,1,0,Math.PI*2);c.fill();}}
}
