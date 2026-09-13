import {cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'),target=resolve(root,'dist/play');
let config;try{config=await readFile(resolve(target,'play-config.json'),'utf8');JSON.parse(config);}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(target,{recursive:true});await cp(resolve(root,'experiments/chess-play/public'),target,{recursive:true});
if(config!==undefined)await writeFile(resolve(target,'play-config.json'),config);
console.log('Built the separate human-vs-fish frontend. Existing feed settings and all runtime data are preserved.');
