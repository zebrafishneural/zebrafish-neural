import test from 'node:test';
import assert from 'node:assert/strict';
import {SharedFeed} from '../dist/lib/shared-feed.js';

const packet=(extra={})=>({schemaVersion:1,rates:[0,.1,.2,.3,.4,.5,.6,.7],frame:{ageMs:0,jpeg:'YWJj'},...extra});
const response=endpoint=>({ok:true,json:async()=>({endpoint})});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function flush(){for(let i=0;i<12;i++)await Promise.resolve();}

function harness({hostname='zebraneural.com',responses=[]}={}){
  let now=0,nextId=1;
  const timers=new Map(),sockets=[],fetches=[],data=[],statuses=[];
  const queue=responses.slice();
  class FakeSocket {
    static CONNECTING=0;static OPEN=1;static CLOSED=3;
    constructor(url){this.url=String(url);this.readyState=0;this.events=new Map();this.closeCalls=0;sockets.push(this);}
    addEventListener(type,callback){if(!this.events.has(type))this.events.set(type,[]);this.events.get(type).push(callback);}
    emit(type,event={}){for(const callback of this.events.get(type)||[])callback(event);}
    open(){this.readyState=1;this.emit('open');}
    message(value){this.emit('message',{data:typeof value==='string'?value:JSON.stringify(value)});}
    close(){this.closeCalls++;if(this.readyState!==3){this.readyState=3;this.emit('close');}}
  }
  const dependencies={
    WebSocket:FakeSocket,location:{hostname},now:()=>now,
    setTimeout:(callback,delay)=>{const id=nextId++;timers.set(id,{callback,at:now+delay});return id;},
    clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{
      fetches.push({url:String(url),options});
      const value=queue.length?queue.shift():response('https://controller.example');
      if(value instanceof Error)throw value;
      return await value;
    }
  };
  const feed=new SharedFeed({onData:value=>data.push(value),onStatus:value=>statuses.push(value)},dependencies);
  async function advance(milliseconds){
    const end=now+milliseconds;
    for(;;){
      const due=[...timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!due)break;
      now=due[1].at;timers.delete(due[0]);due[1].callback();await flush();
    }
    now=end;await flush();
  }
  return {feed,advance,sockets,fetches,data,statuses,timers,queue};
}

test('uses one config request and forwards validated WebSocket frames without HTTP polling',async()=>{
  const h=harness({responses:[response('https://controller.example/ignored/path')]});
  h.feed.start();h.feed.start();await flush();
  assert.equal(h.fetches.length,1);
  assert.ok(h.fetches[0].url.endsWith('/dist/live-config.json'));
  assert.equal(h.fetches[0].options.cache,'no-store');
  assert.equal(h.sockets[0].url,'wss://controller.example/ws');
  h.sockets[0].open();
  for(const invalid of ['not JSON',null,{schemaVersion:2,rates:Array(8).fill(0)},packet({rates:[1,2]}),packet({rates:[0,0,0,0,0,0,0,null]})])h.sockets[0].message(invalid);
  assert.equal(h.data.length,0);
  const good=packet();h.sockets[0].message(good);
  await h.advance(3000);h.sockets[0].message(good);
  assert.deepEqual(h.data,[good,good]);
  assert.deepEqual(h.statuses.map(status=>status.kind),['connecting']);
  assert.equal(h.fetches.length,1,'frames must travel over the socket, not per-viewer frame polling');
  h.feed.stop();assert.equal(h.timers.size,0);
});

test('stop cancels a pending config request even if its response ignores abort',async()=>{
  const pending=deferred(),h=harness({responses:[pending.promise]});
  h.feed.start();await flush();
  const count=h.statuses.length;
  h.feed.stop();
  assert.equal(h.fetches[0].options.signal.aborted,true);
  assert.equal(h.timers.size,0);
  pending.resolve(response('https://obsolete.example'));await flush();await h.advance(60000);
  assert.equal(h.sockets.length,0);
  assert.equal(h.fetches.length,1);
  assert.equal(h.statuses.length,count);
});

test('a late config from the previous start cannot replace a new session',async()=>{
  const pending=deferred(),h=harness({responses:[pending.promise,response('https://current.example')]});
  h.feed.start();await flush();h.feed.stop();h.feed.start();await flush();
  assert.equal(h.sockets.length,1);assert.equal(h.sockets[0].url,'wss://current.example/ws');
  pending.resolve(response('https://obsolete.example'));await flush();
  assert.equal(h.sockets.length,1);
  h.sockets[0].open();h.sockets[0].message(packet());assert.equal(h.data.length,1);
  h.feed.stop();
});

