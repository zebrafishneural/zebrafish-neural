import {createServer} from 'node:http';
import {createServer as createLeaseServer} from 'node:net';
import {createHash} from 'node:crypto';
import {readFile,stat,mkdir,realpath} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,WebSocket} from 'ws';
import {createStore} from './lib/store.mjs';
import {ChessRuntime} from './lib/runtime.mjs';

const publicRoot=resolve(import.meta.dirname,'public');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.txt':'text/plain; charset=utf-8'};
async function lease(dataDir){
 await mkdir(dataDir,{recursive:true});const actual=(await realpath(dataDir)).toLowerCase();const port=20000+createHash('sha256').update(actual).digest().readUInt16LE()%20000;
 const server=createLeaseServer(socket=>socket.destroy());await new Promise((ok,no)=>{server.once('error',()=>no(Error('This data directory is already owned by another chess process, or its local lease port is occupied.')));server.listen({port,host:'127.0.0.1',exclusive:true},ok);});return {server,port};
}
export async function startServer({port=Number(process.env.PORT||4196),dataDir=resolve(process.env.CHESS_DATA_DIR||resolve(import.meta.dirname,'data')),runtimeOptions={}}={}){
 const owner=await lease(dataDir);let server,runtime,wss;
 try{
  const store=await createStore(dataDir);wss=new WebSocketServer({noServer:true,maxPayload:512,perMessageDeflate:false});
  runtime=new ChessRuntime({store,...runtimeOptions,onState:state=>{const data=JSON.stringify(state);for(const client of wss.clients){if(client.readyState!==WebSocket.OPEN)continue;if(client.bufferedAmount>1024*1024){client.terminate();continue;}client.send(data);}}});
  await runtime.initialize();
  const allowed=req=>{try{const host=req.headers.host;if(![`127.0.0.1:${port}`,`localhost:${port}`].includes(host))return false;if(!req.headers.origin)return true;const origin=new URL(req.headers.origin);return origin.protocol==='http:'&&[`127.0.0.1:${port}`,`localhost:${port}`].includes(origin.host);}catch{return false;}};
  server=createServer(async(req,res)=>{
   res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
   const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(req.method==='HEAD'?undefined:JSON.stringify(data));};
   try{
    if(!allowed(req)){json(403,{error:'Local preview origin required.'});return;}if(!['GET','HEAD'].includes(req.method)){json(405,{error:'The shared experiment is read-only.'});return;}
    const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(path==='/api/state'){json(200,runtime.snapshot());return;}
    if(path==='/healthz'){json(runtime.error?503:200,{ok:!runtime.error,gameId:runtime.game.id,status:runtime.status,seq:runtime.seq});return;}
    if(path==='/api/games'){json(200,await runtime.listGames());return;}
    let match=path.match(/^\/api\/games\/([a-zA-Z0-9_-]{1,80})\/moves\/(\d{1,5})$/);
    if(match){const record=await store.getDecision(match[1],Number(match[2]));json(record?200:404,record||{error:'No neural decision for this move.'});return;}
    match=path.match(/^\/api\/games\/([a-zA-Z0-9_-]{1,80})(\.pgn)?$/);
    if(match){const game=await runtime.getGame(match[1]);if(!game){json(404,{error:'Game not found.'});return;}if(match[2]){res.writeHead(200,{'Content-Type':'application/x-chess-pgn; charset=utf-8','Content-Disposition':`attachment; filename="${game.id}.pgn"`});res.end(req.method==='HEAD'?undefined:game.pgn||game.moves.map(x=>x.san).join(' '));return;}json(200,game);return;}
    if(path.startsWith('/api/')){json(404,{error:'Route not found.'});return;}
    const file=resolve(publicRoot,'.'+(path==='/'?'/index.html':path));if(!file.startsWith(publicRoot+sep)){json(403,{error:'Not available.'});return;}
    const info=await stat(file);if(!info.isFile()){json(404,{error:'Not found.'});return;}
    res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:await readFile(file));
   }catch(error){if(!res.headersSent){const code=error.code==='ENOENT'?404:500;json(code,{error:code===404?'Not found.':'The requested record could not be verified.'});}else res.end();}
  });
  server.on('upgrade',(req,socket,head)=>{if(req.url!=='/ws'||!allowed(req)||wss.clients.size>=20){socket.destroy();return;}wss.handleUpgrade(req,socket,head,ws=>{ws.send(JSON.stringify(runtime.snapshot()));ws.on('message',()=>ws.close(1008,'Read-only stream'));ws.on('error',()=>{});});});
  await new Promise((ok,no)=>{server.once('error',no);server.listen(port,'127.0.0.1',ok);});port=server.address().port;runtime.start();
  return {runtime,store,port,dataDir,leasePort:owner.port,async close(){await runtime.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));await new Promise(r=>owner.server.close(r));}};
 }catch(error){await runtime?.close();for(const ws of wss?.clients||[])ws.terminate();wss?.close();server?.close();await new Promise(r=>owner.server.close(r));throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const app=await startServer();console.log(`Shared chess demo: http://127.0.0.1:${app.port}/ | ${app.runtime.game.id} | read-only clients`);
 let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await app.close();process.exit(0);});
}
