// One scheduled-task process owns the backend. There is no orphanable child.
import {existsSync,readFileSync,mkdirSync,appendFileSync,statSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {resolve,join,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

const configPath=process.argv[2];
if(!configPath||!isAbsolute(configPath))throw Error('Pass the absolute service.json path.');
const config=JSON.parse(readFileSync(configPath,'utf8').replace(/^\uFEFF/,''));
const root=resolve(config.root),gate=join(root,'ops','production.enabled');
const underRoot=value=>isAbsolute(value)&&resolve(value).toLowerCase().startsWith(root.toLowerCase()+sep);
for(const key of ['entrypoint','dataDir','logsDir','runtimeDir'])if(!underRoot(config[key]))throw Error(`Unsafe ${key} in service configuration.`);
if(!isAbsolute(config.nodeExecutable)||!existsSync(config.nodeExecutable))throw Error('Node executable is unavailable.');
if(!existsSync(gate)){console.log('Production gate absent; no service started.');process.exit(0);}
if(config.port!==4200||config.trustProxy!=='loopback')throw Error('Unexpected production port/proxy configuration.');
if(!Array.isArray(config.origins)||config.origins.length===0||config.origins.some(value=>!/^https:\/\/[a-z0-9.-]+$/.test(value)))throw Error('Exact HTTPS origins required.');
for(const path of [config.dataDir,config.logsDir,config.runtimeDir])mkdirSync(path,{recursive:true});

function appendLog(name,chunk){
 const file=join(config.logsDir,name+'.log'),max=5*1024*1024;
 if(existsSync(file)&&statSync(file).size+chunk.length>max){
  for(let i=3;i>=0;i--){const source=i?file+'.'+i:file,target=file+'.'+(i+1);if(!existsSync(source))continue;if(existsSync(target))unlinkSync(target);renameSync(source,target);}
 }
 // Truncate a single pathological chunk, so one write cannot defeat the bound.
 appendFileSync(file,chunk.length>max?chunk.subarray(chunk.length-max):chunk);
}

const ownerFile=join(config.runtimeDir,'owner.json');
function releaseOwner(){try{if(JSON.parse(readFileSync(ownerFile,'utf8')).pid===process.pid)unlinkSync(ownerFile);}catch{}}
for(const name of ['stdout','stderr'])process[name].write=(chunk,encoding,callback)=>{
 if(typeof encoding==='function'){callback=encoding;encoding=undefined;}
 appendLog(name,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk,encoding));
 if(callback)queueMicrotask(callback);return true;
};
Object.assign(process.env,{PLAY_PORT:String(config.port),PLAY_DATA_DIR:config.dataDir,
 PLAY_ORIGINS:config.origins.join(','),PLAY_TRUST_PROXY:config.trustProxy,
 PLAY_MAX_GAMES:'128',PLAY_MAX_JOBS:'2',PLAY_MAX_PLIES:'160',PLAY_SESSION_HOURS:'24',PLAY_MAX_DATA_BYTES:String(512*1024*1024)});
let app,timer,stopping=false;
async function stop(code=0){
 if(stopping)return;stopping=true;clearInterval(timer);
 // The normal gate-based stop calls the backend's graceful close in this process.
 const deadline=setTimeout(()=>process.exit(1),15000);deadline.unref();
 try{await app?.close();}catch(error){appendLog('stderr',Buffer.from(`Shutdown failed: ${error.message}\n`));code=1;}
 releaseOwner();clearTimeout(deadline);process.exitCode=code;
}
process.on('exit',releaseOwner);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void stop());
process.on('beforeExit',()=>{if(!stopping){releaseOwner();process.exitCode=1;}});
try{
 const {startPlayServer}=await import(pathToFileURL(config.entrypoint));
 if(typeof startPlayServer!=='function')throw Error('Expected the reviewed play-service entry point.');
 app=await startPlayServer({port:config.port,dataDir:config.dataDir,origins:config.origins,trustProxy:config.trustProxy});
 writeFileSync(ownerFile,JSON.stringify({pid:process.pid,entrypoint:config.entrypoint,startedAt:new Date().toISOString()},null,2));
 appendLog('stdout',Buffer.from(`Play service started ${new Date().toISOString()} on loopback ${config.port}.\n`));
 timer=setInterval(()=>{if(!existsSync(gate))void stop();},1000);timer.unref();
 if(!existsSync(gate))await stop();
}catch(error){appendLog('stderr',Buffer.from(`Service start failed: ${error.message}\n`));await stop(1);}
