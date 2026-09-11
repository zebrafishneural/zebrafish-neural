import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {createChallengeHandlers,PUBLIC_WEIGHTS_URL} from '../lib/server/challenge-api.js';
import weightsHandler from '../api/challenge-weights.js';
import verifyHandler from '../api/challenge-verify.js';
import {runChallenge,DEFAULT_CONFIG,BASE_WEIGHTS} from '../dist/lib/challenge.js';

const clone=value=>JSON.parse(JSON.stringify(value));
const request=()=>({config:clone(DEFAULT_CONFIG),weights:[.4,.35,1.2,.16,.1,.6]});
const offline=async()=>{throw new Error('Offline test');};
async function invoke(handler,{method='POST',headers={},body,raw}={}) {
  const req=Readable.from(raw??[]);
  req.method=method;req.headers={host:'zebraneural.com','content-type':'application/json',...headers};
  if(body!==undefined)req.body=body;
  const response={statusCode:200,headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},end(value){this.text=value??'';}};
  await handler(req,response);
  return {...response,data:response.text?JSON.parse(response.text):null};
}
const publicPayload=(weights=[.6,.5,1.1,.13,.09,.6])=>({persistedAt:'2026-09-11T22:00:00.000Z',learner:{championGeneration:337,championWeights:weights}});

test('native handler entrypoints export functions and apply method/security headers',async()=>{
  assert.equal(typeof weightsHandler,'function');assert.equal(typeof verifyHandler,'function');
  const handlers=createChallengeHandlers({fetchImpl:offline});
  const get=await invoke(handlers.verify,{method:'GET'});assert.equal(get.statusCode,405);assert.equal(get.headers.allow,'POST');
  const post=await invoke(handlers.weights);assert.equal(post.statusCode,405);assert.equal(post.headers.allow,'GET, HEAD');
  assert.equal(post.headers['cache-control'],'no-store, max-age=0');assert.equal(post.headers['x-content-type-options'],'nosniff');
  const head=await invoke(handlers.weights,{method:'HEAD'});assert.equal(head.statusCode,200);assert.equal(head.text,'');
});

test('recalculation matches browser core across protocols and never substitutes newer weights',async()=>{
  let fetches=0;const handlers=createChallengeHandlers({fetchImpl:async()=>{fetches++;throw new Error('Must not fetch during verification');}});
  for(const motion of ['still','sweep','switch']) {
    const input=request();input.config.motion=motion;input.config.occlusion.enabled=motion==='switch';
    const expected=runChallenge(input.config,input.weights);
    const actual=await invoke(handlers.verify,{body:input});assert.equal(actual.statusCode,200);
    assert.deepEqual(actual.data.weights,input.weights);assert.deepEqual(actual.data.config,input.config);
    assert.equal(actual.data.modelVersion,expected.modelVersion);assert.equal(actual.data.taskVersion,expected.taskVersion);
    assert.deepEqual(actual.data.results,{baseline:expected.arms.baseline.result,learned:expected.arms.learned.result});
    const repeated=await invoke(handlers.verify,{body:input});assert.deepEqual(repeated.data.results,actual.data.results);assert.notEqual(repeated.data.verificationId,actual.data.verificationId);
    assert.ok(Number.isFinite(Date.parse(actual.data.verifiedAt)));assert.ok(expected.steps<=1500);
  }
  assert.equal(fetches,0);
  const same=request();same.weights=[...BASE_WEIGHTS];
  const result=await invoke(handlers.verify,{body:same});assert.deepEqual(result.data.results.baseline,result.data.results.learned);
});

test('Vercel pre-parsed JSON, raw strings, buffers, and streamed JSON produce identical results',async()=>{
  const handlers=createChallengeHandlers({fetchImpl:offline}),input=request(),encoded=JSON.stringify(input);
  const responses=await Promise.all([
    invoke(handlers.verify,{body:input}),invoke(handlers.verify,{body:encoded}),
    invoke(handlers.verify,{body:Buffer.from(encoded)}),invoke(handlers.verify,{raw:[Buffer.from(encoded.slice(0,40)),Buffer.from(encoded.slice(40))]})
  ]);
  for(const response of responses){assert.equal(response.statusCode,200);assert.deepEqual(response.data.results,responses[0].data.results);}
});

test('8 KiB limit covers raw streams, pre-parsed bodies, declared size, and UTF-8 bytes',async()=>{
  const handlers=createChallengeHandlers({fetchImpl:offline});
  for(const options of [
    {body:'x'.repeat(8193)},{body:Buffer.alloc(8193)},
    {body:{config:request().config,weights:request().weights,oversized:'x'.repeat(8193)}},
    {body:{extra:'魚'.repeat(3000)}},
    {raw:[Buffer.alloc(4096),Buffer.alloc(4097)]},
    {body:request(),headers:{'content-length':'8193'}}
  ])assert.equal((await invoke(handlers.verify,options)).statusCode,413);
  assert.equal((await invoke(handlers.verify,{body:request(),headers:{'content-type':'text/plain'}})).statusCode,415);
});

