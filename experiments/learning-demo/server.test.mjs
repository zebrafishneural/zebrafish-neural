import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname,basename} from 'node:path';
import {startServer} from './serve.mjs';

async function until(fn){const deadline=Date.now()+20000;while(Date.now()<deadline){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out waiting for isolated demo state.');}
test('local API isolates state, rejects cross-origin mutation, persists and restores trained weights',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'zebra-learning-test-'));
  let app;
  try{
    app=await startServer({port:0,dataDir:directory});
    let base=`http://127.0.0.1:${app.port}`;
    const get=async path=>fetch(base+path);
    const post=async(path,body={},origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    await until(()=>app.getState().trainer);
    assert.equal((await get('/')).status,200);
    assert.equal((await get('/dist/lib/model.js')).status,200);
    assert.equal((await get('/baseline/lib/brain-view.js')).status,200);
    assert.equal((await get('/data/checkpoint.json')).status,404);
    assert.equal((await post('/api/reset',{},'https://example.com')).status,403);
    assert.equal((await post('/api/checkpoint',{invalid:true})).status,400);
    const started=await post('/api/train',{seed:8123,generations:2,pairs:1,trainCount:2,validationCount:2,testCount:2});
    assert.equal(started.status,200,await started.text());
    await until(()=>app.getState().status==='complete');
    const trained=app.getState().trainer;
    assert.equal(trained.generation,2);assert.equal(trained.counters.testRollouts,0);
    const exported=await (await get('/api/checkpoint')).json();
    await app.close();app=null;
    assert.deepEqual(JSON.parse(await readFile(join(directory,'checkpoint.json'),'utf8')),exported);
    app=await startServer({port:0,dataDir:directory});base=`http://127.0.0.1:${app.port}`;
    await until(()=>app.getState().trainer);
    assert.deepEqual(app.getState().trainer.weights,trained.weights);
    assert.equal(app.getState().trainer.generation,2);
    assert.equal((await post('/api/evaluate')).status,200);
    assert.equal(app.getState().trainer.evaluated,true);
    assert.equal((await post('/api/train')).status,400);
    assert.equal((await post('/api/reset',{seed:8123})).status,400);
    assert.equal((await post('/api/reset',{seed:8124})).status,200);
    assert.equal(app.getState().trainer.generation,0);
  }finally{
    if(app)await app.close();
    if(dirname(resolve(directory))===resolve(tmpdir())&&basename(directory).startsWith('zebra-learning-test-'))await rm(directory,{recursive:true,force:true});
  }
});
