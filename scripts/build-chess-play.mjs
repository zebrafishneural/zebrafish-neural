import {cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),target=resolve(root,'dist/play');
let config;try{config=await readFile(resolve(target,'play-config.json'),'utf8');JSON.parse(config);}catch(error){if(error.code!=='ENOENT')throw error;}
await mkdir(target,{recursive:true});await cp(resolve(root,'experiments/chess-play/public'),target,{recursive:true});
if(config!==undefined)await writeFile(resolve(target,'play-config.json'),config);
// LF is the canonical Git blob representation. Pin the original model without
// depending on Git history being available in a frontend hosting build.
const pin=JSON.parse(await readFile(resolve(root,'experiments/chess-play/verification/source-pin.json'),'utf8'));
const manifest={schemaVersion:1,modelRevision:pin.modelRevision,verificationRevision:pin.verificationRevision,files:[]},assets=[];
for(const source of [...Object.keys(pin.files),'experiments/chess-play/verification/verify.mjs']){
  const bytes=Buffer.from((await readFile(resolve(root,source),'utf8')).replaceAll('\r\n','\n'));
  const sha256=createHash('sha256').update(bytes).digest('hex');
  if(pin.files[source]&&pin.files[source]!==sha256)throw Error(`Pinned model source changed: ${source}`);
  if(source.endsWith('/verification/verify.mjs')&&pin.verificationRevision&&pin.verificationSha256!==sha256)throw Error('Verifier source differs from its pinned verification release.');
  assets.push({source,bytes});
  manifest.files.push({path:source,sha256});
}
// Content-addressed paths prevent a later deployment from replacing the code at
// a module URL between the Worker's hash fetch and the browser's module import.
manifest.bundleHash=createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
for(const {source,bytes} of assets){const file=resolve(target,'replay/bundles',manifest.bundleHash,source);await mkdir(dirname(file),{recursive:true});await writeFile(file,bytes);}
await writeFile(resolve(target,'replay/source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
if(pin.verificationRevision){
  const indexPath=resolve(target,'index.html'),html=await readFile(indexPath,'utf8');
  await writeFile(indexPath,html.replace('git checkout codex/you-vs-the-fish',`git checkout ${pin.verificationRevision}`).replace('/tree/codex/you-vs-the-fish/experiments/chess-play/verification',`/tree/${pin.verificationRevision}/experiments/chess-play/verification`));
}
console.log('Built the separate human-vs-fish frontend. Existing feed settings and all runtime data are preserved.');
