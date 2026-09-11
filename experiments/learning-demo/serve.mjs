import {createServer} from 'node:http';
import {Worker} from 'node:worker_threads';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=import.meta.dirname;
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
export async function startServer({port=4187,dataDir=resolve(root,'data')}={}){
  await mkdir(dataDir,{recursive:true});
  const checkpointPath=resolve(dataDir,'checkpoint.json');
  let saved=null,loadError=null;
  try{saved=JSON.parse(await readFile(checkpointPath,'utf8'));}catch(err){if(err.code!=='ENOENT')loadError='The saved demo checkpoint is unreadable. Reset the isolated demo or restore a valid export.';}
  let state={status:'starting',trainer:null,evaluation:null,error:loadError},checkpoint=saved,serial=0,writeQueue=Promise.resolve();
  const pending=new Map();
  const worker=new Worker(new URL('./worker.mjs',import.meta.url),{workerData:{checkpoint:loadError?{invalidSavedCheckpoint:true}:saved}});
  function rejectPending(message){for(const {reject} of pending.values())reject(Error(message));pending.clear();}
  worker.on('message',message=>{
    if(message.type==='state'){
      checkpoint=message.checkpoint;
      state={status:message.status,trainer:message.trainer,evaluation:message.evaluation,error:message.error};
      const serialized=JSON.stringify(checkpoint,null,2);
      writeQueue=writeQueue.then(async()=>{
        const temp=checkpointPath+'.next';await writeFile(temp,serialized);await rename(temp,checkpointPath);
      }).catch(err=>{state={...state,error:'Checkpoint save failed: '+err.message};});
      if(message.id&&pending.has(message.id)){pending.get(message.id).resolve(state);pending.delete(message.id);}
    }else if(message.type==='failure'){
      const p=pending.get(message.id);if(p){p.reject(Error(message.error));pending.delete(message.id);}
    }else if(message.type==='fatal'){state={...state,status:'error',error:message.error};rejectPending(message.error);}
  });
  worker.on('error',err=>{state={...state,status:'error',error:err.message};rejectPending(err.message);});
  function command(name,body){return new Promise((resolveRequest,reject)=>{const id=++serial;pending.set(id,{resolve:resolveRequest,reject});worker.postMessage({id,command:name,body});});}
  const server=createServer(async(req,res)=>{
    const actualPort=server.address()?.port;
    const allowedHosts=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`]);
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':mime['.json']});res.end(JSON.stringify(value));};
    try{
      if(!allowedHosts.has(req.headers.host)){json(403,{error:'Local host required.'});return;}
      const url=new URL(req.url,`http://127.0.0.1:${actualPort}`);
      if(url.pathname.startsWith('/api/')){
        if(req.method==='GET'){
          if(url.pathname==='/api/status'){json(200,state);return;}
          if(url.pathname==='/api/checkpoint'){
            if(!checkpoint){json(409,{error:'The trainer is starting.'});return;}
            res.setHeader('Content-Disposition','attachment; filename="zebrafish-learning-checkpoint.json"');json(200,checkpoint);return;
          }
          json(404,{error:'Not found.'});return;
        }
        if(req.method!=='POST'){json(405,{error:'Method not allowed.'});return;}
        if(!allowedHosts.has((()=>{try{const origin=new URL(req.headers.origin);return origin.protocol==='http:'?origin.host:null;}catch{return null;}})())){json(403,{error:'Same-origin local requests only.'});return;}
        if(!String(req.headers['content-type']).startsWith('application/json')){json(415,{error:'JSON body required.'});return;}
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>512*1024){json(413,{error:'Checkpoint exceeds the 512 KB limit.'});return;}chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{json(400,{error:'Invalid JSON.'});return;}
        if(!body||typeof body!=='object'||Array.isArray(body)){json(400,{error:'JSON object required.'});return;}
        const names={'/api/train':'train','/api/pause':'pause','/api/evaluate':'evaluate','/api/reset':'reset','/api/checkpoint':'restore'};
        if(!names[url.pathname]){json(404,{error:'Not found.'});return;}
        try{json(200,await command(names[url.pathname],body));}catch(err){json(400,{error:err.message});}return;
      }
      if(!['GET','HEAD'].includes(req.method)){json(405,{error:'Method not allowed.'});return;}
      const pathname=decodeURIComponent(url.pathname);
      let file;
      if(pathname.startsWith('/baseline/')||pathname.startsWith('/dist/')){
        const prefix=pathname.startsWith('/baseline/')?'/baseline/':'/dist/';
        const base=resolve(root,'../../dist');file=resolve(base,pathname.slice(prefix.length));
        if(!file.startsWith(base+sep)||pathname.split('/').some(part=>part.startsWith('.'))){json(403,{error:'Forbidden.'});return;}
      }else{
        const files={'/':'index.html','/index.html':'index.html','/demo.css':'demo.css','/demo.js':'demo.js','/core.js':'core.js','/trainer.js':'trainer.js','/README.md':'README.md','/results/initial-evaluation.json':'results/initial-evaluation.json'};
        if(!files[pathname]){json(404,{error:'Not found.'});return;}file=resolve(root,files[pathname]);
      }
      // Core imports the frozen baseline through a relative source path.
      const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'text/plain; charset=utf-8'});res.end(req.method==='HEAD'?undefined:data);
    }catch(err){if(err.code==='ENOENT')json(404,{error:'Not found.'});else json(500,{error:'The local demo could not serve this request.'});}
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolveListen);});
  return {server,port:server.address().port,getState:()=>state,close:async()=>{await worker.terminate();rejectPending('The local demo closed.');await new Promise(r=>server.close(r));await writeQueue;}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=await startServer({port:Number(process.env.LEARNING_DEMO_PORT||4187)});
  console.log(`Learning demo: http://127.0.0.1:${app.port}/`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
