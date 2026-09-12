import {cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const target=resolve(root,'dist/chess');
let config;
try{config=await readFile(resolve(target,'chess-config.json'),'utf8');JSON.parse(config);}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(target,{recursive:true});
await cp(resolve(root,'experiments/chess/public'),target,{recursive:true});
if(config!==undefined)await writeFile(resolve(target,'chess-config.json'),config);
console.log('Built chess frontend; existing endpoint configuration retained. No runtime data copied.');
