import {createServer} from 'node:http';
import {Worker} from 'node:worker_threads';
import {readFile, mkdir, rename, copyFile, open, readdir} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {importLearner, exportLearner} from './learner.js';

const root = import.meta.dirname;
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const filename = generation => `generation-${String(generation).padStart(12, '0')}.json`;
const metricSummary = value => {
  if(!value) return value;
  const {caseResults,...metrics}=value;return metrics;
};
function auditSummary(value) {
  if(!value) return value;
  return {...value,baseline:metricSummary(value.baseline),champion:metricSummary(value.champion),
    noInput:{baseline:metricSummary(value.noInput.baseline),champion:metricSummary(value.noInput.champion)}};
}
function observerState(value) {
  if(!value.learner) return value;
  const {optimizer,rng,historyAnchor,...learner}=value.learner;
  for(const key of ['baselineValidation','championValidation','currentValidation','lastTrain'])learner[key]=metricSummary(learner[key]);
  learner.latestAudit=auditSummary(learner.latestAudit);
  learner.history=learner.history.map(row=>({generation:row.generation,trainSeed:row.trainSeed,
    train:metricSummary(row.train),validation:metricSummary(row.validation),gate:row.gate,
    championGeneration:row.championGeneration,championValidationScore:row.championValidationScore,
    weights:row.weights,championWeights:row.championWeights}));
  const record=value.latestRecord;
  return {...value,snapshotKind:'observer',learner,latestRecord:record?{generation:record.generation,createdAt:record.createdAt,hash:record.hash,previousHash:record.previousHash}:null};
}
async function atomicJSON(path, value) {
  const pending = path + '.pending';
  const file = await open(pending, 'w');
  try {await file.writeFile(JSON.stringify(value) + '\n'); await file.sync();} finally {await file.close();}
  await rename(pending, path);
}

