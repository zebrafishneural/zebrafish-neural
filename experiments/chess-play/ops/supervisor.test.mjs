import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,unlink,access,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {setTimeout as pause} from 'node:timers/promises';

const supervisor=resolve(import.meta.dirname,'host-service.mjs');
async function fixture(script){
 const root=await mkdtemp(join(tmpdir(),'zebra-play-supervisor-'));
 for(const dir of ['ops','app','data','logs','runtime'])await mkdir(join(root,dir));
 const entrypoint=join(root,'app','server.mjs');await writeFile(entrypoint,script);
 const config={root,entrypoint,nodeExecutable:process.execPath,dataDir:join(root,'data'),logsDir:join(root,'logs'),runtimeDir:join(root,'runtime'),port:4200,origins:['https://zebraneural.com'],trustProxy:'loopback'};
 const configPath=join(root,'ops','service.json');await writeFile(configPath,JSON.stringify(config));
 return {root,config,configPath,gate:join(root,'ops','production.enabled'),owner:join(root,'runtime','owner.json')};
}
function start(configPath){
 const child=spawn(process.execPath,[supervisor,configPath],{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 return {child,exit:new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal,output})))};
}
async function until(fn,timeout=6000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}await pause(40);}throw last||Error('Condition timed out.');}
async function exists(path){try{await access(path);return true;}catch{return false;}}

test('missing gate creates neither backend data nor ownership record',async()=>{
 const f=await fixture(`import{writeFileSync}from'node:fs';export async function startPlayServer(){writeFileSync(process.env.PLAY_DATA_DIR+'/unexpected','started');}`);
 const result=await start(f.configPath).exit;
 assert.equal(result.code,0,result.output);assert.equal(await exists(f.owner),false);assert.equal(await exists(join(f.config.dataDir,'unexpected')),false);
});

test('gate controls one service process, passes isolated settings, and bounds logs',async()=>{
 const f=await fixture(`import{writeFileSync}from'node:fs';export async function startPlayServer(){writeFileSync(process.env.PLAY_DATA_DIR+'/settings.json',JSON.stringify({port:process.env.PLAY_PORT,origins:process.env.PLAY_ORIGINS,proxy:process.env.PLAY_TRUST_PROXY}));for(let i=0;i<105;i++)process.stdout.write('x'.repeat(65536));const timer=setInterval(()=>{},1000);return{close:async()=>clearInterval(timer)};}`);
 await writeFile(f.gate,'test only');const running=start(f.configPath);
 try{
  const settings=await until(async()=>JSON.parse(await readFile(join(f.config.dataDir,'settings.json'),'utf8')));
  assert.deepEqual(settings,{port:'4200',origins:'https://zebraneural.com',proxy:'loopback'});
  const owner=await until(async()=>JSON.parse(await readFile(f.owner,'utf8')));assert.equal(owner.pid,running.child.pid);assert.equal(owner.entrypoint,f.config.entrypoint);
  await until(()=>exists(join(f.config.logsDir,'stdout.log.1')));
  await unlink(f.gate);
  const result=await Promise.race([running.exit,pause(6000).then(()=>{throw Error('Gate removal did not stop supervisor.');})]);
  assert.equal(result.code,0,result.output);assert.equal(await exists(f.owner),false);
  for(const name of await readdir(f.config.logsDir))assert.ok((await stat(join(f.config.logsDir,name))).size<=5*1024*1024);
 }finally{if(await exists(f.gate))await unlink(f.gate);if(running.child.exitCode===null)running.child.kill();}
});

test('service startup failure returns failure for Task Scheduler recovery',async()=>{
 const f=await fixture('export async function startPlayServer(){throw Error("Deliberate startup failure");}');await writeFile(f.gate,'test only');const result=await start(f.configPath).exit;
 assert.equal(result.code,1,result.output);assert.equal(await exists(f.owner),false);
});

test('unsafe state path fails closed before importing backend code',async()=>{
 const f=await fixture('process.exit(0);');f.config.dataDir=tmpdir();await writeFile(f.configPath,JSON.stringify(f.config));await writeFile(f.gate,'test only');
 const result=await start(f.configPath).exit;assert.notEqual(result.code,0);assert.equal(await exists(f.owner),false);
});
