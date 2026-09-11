import {readdir,readFile,stat} from 'node:fs/promises';
import {resolve,relative,extname} from 'node:path';
import {spawnSync} from 'node:child_process';
const root=resolve(import.meta.dirname,'..'),dist=resolve(root,'dist');
async function walk(path){return (await Promise.all((await readdir(path,{withFileTypes:true})).map(e=>e.isDirectory()?walk(resolve(path,e.name)):[resolve(path,e.name)]))).flat();}
const files=await walk(dist);let checked=0;
for(const file of files){
 if(extname(file)==='.js'){const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(result.status)throw Error(result.stderr);checked++;}
 if(extname(file)==='.html'){
  const html=await readFile(file,'utf8');if(!html.includes('<title>')||!html.includes('lang="en"'))throw Error(`Missing metadata: ${file}`);
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){
   const [url]=match[1].split('#');if(!url||/^(https?:|data:|mailto:)/.test(url))continue;
   const pathname=new URL(url,'https://site.invalid/'+relative(dist,file).replaceAll('\\','/')).pathname;
   const target=resolve(dist,'.'+decodeURIComponent(pathname.endsWith('/')?pathname+'index.html':pathname));if(!(await stat(target)).isFile())throw Error(`Missing public asset: ${match[1]}`);
  }
 }
}
try {
 const meta=JSON.parse(await readFile(resolve(root,'.openai/hosting.json'),'utf8'));if(meta.static.directory!=='dist')throw Error('Wrong Sites public root');
} catch(err) {
 if(err.code!=='ENOENT')throw err;
 const config=JSON.parse(await readFile(resolve(root,'vercel.json'),'utf8'));if(config.outputDirectory!=='dist')throw Error('Wrong Vercel public root');
}
console.log(`Checked ${checked} JavaScript modules, HTML entrypoints, metadata and local assets.`);
