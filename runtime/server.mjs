import {createServer} from 'node:http';
import {readFile,writeFile,mkdir,rename,appendFile,stat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import sharp from 'sharp';
import {WebSocketServer,WebSocket} from 'ws';
import {BrowserController,VIEWPORT,ADAPTER_VERSION,FRAME_STALE_MS} from './controller.mjs';
import {SEEDS,allowedNavigation,allowedResource} from './policy.mjs';
import {MODEL_VERSION,REGIONS} from '../dist/lib/model.js';

const dataDir=resolve(process.env.ZNEURO_DATA_DIR||new URL('./data/',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'));
await mkdir(dataDir,{recursive:true});
const checkpointPath=resolve(dataDir,'checkpoint.json');
let saved;try{saved=JSON.parse(await readFile(checkpointPath,'utf8'));}catch{}
const controller=new BrowserController(saved?.controller);
const runId=randomUUID(),startedAt=Date.now();
const stats={frames:0,moves:0,clicks:0,scrolls:0,blockedClicks:0,assistedNavigations:0,navigations:0};
const events=[],eventQueue=[];
let browser,page,status='starting',message='Starting the shared browser.',frame=null,frameAt=0,frameSeq=0;
let pageUrl='',pageTitle='',pendingAction=null,pendingClick=null,documentEpoch=0,stopping=false,seedIndex=0,lastSeed=0,lastScroll=0,lastMove={x:controller.state.fish.x*VIEWPORT.width,y:controller.state.fish.y*VIEWPORT.height,heading:controller.state.fish.heading},lastRecordId=0;
function event(kind,text,details={}){
 const e={id:++lastRecordId,at:new Date().toISOString(),modelTime:Number(controller.state.time.toFixed(3)),frameId:controller.frameId,kind,text,...details};
 events.push(e);eventQueue.push(e);if(events.length>120)events.shift();
 if(eventQueue.length>300)eventQueue.shift();
 console.log(JSON.stringify(e));
}
function payload(withFrame=true){
 const now=Date.now(),age=frameAt?now-frameAt:null;
 const effective=status==='running'&&age>FRAME_STALE_MS?'stale':status;
 return {schemaVersion:1,runId,sequence:frameSeq,status:effective,message,startedAt:new Date(startedAt).toISOString(),serverAt:new Date(now).toISOString(),uptimeSeconds:(now-startedAt)/1000,
  adapterVersion:ADAPTER_VERSION,modelVersion:MODEL_VERSION,modelTime:controller.state.time,viewport:VIEWPORT,
  page:{url:pageUrl,title:pageTitle},frame:{id:frameSeq,capturedAt:frameAt?new Date(frameAt).toISOString():null,ageMs:age,...(withFrame&&frame?{jpeg:frame.toString('base64')}:{})},
  cursor:{...controller.state.fish,x:lastMove.x/VIEWPORT.width,y:lastMove.y/VIEWPORT.height,heading:lastMove.heading,xPx:lastMove.x,yPx:lastMove.y},
  rates:Array.from(controller.state.rates),retina:Array.from(controller.state.retina),features:controller.state.features,
  stats:{...stats},events:events.slice(-12).reverse(),samples:controller.samples.filter((_,i)=>i%2===0).slice(-60),
  policy:{input:'Live Chromium screenshot; heading-oriented retinal crop',navigation:'Wikipedia articles; ordinary links only',signing:'Not connected',token:'Not launched',host:'Operator computer'},
 };
}
const allowedOrigins=new Set(['https://zebrafish-neural.vercel.app','https://zebraneural.com','https://www.zebraneural.com','http://127.0.0.1:4173','http://localhost:4173',...(process.env.ZNEURO_ALLOWED_ORIGINS||'').split(',').filter(Boolean)]);
const server=createServer((req,res)=>{
 const origin=req.headers.origin;
 if(origin&&!allowedOrigins.has(origin)){res.writeHead(403).end();return;}
 const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Access-Control-Allow-Origin':origin||'https://zebraneural.com','Vary':'Origin'};
 if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,headers).end();return;}
 const pathname=new URL(req.url,'http://localhost').pathname;
 if(pathname==='/frame.jpg'){
  res.writeHead(frame?200:503,{...headers,'Content-Type':'image/jpeg'});res.end(req.method==='HEAD'?undefined:frame);return;
 }
 let body;
 if(pathname==='/healthz')body={ok:status==='running'&&Date.now()-frameAt<FRAME_STALE_MS,status,runId,frameAgeMs:frameAt?Date.now()-frameAt:null};
 else if(pathname==='/state')body=payload(false);
 else if(pathname==='/recording.json')body={...payload(false),samples:controller.samples,events,units:{time:'seconds',rates:'normalized 0–1',cursor:'normalized viewport; px fields in pixels'},recording:'Latest 60 model seconds; runtime assistance is marked in events.'};
 else if(pathname==='/')body={service:'Zebrafish Neural shared browser controller',readOnly:true,status,runId};
 else{res.writeHead(404,headers).end();return;}
 res.writeHead(200,{...headers,'Content-Type':'application/json; charset=utf-8'});res.end(req.method==='HEAD'?undefined:JSON.stringify(body));
});
const wss=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
server.on('upgrade',(req,socket,head)=>{
 if(new URL(req.url,'http://localhost').pathname!=='/ws'||(req.headers.origin&&!allowedOrigins.has(req.headers.origin))||wss.clients.size>=80){socket.destroy();return;}
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
wss.on('connection',ws=>{ws.send(JSON.stringify(payload()));ws.on('error',()=>{});ws.on('message',()=>ws.close(1008,'Read-only stream'));});
const broadcast=setInterval(()=>{
 if(!wss.clients.size)return;
 const data=JSON.stringify(payload());
 for(const ws of wss.clients){if(ws.readyState!==WebSocket.OPEN)continue;if(ws.bufferedAmount>1024*1024){ws.terminate();continue;}ws.send(data);}
},500);
let lastTick=performance.now();
const clock=setInterval(()=>{
 const now=performance.now(),action=controller.advance((now-lastTick)/1000);lastTick=now;
 if(action){pendingAction={...action,epoch:documentEpoch};if(action.click&&!pendingClick)pendingClick={...action,epoch:documentEpoch};}else{pendingAction=null;pendingClick=null;}
},20);

let saving=null;
function persist(){
 if(saving)return saving;
 saving=(async()=>{
 try{
  const temp=checkpointPath+'.tmp';
  await writeFile(temp,JSON.stringify({savedAt:new Date().toISOString(),controller:controller.checkpoint(),pageUrl:allowedNavigation(pageUrl)?pageUrl:null}));
  await rename(temp,checkpointPath);
  if(eventQueue.length){
   const log=resolve(dataDir,'events.jsonl');
   try{if((await stat(log)).size>4*1024*1024)await rename(log,resolve(dataDir,'events.previous.jsonl'));}catch{}
   const batch=eventQueue.splice(0);await appendFile(log,batch.map(e=>JSON.stringify(e)).join('\n')+'\n');
  }
 }catch(err){console.error('Checkpoint:',err.message);}finally{saving=null;}
 })();return saving;
}
const checkpointTimer=setInterval(persist,10000);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function navigate(url,reason){
 if(!allowedNavigation(url))throw new Error('Navigation denied');
 pendingAction=null;pendingClick=null;controller.frameAt=0;frame=null;frameAt=0;status='navigating';message=reason;
 stats.assistedNavigations++;event('assistance',reason,{url});
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
 lastSeed=Date.now();
}
async function capture(){
 const epoch=documentEpoch;
 const jpeg=await page.screenshot({type:'jpeg',quality:62,timeout:10000});
 const {data,info}=await sharp(jpeg).greyscale().raw().toBuffer({resolveWithObject:true});
 const title=(await page.title()).slice(0,240),url=page.url();
 if(epoch!==documentEpoch)return;
 const now=Date.now();controller.observe(data,info.width,info.height,now,frameSeq+1,{x:lastMove.x/VIEWPORT.width,y:lastMove.y/VIEWPORT.height,heading:lastMove.heading});
 frame=jpeg;frameAt=now;frameSeq++;stats.frames++;pageUrl=url;pageTitle=title;
 status='running';message='One shared controller receiving live browser pixels.';
}
async function act(){
 const a=pendingAction,click=pendingClick;pendingAction=null;pendingClick=null;
 if(!a||a.epoch!==documentEpoch||Date.now()-frameAt>FRAME_STALE_MS)return;
 if(click&&click.epoch===documentEpoch){
  const target=await page.evaluate(({x,y})=>{
   const e=document.elementFromPoint(x,y),anchor=e?.closest('a[href]');
   if(!anchor||e.closest('button,input,textarea,select,form,[role="button"],[contenteditable="true"]')||anchor.hasAttribute('download'))return null;
   return {href:anchor.href,label:(anchor.textContent||'').trim().slice(0,100)};
  },click);
  if(click.epoch!==documentEpoch)return;
  if(target&&allowedNavigation(target.href)){
   event('controller','Motor-gated link click',{url:target.href,label:target.label,x:click.x,y:click.y,decisionFrameId:click.frameId,decisionModelTime:click.modelTime});
   await page.mouse.click(click.x,click.y);stats.clicks++;
  }else{stats.blockedClicks++;event('guard','Click proposal had no permitted article link',{x:click.x,y:click.y,decisionFrameId:click.frameId});}
 }
 if(a.epoch!==documentEpoch)return;
 if(Math.hypot(a.x-lastMove.x,a.y-lastMove.y)>.15){await page.mouse.move(a.x,a.y);lastMove={x:a.x,y:a.y,heading:a.heading};stats.moves++;}
 if((a.y<90||a.y>VIEWPORT.height-90)&&controller.state.rates[7]>.025&&Date.now()-lastScroll>4000){
  const dy=Math.sign(a.y-VIEWPORT.height/2)*Math.round(150+controller.state.rates[7]*300);
  await page.mouse.wheel(0,dy);lastScroll=Date.now();stats.scrolls++;event('controller','Motor-driven edge scroll',{dy,decisionFrameId:a.frameId});
 }
}
async function run(){
 while(!stopping){
  try{
   status='starting';message='Starting the shared browser.';
   browser=await chromium.launch({headless:true});
   const context=await browser.newContext({viewport:VIEWPORT,acceptDownloads:false,serviceWorkers:'block',locale:'en-US'});
   await context.route('**/*',route=>{
    const r=route.request();
    const permitted=['GET','HEAD'].includes(r.method())&&(r.isNavigationRequest()?allowedNavigation(r.url()):allowedResource(r.url()));
    return permitted?route.continue():route.abort();
   });
   page=await context.newPage();
   context.on('page',popup=>{if(popup!==page)popup.close().catch(()=>{});});
   page.on('dialog',dialog=>dialog.dismiss().catch(()=>{}));
   page.on('download',download=>download.cancel().catch(()=>{}));
   page.on('framenavigated',f=>{if(f===page.mainFrame()){documentEpoch++;controller.frameAt=0;pendingAction=null;pendingClick=null;frame=null;frameAt=0;status='navigating';message='Waiting for a frame from the new page.';pageUrl=f.url();pageTitle='';stats.navigations++;event('navigation','Browser location changed',{url:f.url()});}});
   await navigate(allowedNavigation(saved?.pageUrl)?saved.pageUrl:SEEDS[seedIndex++%SEEDS.length],'Operator-defined starting article');
   saved=null;
   while(!stopping){
    const began=Date.now();
    await act();await capture();
    if(Date.now()-lastSeed>180000)await navigate(SEEDS[seedIndex++%SEEDS.length],'Scheduled article rotation by the browser adapter');
    await delay(Math.max(10,500-(Date.now()-began)));
   }
  }catch(err){
   if(stopping)break;
   status='recovering';message='Browser connection interrupted. Retrying automatically.';controller.frameAt=0;pendingAction=null;pendingClick=null;
   event('system','Browser recovery',{detail:String(err.message).slice(0,300)});
   await browser?.close().catch(()=>{});await persist();await delay(6000);
  }
 }
}
const port=Number(process.env.ZNEURO_PORT||4388);
server.listen(port,process.env.ZNEURO_BIND||'127.0.0.1',()=>console.log(`Zebrafish Neural runtime: http://127.0.0.1:${port}`));
event('system',saved?'Shared controller resumed from checkpoint':'Shared controller started',{runId,regions:REGIONS.map(r=>r.id)});
run();
async function shutdown(){if(stopping)return;stopping=true;clearInterval(clock);clearInterval(broadcast);clearInterval(checkpointTimer);await persist();wss.close();server.close();await browser?.close().catch(()=>{});process.exit(0);}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
