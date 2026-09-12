/**
 * Original procedural adult zebrafish study. Geometry is hand-parameterized,
 * anatomy-inspired artwork, not a scan, atlas, or reconstructed specimen.
 * Coordinates: head -X, caudal fin +X, dorsal +Y, bilateral sides +/-Z.
 */
export function createFish(THREE) {
  const group = new THREE.Group();
  group.name = 'Procedural adult zebrafish';
  const sculpture = new THREE.Group();
  group.add(sculpture);
  const deformables = [], materials = new Set(), geometries = new Set();
  const bodyMaterials = [], finMaterials = [], neuralNodes = [];
  const clamp = (n, lo=0, hi=1) => Math.max(lo, Math.min(hi, n));
  const smooth = (a,b,x) => {const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
  const color = hex => new THREE.Color(hex);
  const silver=color('#bbced3'), back=color('#678993'), belly=color('#e4e7da');
  const navy=color('#173d61'), deepNavy=color('#112f4c'), gold=color('#c4bf8d');

  // x, dorsal height, ventral depth, half-width. Independent contours create
  // a blunt cranium, full shoulder, tapered abdomen and narrow caudal peduncle.
  const sections = [
    [-2.83,.018,.012,.012],[-2.70,.12,.095,.087],[-2.46,.27,.21,.18],
    [-2.12,.40,.32,.26],[-1.65,.51,.40,.316],[-1.00,.55,.435,.334],
    [-.28,.50,.385,.307],[.42,.405,.295,.255],[1.06,.29,.195,.188],
    [1.60,.18,.12,.126],[1.99,.105,.083,.079],[2.20,.075,.067,.059]
  ];
  function profile(x) {
    let k=0;while(k<sections.length-2&&x>sections[k+1][0])k++;
    const a=sections[k], b=sections[k+1], t=clamp((x-a[0])/(b[0]-a[0]));
    return [1,2,3].map(axis=>{
      const prev=sections[Math.max(0,k-1)], next=sections[Math.min(sections.length-1,k+2)];
      const ma=(b[axis]-prev[axis])/(b[0]-prev[0]);
      const mb=(next[axis]-a[axis])/(next[0]-a[0]);
      return (2*t*t*t-3*t*t+1)*a[axis]+(t*t*t-2*t*t+t)*(b[0]-a[0])*ma+(-2*t*t*t+3*t*t)*b[axis]+(t*t*t-t*t)*(b[0]-a[0])*mb;
    });
  }
  function skinPoint(x,q,side=1,offset=0) {
    const [up,down,width]=profile(x), y=q*(q>=0?up:down);
    return new THREE.Vector3(x,y,side*(width*Math.sqrt(Math.max(0,1-q*q))+offset));
  }
  function ownMaterial(material) {materials.add(material);return material;}
  function ownGeometry(geometry) {geometries.add(geometry);return geometry;}
  function dynamic(geometry,{fin=0,side=0,anchorY=0,anchorZ=0}={}) {
    ownGeometry(geometry);
    geometry.computeBoundingSphere();
    const positions=geometry.attributes.position;
    positions.setUsage(THREE.DynamicDrawUsage);
    const entry={geometry,rest:positions.array.slice(),normals:geometry.attributes.normal?.array.slice(),fin,side,anchorY,anchorZ};
    if(geometry.attributes.normal)geometry.attributes.normal.setUsage(THREE.DynamicDrawUsage);
    deformables.push(entry);
    return geometry;
  }
  function mesh(geometry,material,name,parent=sculpture) {
    const item=new THREE.Mesh(geometry,material);item.name=name;item.castShadow=true;item.receiveShadow=true;item.frustumCulled=false;parent.add(item);return item;
  }
  function lineGeometry(points) {
    const g=new THREE.BufferGeometry().setFromPoints(points);
    return dynamic(g);
  }
  function curveLine(points,material,name,radius=0) {
    const curve=new THREE.CatmullRomCurve3(points);
    if(radius) return mesh(dynamic(new THREE.TubeGeometry(curve,32,radius,5,false)),material,name);
    const item=new THREE.Line(lineGeometry(curve.getPoints(64)),material);item.name=name;item.frustumCulled=false;sculpture.add(item);return item;
  }

  const axial=156, radial=144, positions=[], colors=[], indices=[];
  const shade=new THREE.Color(), band=new THREE.Color();
  for(let u=0;u<=axial;u++) {
    const x=sections[0][0]+(sections.at(-1)[0]-sections[0][0])*u/axial;
    const [upper,lower,width]=profile(x);
    for(let v=0;v<=radial;v++) {
      const theta=v/radial*Math.PI*2,q=Math.sin(theta), z=Math.cos(theta)*width;
      const y=q*(q>=0?upper:lower);
      positions.push(x,y,z);
      shade.copy(silver).lerp(q>0?back:belly,Math.abs(q)*(q>0?.45:.77));
      // Five longitudinal pigment bands follow the flank as it narrows. Small
      // curvature avoids a pasted-on rectangular stripe texture.
      const pigmentQ=q+.021*Math.sin((x+1.8)*1.9)*(1-Math.abs(q));
      let pigment=0;
      for(const center of [-.66,-.33,0,.33,.66]) {
        const d=Math.abs(pigmentQ-center);
        pigment=Math.max(pigment,1-smooth(.061,.082,d));
      }
      const flank=1-smooth(.84,.985,Math.abs(q));
      const start=smooth(-2.12,-1.52,x);
      band.copy(navy).lerp(deepNavy,.35+.15*Math.sin(x*1.4));
      shade.lerp(band,pigment*start*flank*.97);
      const scaleSheen=(Math.sin(x*49+Math.floor(v/5)*1.5)*Math.cos(theta*43))*.016;
      shade.multiplyScalar(1+scaleSheen);
      const lateral=(1-smooth(.009,.025,Math.abs(pigmentQ-.16)))*start;
      shade.lerp(gold,lateral*.28);
      colors.push(shade.r,shade.g,shade.b);
    }
  }
  for(let u=0;u<axial;u++)for(let v=0;v<radial;v++) {
    const a=u*(radial+1)+v,b=a+radial+1;
    indices.push(a,b,a+1,b,b+1,a+1);
  }
  // Close the tiny end rings without replacing the sculpted surface by solids.
  for(const row of [0,axial])for(let v=1;v<radial-1;v++) {
    const base=row*(radial+1);
    if(row===0)indices.push(base,base+v+1,base+v);else indices.push(base,base+v,base+v+1);
  }
  const bodyGeometry=new THREE.BufferGeometry();
  bodyGeometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
  bodyGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
  bodyGeometry.setIndex(indices);bodyGeometry.computeVertexNormals();
  const bodyMaterial=ownMaterial(new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,metalness:.28,roughness:.38,side:THREE.DoubleSide}));
  bodyMaterials.push(bodyMaterial);
  mesh(dynamic(bodyGeometry),bodyMaterial,'Pearlescent skin and five continuous flank bands');

  // Extremely quiet scale arcs catch the side light without a raster texture.
  const scales=[];
  for(const side of [-1,1])for(let row=0;row<9;row++)for(let column=0;column<27;column++) {
    const x=-1.75+column*.124+(row%2)*.059,q=-.68+row*.165;
    for(let segment=0;segment<4;segment++) {
      for(const a of [segment/4,(segment+1)/4]) {
        const angle=-1.05+a*2.1;
        scales.push(skinPoint(x+.065*Math.cos(angle),q+.065*Math.sin(angle),side,.0025));
      }
    }
  }
  const scaleMaterial=ownMaterial(new THREE.LineBasicMaterial({color:'#cfddd7',transparent:true,opacity:.12,depthWrite:false}));
  const scaleLines=new THREE.LineSegments(dynamic(new THREE.BufferGeometry().setFromPoints(scales)),scaleMaterial);
  scaleLines.name='Fine staggered scale margins';scaleLines.frustumCulled=false;sculpture.add(scaleLines);

  function fin(name,rootStart,rootEnd,outline,{tail=false,side=0,flutter=0,opacity=.47}={}) {
    const boundary=new THREE.CatmullRomCurve3(outline.map(p=>new THREE.Vector3(...p)),false,'catmullrom',.25);
    const rootA=new THREE.Vector3(...rootStart),rootB=new THREE.Vector3(...rootEnd);
    const rays=36,steps=10,p=[],c=[],faces=[],veins=[];
    const tint=color('#9fb6b9'),edge=color('#cbd8d2'),stripe=color('#35546b');
    function point(t,r) {
      const root=rootA.clone().lerp(rootB,t),tip=boundary.getPoint(t),point=root.lerp(tip,r);
      point.z+=Math.sin(Math.PI*r)*Math.sin(t*Math.PI)*.018*(side||1);
      return point;
    }
    for(let i=0;i<=rays;i++)for(let j=0;j<=steps;j++) {
      const t=i/rays,r=j/steps,pt=point(t,r);p.push(pt.x,pt.y,pt.z);
      shade.copy(tint).lerp(edge,r*.62);
      if(tail) {
        const pigment=1-smooth(.22,.43,Math.abs(Math.sin((pt.y+.014)*20.5)));
        shade.lerp(stripe,pigment*.85);
      } else shade.lerp(stripe,(1-r)*.3);
      c.push(shade.r,shade.g,shade.b);
    }
    for(let i=0;i<rays;i++)for(let j=0;j<steps;j++) {
      const a=i*(steps+1)+j,b=a+steps+1;faces.push(a,b,a+1,b,b+1,a+1);
    }
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.setAttribute('color',new THREE.Float32BufferAttribute(c,3));g.setIndex(faces);g.computeVertexNormals();
    const mat=ownMaterial(new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,transparent:true,opacity,roughness:.48,metalness:.06,side:THREE.DoubleSide,depthWrite:false}));
    finMaterials.push({material:mat,opacity});
    const movement={fin:flutter,side,anchorY:(rootA.y+rootB.y)/2,anchorZ:(rootA.z+rootB.z)/2};
    const sheet=mesh(dynamic(g,movement),mat,name+' translucent membrane');sheet.castShadow=false;sheet.renderOrder=2;
    for(let ray=0;ray<=18;ray++) {
      const t=ray/18;
      for(let j=0;j<12;j++){veins.push(point(t,j/12),point(t,(j+1)/12));}
      // Paired distal ray branches, visible mainly near the outer third.
      if(ray>0&&ray<18)for(const branch of [-1,1])for(let j=0;j<4;j++) {
        const r0=.64+j*.085,r1=.64+(j+1)*.085;
        veins.push(point(t+branch*(r0-.64)*.018,r0),point(t+branch*(r1-.64)*.018,r1));
      }
    }
    const rayMaterial=ownMaterial(new THREE.LineBasicMaterial({color:'#48657a',transparent:true,opacity:.45,depthWrite:false}));
    const rayLines=new THREE.LineSegments(dynamic(new THREE.BufferGeometry().setFromPoints(veins),movement),rayMaterial);rayLines.name=name+' segmented fin rays';rayLines.frustumCulled=false;rayLines.renderOrder=3;sculpture.add(rayLines);
    const rimMaterial=ownMaterial(new THREE.LineBasicMaterial({color:'#bbcbbf',transparent:true,opacity:.62,depthWrite:false}));
    const rim=new THREE.Line(dynamic(new THREE.BufferGeometry().setFromPoints(boundary.getPoints(100)),movement),rimMaterial);rim.name=name+' fine leading edge';rim.frustumCulled=false;sculpture.add(rim);
  }
  fin('Forked caudal fin',[2.09,.085,0],[2.09,-.068,0],[[2.16,.10,0],[2.65,.53,0],[3.19,.83,0],[3.28,.76,0],[3.02,.34,0],[2.77,.015,0],[3.02,-.34,0],[3.22,-.71,0],[3.10,-.76,0],[2.62,-.46,0],[2.17,-.08,0]],{tail:true,flutter:.12,opacity:.65});
  fin('Dorsal fin',[-.42,.49,0],[1.18,.26,0],[[-.40,.50,0],[-.29,.80,0],[.03,1.05,0],[.42,.97,0],[.79,.64,0],[1.16,.29,0]],{flutter:.07,opacity:.49});
  fin('Anal fin',[.14,-.33,0],[1.40,-.14,0],[[.14,-.35,0],[.30,-.65,0],[.62,-.93,0],[.82,-.76,0],[1.12,-.45,0],[1.42,-.15,0]],{flutter:.09,opacity:.47});
  for(const side of [-1,1]) {
    const sideName=side===-1?'Left':'Right';
    fin(sideName+' pectoral fin',[-1.87,-.09,side*.26],[-1.57,-.25,side*.26],[[-1.83,-.1,side*.27],[-1.41,-.08,side*.58],[-.95,-.33,side*.76],[-1.03,-.48,side*.60],[-1.58,-.26,side*.27]],{side,flutter:.23,opacity:.40});
    fin(sideName+' pelvic fin',[-.54,-.39,side*.10],[-.15,-.34,side*.11],[[-.53,-.39,side*.12],[-.25,-.60,side*.32],[.15,-.81,side*.36],[.18,-.56,side*.25],[-.14,-.34,side*.11]],{side,flutter:.14,opacity:.40});
  }

  const eyeSilver=ownMaterial(new THREE.MeshPhysicalMaterial({color:'#acb8af',metalness:.66,roughness:.22,clearcoat:1}));
  const eyeBlack=ownMaterial(new THREE.MeshPhysicalMaterial({color:'#020d15',roughness:.10,metalness:.12,clearcoat:1,clearcoatRoughness:.04}));
  const glint=ownMaterial(new THREE.MeshBasicMaterial({color:'#f2f7e8',transparent:true,opacity:.86}));
  const gillInk=ownMaterial(new THREE.MeshStandardMaterial({color:'#385968',metalness:.22,roughness:.42}));
  const gillHighlight=ownMaterial(new THREE.LineBasicMaterial({color:'#cbd7cd',transparent:true,opacity:.62}));
  const eyeParts=[];
  function smallShape(geometry,material,position,scale,name) {
    const item=mesh(ownGeometry(geometry),material,name);item.position.set(...position);item.scale.set(...scale);eyeParts.push({item,x:position[0],z:position[2]});return item;
  }
  for(const side of [-1,1]) {
    smallShape(new THREE.SphereGeometry(1,32,20),eyeSilver,[-2.34,.135,side*.197],[.157,.157,.071],'Silver iris surround');
    smallShape(new THREE.SphereGeometry(1,32,20),eyeBlack,[-2.355,.137,side*.243],[.114,.118,.037],'Dark glassy eye');
    smallShape(new THREE.SphereGeometry(1,12,8),glint,[-2.390,.177,side*.274],[.027,.031,.009],'Small eye highlight');
    smallShape(new THREE.SphereGeometry(1,12,8),gillInk,[-2.585,.115,side*.133],[.014,.011,.007],'Naris');
    const gill=[[-1.94,.78],[-1.69,.60],[-1.54,.23],[-1.56,-.21],[-1.73,-.65],[-1.96,-.79]].map(([x,q])=>skinPoint(x,q,side,.004));
    curveLine(gill,gillInk,'Curved opercular boundary',.009);
    curveLine(gill.map(v=>new THREE.Vector3(v.x-.028,v.y,v.z+side*.003)),gillHighlight,'Opercular silver edge');
    curveLine([new THREE.Vector3(-2.816,-.016,side*.021),new THREE.Vector3(-2.736,-.048,side*.070),new THREE.Vector3(-2.60,-.035,side*.118)],gillInk,'Fine terminal mouth',.006);
  }

  const stateDefinitions=[
    {id:'visualL',name:'Visual L',position:[-2.12,.27,-.105]},
    {id:'visualR',name:'Visual R',position:[-2.06,.105,.105]},
    {id:'integratorL',name:'Integrator L',position:[-1.80,.295,-.118]},
    {id:'integratorR',name:'Integrator R',position:[-1.74,.095,.118]},
    {id:'gain',name:'Shared drive',position:[-1.54,.22,0]},
    {id:'motorL',name:'Motor L',position:[-1.28,.275,-.108]},
    {id:'motorR',name:'Motor R',position:[-1.22,.085,.108]},
    {id:'spinal',name:'Spinal drive',position:[-.99,.14,0]}
  ];
  const neural=new THREE.Group();neural.name='Eight schematic model-state groups';neural.visible=false;sculpture.add(neural);
  const neuralColors=['#153f50','#153f50','#194d47','#194d47','#735b25','#164553','#164553','#755328'];
  const activeColors=['#39949e','#39949e','#478f7b','#478f7b','#bea252','#428d9c','#428d9c','#b68d49'];
  stateDefinitions.forEach((definition,index)=>{
    // Unlit overlay colors remain legible under the scene's photographic
    // lighting. Rates interpolate two saturated colors; they never add white.
    const material=ownMaterial(new THREE.MeshBasicMaterial({color:neuralColors[index],toneMapped:false,depthTest:false}));
    const node=mesh(ownGeometry(new THREE.SphereGeometry(index===4?.070:.063,20,12)),material,definition.name,neural);node.position.set(...definition.position);node.renderOrder=10;node.castShadow=false;
    node.userData={stateIndex:index,stateId:definition.id,schematic:true};
    const haloMaterial=ownMaterial(new THREE.MeshBasicMaterial({color:activeColors[index],toneMapped:false,transparent:true,opacity:.10,depthWrite:false,depthTest:false}));
    const halo=mesh(ownGeometry(new THREE.SphereGeometry(.11,16,10)),haloMaterial,definition.name+' activity halo',neural);halo.position.copy(node.position);halo.renderOrder=9;halo.castShadow=false;
    neuralNodes.push({node,halo,material,haloMaterial,rest:definition.position,lowColor:color(neuralColors[index]),highColor:color(activeColors[index])});
  });
  const links=[[0,2],[1,3],[0,4],[1,4],[0,5],[1,6],[2,5],[3,6],[4,5],[4,6],[5,7],[6,7],[2,3]];
  const connectionGeometry=ownGeometry(new THREE.BufferGeometry().setFromPoints(links.flatMap(([a,b])=>[new THREE.Vector3(...stateDefinitions[a].position),new THREE.Vector3(...stateDefinitions[b].position)])));
  const connectionMaterial=ownMaterial(new THREE.LineBasicMaterial({color:'#286476',toneMapped:false,transparent:true,opacity:.64,depthTest:false,depthWrite:false}));
  const connections=new THREE.LineSegments(connectionGeometry,connectionMaterial);connections.name='Schematic state connections';connections.renderOrder=8;neural.add(connections);

  group.userData={
    description:'Original anatomy-inspired procedural adult zebrafish artwork; not a scanned or measured anatomical reconstruction.',
    axes:{longitudinal:'X',head:'-X',dorsal:'+Y',bilateral:'Z'},
    restBounds:{min:[-2.84,-.94,-.77],max:[3.30,1.06,.77]},
    bodyHalfWidth:.334,
    neuralMode:'Eight schematic functional states placed within the anterior body and staggered for readability. Positions are not anatomical localization or measured neural activity. Rate brightness uses bounded dark-to-light teal/gold colors, independently of scene exposure.',
    states:stateDefinitions.map((d,index)=>({index,id:d.id,label:d.name,position:[...d.position]}))
  };

  let mode='body',lastTime=null,phase=0,currentDrive=.35,currentTurn=0,disposed=false;
  const bendResult=new Float64Array(2);
  function bend(x) {
    const t=clamp((x+1.8)/5.12),amp=(.075+currentDrive*.22),angle=phase-t*5.1;
    const envelope=t*t;
    const displacement=amp*envelope*Math.sin(angle)+currentTurn*.21*envelope;
    const slope=t>0?(amp*(2*t*Math.sin(angle)-envelope*5.1*Math.cos(angle))+currentTurn*.42*t)/5.12:0;
    bendResult[0]=displacement;bendResult[1]=slope;return bendResult;
  }
  function setMode(next) {
    if(next!=='body'&&next!=='neural')throw new RangeError('Fish mode must be body or neural.');
    mode=next;neural.visible=mode==='neural';
    for(const material of bodyMaterials){material.transparent=mode==='neural';material.opacity=mode==='neural'?.22:1;material.depthWrite=mode==='body';material.needsUpdate=true;}
    scaleMaterial.opacity=mode==='neural'?.04:.12;
    for(const {material,opacity} of finMaterials)material.opacity=mode==='neural'?opacity*.65:opacity;
  }
  function update({time=0,drive=.35,turn=0,rates=[],paused=false}={}) {
    if(disposed)return;
    const t=Number.isFinite(time)?time:0;
    const dt=lastTime===null?0:clamp(t-lastTime,0,.1);lastTime=t;
    if(!paused) {
      const blend=1-Math.exp(-dt*7);
      currentDrive+=(clamp(Number.isFinite(drive)?drive:.35)-currentDrive)*blend;
      currentTurn+=(clamp(Number.isFinite(turn)?turn:0,-1,1)-currentTurn)*blend;
      phase+=dt*(3.6+currentDrive*5.5);
      for(const part of deformables) {
        const array=part.geometry.attributes.position.array,normals=part.geometry.attributes.normal?.array;
        for(let i=0;i<array.length;i+=3) {
          const x=part.rest[i],y=part.rest[i+1],z=part.rest[i+2],[offset,slope]=bend(x);
          const flutter=part.fin*Math.sin(phase*.85-x*.6+(part.side<0?1.1:0));
          const lever=part.side?Math.abs(z-part.anchorZ):Math.abs(y-part.anchorY);
          array[i]=x;array[i+1]=y+(part.side?flutter*lever*.55:0);array[i+2]=z+offset+flutter*lever*(part.side||1)*.34;
          if(normals&&part.normals) {
            const nx=part.normals[i]-slope*part.normals[i+2],ny=part.normals[i+1],nz=part.normals[i+2],length=Math.hypot(nx,ny,nz)||1;
            normals[i]=nx/length;normals[i+1]=ny/length;normals[i+2]=nz/length;
          }
        }
        part.geometry.attributes.position.needsUpdate=true;
        if(normals)part.geometry.attributes.normal.needsUpdate=true;
      }
      for(const item of eyeParts)item.item.position.z=item.z+bend(item.x)[0];
      sculpture.rotation.x=currentTurn*.045;
    }
    let total=0;
    neuralNodes.forEach(({node,halo,material,haloMaterial,rest,lowColor,highColor},index)=>{
      const rate=clamp(Number.isFinite(rates[index])?rates[index]:0);total+=rate;
      material.color.copy(lowColor).lerp(highColor,Math.sqrt(rate));haloMaterial.opacity=.07+rate*.14;
      node.scale.setScalar(.88+rate*.23);halo.scale.setScalar(.88+rate*.35);
      node.position.z=rest[2]+bend(rest[0])[0];halo.position.z=node.position.z;
    });
    connectionMaterial.opacity=.48+total/8*.28;
    const wire=connectionGeometry.attributes.position.array;
    links.forEach(([a,b],index)=>{for(const [end,nodeIndex] of [[0,a],[1,b]]){const p=neuralNodes[nodeIndex].node.position,offset=index*6+end*3;wire[offset]=p.x;wire[offset+1]=p.y;wire[offset+2]=p.z;}});
    connectionGeometry.attributes.position.needsUpdate=true;
  }
  function dispose() {
    if(disposed)return;disposed=true;
    for(const geometry of geometries)geometry.dispose();
    for(const material of materials)material.dispose();
    group.removeFromParent();group.clear();
  }
  update({time:0});
  return {group,update,setMode,dispose};
}