test('events from a stopped socket cannot render data or trigger reconnects',async()=>{
  const h=harness();h.feed.start();await flush();
  const old=h.sockets[0];old.open();old.message(packet());
  h.feed.stop();h.feed.start();await flush();
  const current=h.sockets[1];current.open();
  const statuses=h.statuses.length;
  old.message(packet({runId:'obsolete'}));old.emit('error');old.emit('close');
  assert.equal(h.data.length,1);assert.equal(h.statuses.length,statuses);
  current.message(packet({runId:'current'}));assert.equal(h.data.at(-1).runId,'current');
  await h.advance(2000);assert.equal(h.fetches.length,2);
  h.feed.stop();await h.advance(60000);assert.equal(h.fetches.length,2);
});

test('sockets receiving no valid packets become interrupted at six seconds and reconnect after twelve',async()=>{
  const h=harness();h.feed.start();await flush();const socket=h.sockets[0];socket.open();
  await h.advance(5000);socket.message({schemaVersion:1,rates:[]});
  await h.advance(1000);assert.equal(h.statuses.at(-1).kind,'interrupted');
  assert.equal(socket.closeCalls,0);
  await h.advance(5000);socket.message('invalid');
  await h.advance(1000);assert.equal(socket.closeCalls,1);assert.equal(h.statuses.at(-1).kind,'offline');
  await h.advance(1999);assert.equal(h.fetches.length,1);
  await h.advance(1);assert.equal(h.fetches.length,2);assert.equal(h.sockets.length,2);
  h.feed.stop();
});

test('ongoing packets with stale frame ages report interruption without reconnecting a responsive socket',async()=>{
  const h=harness();h.feed.start();await flush();const socket=h.sockets[0];socket.open();
  for(let i=0;i<15;i++){
    socket.message(packet({frame:{ageMs:9000,jpeg:'YWJj'}}));await h.advance(1000);
  }
  assert.equal(h.statuses.at(-1).kind,'interrupted');
  assert.equal(socket.closeCalls,0);assert.equal(h.fetches.length,1);
  h.feed.stop();
});

test('reconnects re-read changed endpoint config and back off at bounded 2/4/8/15 second intervals',async()=>{
  const h=harness({responses:[response('https://first.example'),response('https://second.example')]});
  h.feed.start();await flush();
  for(const [index,delay] of [2000,4000,8000,15000,15000].entries()){
    h.sockets.at(-1).close();
    await h.advance(delay-1);assert.equal(h.fetches.length,index+1);
    await h.advance(1);assert.equal(h.fetches.length,index+2);
  }
  assert.equal(h.sockets[1].url,'wss://second.example/ws');
  h.sockets.at(-1).open();h.sockets.at(-1).message(packet());h.sockets.at(-1).close();
  const requests=h.fetches.length;
  await h.advance(2000);assert.equal(h.fetches.length,requests+1,'a valid packet resets retry delay');
  h.feed.stop();
});

test('a socket that never opens is replaced after its connection deadline',async()=>{
  const h=harness();h.feed.start();await flush();
  await h.advance(12000);assert.equal(h.sockets[0].closeCalls,1);
  await h.advance(2000);assert.equal(h.sockets.length,2);
  h.feed.stop();
});

test('HTTP endpoints are accepted only when both page and endpoint are loopback',async()=>{
  for(const [hostname,endpoint,accepted] of [
    ['zebraneural.com','http://127.0.0.1:4388',false],
    ['localhost','http://127.0.0.1:4388',true],
    ['127.0.0.1','http://remote.example',false],
    ['localhost','file:///private',false]
  ]){
    const h=harness({hostname,responses:[response(endpoint)]});h.feed.start();await flush();
    assert.equal(h.sockets.length,accepted?1:0);
    if(accepted)assert.equal(h.sockets[0].url,'ws://127.0.0.1:4388/ws');
    else assert.equal(h.statuses.at(-1).kind,'offline');
    h.feed.stop();
  }
});

test('recording export returns the host blob and rejects inactive or superseded connections',async()=>{
  const h=harness();
  await assert.rejects(h.feed.getRecording(),/not connected/);assert.equal(h.fetches.length,0);
  h.feed.start();await flush();
  const blob=new Blob(['{"samples":[]}'],{type:'application/json'});
  h.queue.push({ok:true,blob:async()=>blob});
  assert.equal(await h.feed.getRecording(),blob);
  assert.equal(h.fetches.at(-1).url,'https://controller.example/recording.json');
  const pending=deferred();h.queue.push(pending.promise);
  const oldExport=h.feed.getRecording();await flush();
  h.feed.stop();assert.equal(h.fetches.at(-1).options.signal.aborted,true);
  pending.resolve({ok:true,blob:async()=>blob});
  await assert.rejects(oldExport,/connection changed/);
  await assert.rejects(h.feed.getRecording(),/not connected/);
  assert.equal(h.timers.size,0);
});