test('unknown fields, forged outcomes, bad config, and all nonfinite or sparse gains are rejected',async()=>{
  const handlers=createChallengeHandlers({fetchImpl:offline}),invalid=[];
  let value=request();value.results={learned:{success:true}};invalid.push(value);
  value=request();value.config.extra=true;invalid.push(value);
  value=request();value.config.duration=300;invalid.push(value);
  value=request();value.config.motion='invalid';invalid.push(value);
  value=request();value.config.target.x=8;invalid.push(value);
  value=request();value.config.occlusion.enabled='yes';invalid.push(value);
  value=request();value.config.contrast=NaN;invalid.push(value);
  value=request();value.weights[0]=Infinity;invalid.push(value);
  value=request();value.weights[0]=null;invalid.push(value);
  value=request();delete value.weights[0];invalid.push(value);
  value=request();value.weights=[9,9,9,9,9,9];invalid.push(value);
  value=request();value.config=undefined;invalid.push(value);
  invalid.push({},null,'bad JSON');
  for(const body of invalid)assert.equal((await invoke(handlers.verify,{body})).statusCode,400);
});

test('origins accept canonical site, exact deployed preview, and local development without blocking curl',async()=>{
  const handlers=createChallengeHandlers({fetchImpl:offline,deploymentHost:()=> 'zebra-git-challenge-team.vercel.app'});
  const accepted=[{},
    {origin:'https://zebraneural.com'},{origin:'https://www.zebraneural.com'},
    {host:'zebra-git-challenge-team.vercel.app',origin:'https://zebra-git-challenge-team.vercel.app'},
    {host:'localhost:4192',origin:'http://localhost:4192'},
    {host:'127.0.0.1:4192',origin:'http://127.0.0.1:4192'}];
  for(const headers of accepted)assert.equal((await invoke(handlers.weights,{method:'GET',headers})).statusCode,200,JSON.stringify(headers));
  const rejected=[{origin:'null'},{origin:'https://example.com'},
    {origin:'https://zebraneural.com.evil.example'},{origin:'http://zebraneural.com'},
    {host:'other-project.vercel.app',origin:'https://other-project.vercel.app'},
    {host:'zebra-git-challenge-team.vercel.app',origin:'https://zebra-git-challenge-team.vercel.app.evil.example'},
    {host:'localhost:4192',origin:'http://localhost:4193'},
    {host:'localhost:99999',origin:'http://localhost:99999'}];
  for(const headers of rejected)assert.equal((await invoke(handlers.weights,{method:'GET',headers})).statusCode,403,JSON.stringify(headers));
  const invalidEnv=createChallengeHandlers({fetchImpl:offline,deploymentHost:()=> 'attacker.example'});
  assert.equal((await invoke(invalidEnv.weights,{method:'GET',headers:{host:'attacker.example',origin:'https://attacker.example'}})).statusCode,403);
});

test('public cache coalesces requests, retains provenance, and expires after 30 seconds',async()=>{
  let instant=Date.parse('2026-09-12T00:00:00Z'),calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const handlers=createChallengeHandlers({now:()=>instant,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,PUBLIC_WEIGHTS_URL);assert.equal(options.redirect,'error');assert.ok(options.signal instanceof AbortSignal);
    await gate;return {ok:true,json:async()=>publicPayload()};
  }});
  const first=invoke(handlers.weights,{method:'GET'}),second=invoke(handlers.weights,{method:'GET'});
  release();const [a,b]=await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(a.data.cached,false);assert.equal(b.data.cached,true);
  assert.equal(a.data.sourceAt,publicPayload().persistedAt);assert.equal(a.data.championGeneration,337);assert.equal(a.data.sourceUrl,PUBLIC_WEIGHTS_URL);assert.equal(a.data.fallback,false);
  instant+=29999;assert.equal((await invoke(handlers.weights,{method:'GET'})).data.cached,true);assert.equal(calls,1);
  instant++;assert.equal((await invoke(handlers.weights,{method:'GET'})).data.cached,false);assert.equal(calls,2);
});

test('failed or malformed public status produces an explicit validated baseline fallback',async()=>{
  const malformed=publicPayload([9,9,9,9,9,9]);
  for(const fetchImpl of [offline,async()=>({ok:false}),async()=>({ok:true,json:async()=>malformed}),async()=>({ok:true,json:async()=>({...publicPayload(),persistedAt:'bad'})})]) {
    const handlers=createChallengeHandlers({fetchImpl});
    const result=await invoke(handlers.weights,{method:'GET'});assert.equal(result.statusCode,200);
    assert.deepEqual(result.data.weights,[...BASE_WEIGHTS]);assert.equal(result.data.fallback,true);assert.equal(result.data.source,'original-parameters');assert.equal(result.data.sourceAt,null);assert.equal(result.data.sourceUrl,null);
  }
});
