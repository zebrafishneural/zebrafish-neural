// Run only after activation. Creates two disposable private games and resigns them.
// Does not modify the shared spectator game, learning state, or site deployment.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connect} from 'node:net';
import {setTimeout as pause} from 'node:timers/promises';
import WebSocket from 'ws';

const base=process.argv[2]||'https://play-feed.zebraneural.com';
const origin=process.argv[3]||'https://zebraneural.com';
const publicHost=process.argv[4];
const url=new URL(base);
if(!['https:','http:'].includes(url.protocol)||url.pathname!=='/'||url.search||url.hash)throw Error('Pass an HTTP(S) base URL without a path or credentials.');
if(url.username||url.password)throw Error('URL credentials are not accepted.');
const rows=[],games=[],sockets=[];
const check=(name,pass,detail)=>{rows.push({name,pass,...(detail?{detail}:{})});assert.equal(pass,true,name);};
async function request(path,{method='GET',token,body,requestOrigin=origin}={}){
 const headers={};if(requestOrigin)headers.Origin=requestOrigin;if(token)headers.Authorization=`Bearer ${token}`;if(body!==undefined)headers['Content-Type']='application/json';
 return fetch(new URL(path,url),{method,headers,...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
}
function openSocket(game,token=game.token,requestOrigin=origin){
 const endpoint=new URL('/play-ws',url);endpoint.protocol=url.protocol==='https:'?'wss:':'ws:';
 const ws=new WebSocket(endpoint,{origin:requestOrigin,handshakeTimeout:10000});sockets.push(ws);
 const messages=[];let closed=false,failed=false;
 ws.on('error',()=>{failed=true;});ws.on('close',()=>{closed=true;});
 ws.on('open',()=>ws.send(JSON.stringify({type:'subscribe',gameId:game.gameId,token})));
 ws.on('message',chunk=>{try{messages.push(JSON.parse(chunk.toString()));}catch{}});
 return {ws,messages,get closed(){return closed;},get failed(){return failed;}};
}
async function until(fn,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=fn();if(value)return value;await pause(100);}throw Error('Timed out waiting for a bounded verification event.');}
async function rawClosed(host){return new Promise(resolve=>{const socket=connect({host,port:4200});socket.setTimeout(5000);socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('timeout',()=>{socket.destroy();resolve(true);});socket.once('error',error=>resolve(['ECONNREFUSED','ETIMEDOUT','EHOSTUNREACH'].includes(error.code)));});}

try{
 let response=await request('/healthz');let health=await response.json();check('healthy correct service',response.status===200&&health.ok&&health.service==='chess-play');
 check('exact Origin echoed',response.headers.get('access-control-allow-origin')===origin);
 response=await request('/api/play/games',{method:'OPTIONS'});check('CORS preflight',response.status>=200&&response.status<300&&response.headers.get('access-control-allow-origin')===origin);
 response=await request('/api/play/games',{method:'POST',body:{color:'w'},requestOrigin:'https://untrusted.invalid'});check('untrusted Origin rejected',response.status===403);
 response=await request('/api/play/games',{method:'POST',body:{color:'w'},requestOrigin:null});check('missing mutation Origin rejected',response.status===403);
 for(const path of ['/package.json','/data/','/runtime/','/api/state','/api/play/no-such-route']){
  response=await request(path);check(`unavailable path ${path}`,response.status===404);
 }
 for(let i=0;i<2;i++){
  response=await request('/api/play/games',{method:'POST',body:{color:'w'}});check(`private game ${i+1} created`,response.status===201);
  const game=await response.json();assert.ok(game.gameId&&game.token);games.push(game);
 }
 check('sessions have separate identities and credentials',games[0].gameId!==games[1].gameId&&games[0].token!==games[1].token);
 const [a,b]=games,path=`/api/play/games/${a.gameId}`;
 response=await request(path);check('missing authentication rejected',response.status===401);
 response=await request(path,{token:b.token});check('other session credential rejected',response.status===401);
 response=await request(`${path}/move`,{method:'POST',token:b.token,body:{from:'e2',to:'e4',expectedPly:0,requestId:randomUUID()}});check('cross-session move rejected',response.status===401);
 const first=openSocket(a),second=openSocket(a),denied=openSocket(a,b.token);
 await until(()=>first.messages.some(m=>m.game)&&second.messages.some(m=>m.game));
 check('two authenticated WSS clients receive state',true);
 await until(()=>denied.closed||denied.failed);check('wrong WebSocket credential denied without snapshot',!denied.messages.some(m=>m.game));
 const requestId=randomUUID(),move={from:'e2',to:'e4',expectedPly:0,requestId};
 response=await request(`${path}/move`,{method:'POST',token:a.token,body:move});const committed=await response.json();check('legal human move committed once',response.status===200&&committed.committedPly===1);
 response=await request(`${path}/move`,{method:'POST',token:a.token,body:move});const duplicate=await response.json();check('retry is idempotent',response.status===200&&duplicate.duplicate===true&&duplicate.committedPly===1);
 await until(()=>first.messages.some(m=>m.game?.moves?.length>=2)&&second.messages.some(m=>m.game?.moves?.length>=2),60000);
 const common=first.messages.find(x=>x.game?.moves?.length>=2&&second.messages.some(y=>y.streamId===x.streamId&&y.seq===x.seq&&y.game?.fen===x.game.fen));
 check('same game has matching advancing WSS snapshots',!!common);
 response=await request(`/api/play/games/${b.gameId}`,{token:b.token});const untouched=await response.json();
 const untouchedState=untouched.state||untouched;check('second game remains unchanged',untouchedState.game?.moves?.length===0);
 response=await request(`${path}/moves/2`,{token:a.token});check('committed fish decision is available',response.status===200);
 response=await request(`${path}/pgn`,{token:a.token});check('private PGN export',response.status===200&&(await response.text()).includes('e4'));
 response=await request(`${path}/pgn`,{token:b.token});check('PGN export respects session boundary',response.status===401);
 if(publicHost)check('raw TCP 4200 is externally inaccessible',await rawClosed(publicHost));
}catch(error){rows.push({name:'verification error',pass:false,detail:error.message});process.exitCode=1;}
finally{
 for(const ws of sockets)ws.terminate();
 for(const game of games){try{
  const response=await request(`/api/play/games/${game.gameId}`,{token:game.token});
  const state=await response.json();
  if(!state.game?.result)await request(`/api/play/games/${game.gameId}/resign`,{method:'POST',token:game.token,body:{expectedPly:state.game.ply,requestId:randomUUID()}});
 }catch{}}
 console.log(JSON.stringify({checkedAt:new Date().toISOString(),base:url.origin,origin,checks:rows,passed:rows.filter(x=>x.pass).length,failed:rows.filter(x=>!x.pass).length,rawPortCheck:publicHost?'performed':'NOT_PERFORMED',rebootTest:'NOT_PERFORMED'},null,2));
}
