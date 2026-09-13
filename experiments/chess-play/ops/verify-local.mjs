// Exercise the external verifier against an isolated loopback service.
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {startPlayServer} from '../server.mjs';

const dataDir=await mkdtemp(join(tmpdir(),'zebra-play-edge-check-'));
const app=await startPlayServer({port:0,dataDir});
try{
 const child=spawn(process.execPath,[resolve(import.meta.dirname,'verify-public.mjs'),`http://127.0.0.1:${app.port}`,'https://zebraneural.com'],{windowsHide:true,stdio:'inherit'});
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 process.exitCode=code||0;
}finally{await app.close();}
