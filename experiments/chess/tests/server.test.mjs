import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request} from 'node:http';
import {WebSocket} from 'ws';
import {startServer} from '../server.mjs';

const received=socket=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('No shared state received.')),5000);
 socket.once('message',data=>{clearTimeout(timer);resolve(JSON.parse(String(data)));});
 socket.once('error',error=>{clearTimeout(timer);reject(error);});
});

test('two read-only spectators share state; ownership and HTTP boundaries hold',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'zebra-chess-server-'));
 let app,a,b,restarted;
 try{
  app=await startServer({port:0,dataDir:dir,runtimeOptions:{tickMs:60000}});
  const base=`http://127.0.0.1:${app.port}`;
  a=new WebSocket(`ws://127.0.0.1:${app.port}/ws`,{origin:base});const first=received(a);
  b=new WebSocket(`ws://127.0.0.1:${app.port}/ws`,{origin:base});const second=received(b);
  const [one,two]=await Promise.all([first,second]);
  assert.deepEqual(one.game,two.game);assert.equal(one.streamId,two.streamId);
  const nextA=received(a),nextB=received(b);
  await app.runtime.tick();
  const [left,right]=await Promise.all([nextA,nextB]);
  assert.deepEqual(left,right);assert.ok(left.selection.rates.some(x=>x>0));
  assert.ok(left.seq>one.seq);
  assert.equal((await fetch(base+'/api/state',{method:'POST'})).status,405);
  assert.equal((await fetch(base+'/api/state',{headers:{Origin:'https://unrelated.example'}})).status,403);
  const wrongHostStatus=await new Promise((resolve,reject)=>{const req=request(base+'/api/state',{headers:{Host:'unrelated.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();});
  assert.equal(wrongHostStatus,403);
  assert.equal((await fetch(base+'/lib/../../data/checkpoint.json')).status,404);
  assert.equal((await fetch(base+'/api/games')).status,200);
  assert.deepEqual(await (await fetch(base+'/api/games')).json(),[]);
  const pgn=await fetch(base+`/api/games/${one.game.id}.pgn`);
  assert.equal(pgn.status,200);assert.match(await pgn.text(),/Shared Chess local experiment/);
  const closed=new Promise(resolve=>a.once('close',code=>resolve(code)));
  a.send(JSON.stringify({move:'e2e4'}));assert.equal(await closed,1008);
  await assert.rejects(startServer({port:0,dataDir:dir}),/already owned/);
  b.terminate();await app.close();app=null;
  restarted=await startServer({port:0,dataDir:dir,runtimeOptions:{tickMs:60000}});
  assert.equal(restarted.runtime.game.id,one.game.id);
  assert.notEqual(restarted.runtime.streamId,one.streamId);
  assert.equal(restarted.runtime.game.ply,one.game.ply);
  assert.equal(restarted.runtime.pending.ply,one.game.ply+1);
 }finally{a?.terminate();b?.terminate();await app?.close();await restarted?.close();await rm(dir,{recursive:true,force:true});}
});