export async function startServer({port=4189, dataDir=resolve(root,'data'), intervalMs=15000, config={}, autoStart=true, beforePersist=null}={}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 0) throw new Error('Invalid generation interval');
  await mkdir(resolve(dataDir,'records'), {recursive:true});
  const checkpointPath = resolve(dataDir, 'checkpoint.json');
  let committed = null;
  try {
    committed = JSON.parse(await readFile(checkpointPath, 'utf8'));
    if (committed.schemaVersion !== 1 || committed.generation !== committed.learner?.generation || hash(committed.learner) !== committed.learnerHash) throw new Error('Checkpoint integrity check failed');
    importLearner(committed.learner);
    const record = JSON.parse(await readFile(resolve(dataDir,'records',filename(committed.generation)), 'utf8'));
    if (hash(record) !== committed.recordHash) throw new Error('Committed record does not match checkpoint');
  } catch (error) {if (error.code !== 'ENOENT' || committed !== null) throw error;}
  const startedAt = new Date().toISOString();
  let state = {schemaVersion:1,status:'starting',startedAt,serverAt:startedAt,nextGenerationAt:null,persistedAt:committed?.persistedAt||null,learner:committed?.learner||null,error:null,latestRecord:null};
  let timer = null, closing = false, processing = Promise.resolve(), failed = false;
  const worker = new Worker(new URL('./worker.mjs',import.meta.url), {workerData:{checkpoint:committed?.learner,config}});
  const publicState = () => ({...state,serverAt:new Date().toISOString()});
  async function persist(learner, row=null) {
    if (beforePersist) await beforePersist({learner,row});
    const persistedAt = new Date().toISOString();
    const record = {schemaVersion:1,generation:learner.generation,createdAt:persistedAt,
      previousHash:committed?.recordHash||null,learnerVersion:learner.learnerVersion||learner.version,
      config:learner.config,weights:learner.weights,championWeights:learner.championWeights,
      championGeneration:learner.championGeneration,row,
      audit:learner.latestAudit?.generation===learner.generation?learner.latestAudit:null,
      counters:learner.counters};
    const next = {schemaVersion:1,generation:learner.generation,persistedAt,
      learnerHash:hash(learner),recordHash:hash(record),learner};
    // Uncommitted record files are never exposed; checkpoint.json is the commit point.
    await atomicJSON(resolve(dataDir,'records',filename(learner.generation)), record);
    if (committed) {
      await copyFile(checkpointPath, resolve(dataDir,'checkpoint.previous.json.pending'));
      await rename(resolve(dataDir,'checkpoint.previous.json.pending'), resolve(dataDir,'checkpoint.previous.json'));
    }
    await atomicJSON(checkpointPath, next);
    committed = next;
    state = {...state,learner,persistedAt,latestRecord:{...record,hash:next.recordHash},error:null};
  }
  function schedule() {
    if (closing || failed || !autoStart) {state={...state,status:failed?'error':'paused',nextGenerationAt:null}; return;}
    state={...state,status:'waiting',nextGenerationAt:new Date(Date.now()+intervalMs).toISOString()};
    timer=setTimeout(()=>{if(closing||failed)return;state={...state,status:'training',nextGenerationAt:null};worker.postMessage({command:'advance'});},intervalMs);
  }
  function fail(error) {
    failed=true;clearTimeout(timer);
    state={...state,status:'error',nextGenerationAt:null,error:'Learning paused because the next generation could not be completed and saved. The last committed checkpoint is retained.'};
    worker.postMessage({command:'discard'});
    console.error('Learning process paused:',error.message);
  }
  worker.on('message', message => {
    processing=processing.then(async()=>{
      if (closing) return;
      if (message.type==='failure') {fail(new Error(message.error));return;}
      if (message.type==='ready') {
        if (!committed) await persist(message.learner);
        else {state={...state,learner:exportLearner(importLearner(committed.learner)),latestRecord:{...JSON.parse(await readFile(resolve(dataDir,'records',filename(committed.generation)),'utf8')),hash:committed.recordHash}};}
        schedule();
      } else if (message.type==='proposal') {
        await persist(message.learner,message.row);
        worker.postMessage({command:'commit'});
        schedule();
      }
    }).catch(fail);
  });
  worker.on('error', fail);
  worker.on('exit',code=>{if(!closing&&code!==0)fail(new Error(`Worker exited (${code})`));});

  async function records(date=null) {
    if (!committed) return {schemaVersion:1,throughGeneration:null,records:[]};
    const throughGeneration=committed.generation;
    const names=(await readdir(resolve(dataDir,'records'))).filter(name=>/^generation-\d{12}\.json$/.test(name)&&Number(name.slice(11,-5))<=throughGeneration).sort();
    const selected=date?names:names.slice(-100);
    const rows=[];
    for (const name of selected) {
      const value=JSON.parse(await readFile(resolve(dataDir,'records',name),'utf8'));
      if (!date||value.createdAt.slice(0,10)===date) rows.push({...value,hash:hash(value)});
    }
    return {schemaVersion:1,throughGeneration,coverage:date?`Committed records dated ${date} UTC`:'Latest 100 committed generation records',records:rows};
  }
  const server=createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    const actualPort=server.address()?.port;
    const allowedOrigins=new Set(['https://zebraneural.com','https://www.zebraneural.com',`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`]);
    if(req.headers.origin){if(!allowedOrigins.has(req.headers.origin)){res.writeHead(403).end();return;}res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Vary','Origin');}
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':mime['.json']});res.end(req.method==='HEAD'?undefined:JSON.stringify(value));};
    try {
      if(!['GET','HEAD'].includes(req.method)){res.setHeader('Allow','GET, HEAD');json(405,{error:'This observer endpoint is read-only.'});return;}
      const url=new URL(req.url,'http://localhost');
      if(url.pathname==='/learning-config.json'){json(200,{endpoint:''});return;}
      if(url.pathname==='/api/status'){json(200,observerState(publicState()));return;}
      if(url.pathname==='/api/checkpoint'){
        if(!committed){json(503,{error:'The first checkpoint has not been saved yet.'});return;}
        res.setHeader('Content-Disposition','attachment; filename="zebrafish-persistent-learning-checkpoint.json"');json(200,committed);return;
      }
      if(url.pathname==='/api/records'){
        const date=url.searchParams.get('date');
        if(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)){json(400,{error:'Use a UTC date in YYYY-MM-DD format.'});return;}
        res.setHeader('Content-Disposition','attachment; filename="zebrafish-learning-records.json"');json(200,await records(date));return;
      }
      const pathname=decodeURIComponent(url.pathname);
      const files={'/':'index.html','/index.html':'index.html','/live.css':'live.css','/live.js':'live.js','/learner.js':'learner.js','/README.md':'README.md'};
      let file;
      if(pathname==='/core.js') file=resolve(root,'../learning-demo/core.js');
      else if(pathname.startsWith('/baseline/')||pathname.startsWith('/dist/')) {
        const prefix=pathname.startsWith('/baseline/')?'/baseline/':'/dist/';const base=resolve(root,'../../dist');file=resolve(base,pathname.slice(prefix.length));
        if(!file.startsWith(base+sep)||pathname.split('/').some(p=>p.startsWith('.'))){json(403,{error:'Forbidden'});return;}
      } else if(files[pathname]) file=resolve(root,files[pathname]);
      else {json(404,{error:'Not found'});return;}
      const data=await readFile(file);res.writeHead(200,{'Content-Type':mime[extname(file)]||'text/plain; charset=utf-8'});res.end(req.method==='HEAD'?undefined:data);
    } catch(error) {json(error.code==='ENOENT'?404:500,{error:'The learning service could not serve this request.'});}
  });
  await new Promise((ready,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',ready);});
  return {server,port:server.address().port,getState:publicState,close:async()=>{closing=true;clearTimeout(timer);await worker.terminate();await processing;await new Promise(done=>server.close(done));}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=await startServer({port:Number(process.env.LEARNING_PORT||4189),intervalMs:Number(process.env.LEARNING_INTERVAL_MS||15000)});
  console.log(`Persistent learning: http://127.0.0.1:${app.port}/`);
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
}
