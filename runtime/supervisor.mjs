import {spawn} from 'node:child_process';
import {openSync,closeSync,writeFileSync,mkdirSync,existsSync,unlinkSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const here=fileURLToPath(new URL('.',import.meta.url)),data=resolve(here,'data');
mkdirSync(data,{recursive:true});
const pidPath=resolve(data,'host-processes.json'),stopPath=resolve(data,'stop-host');
if(existsSync(stopPath))unlinkSync(stopPath);
let child=null,stopping=false,timer=null;
function start(){
 if(stopping)return;
 const out=openSync(resolve(data,'host.log'),'a');
 child=spawn(process.execPath,[resolve(here,'server.mjs')],{cwd:resolve(here,'..'),windowsHide:true,stdio:['ignore',out,out]});closeSync(out);
 writeFileSync(pidPath,JSON.stringify({supervisor:process.pid,runtime:child.pid,startedAt:new Date().toISOString()}));
 child.on('error',()=>{});child.on('exit',()=>{child=null;if(!stopping)timer=setTimeout(start,5000);});
}
function stop(){if(stopping)return;stopping=true;clearTimeout(timer);child?.kill('SIGTERM');setTimeout(()=>process.exit(0),3000);}
setInterval(()=>{if(existsSync(stopPath))stop();},1000);
process.on('SIGINT',stop);process.on('SIGTERM',stop);start();
