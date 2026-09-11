import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const source=resolve(root,'experiments/learning-live');
const html=(await readFile(resolve(source,'index.html'),'utf8'))
  .replaceAll('./live.css','./learning.css').replaceAll('./live.js','./learning.js')
  .replaceAll('href="/live.css"','href="./learning.css"').replaceAll('src="/live.js"','src="./learning.js"')
  .replaceAll('/baseline/','./').replaceAll('class="current" href="./"','class="current" href="./learning.html"');
const js=(await readFile(resolve(source,'live.js'),'utf8'))
  .replaceAll('/baseline/','./').replaceAll("'/core.js'","'./lib/learning-core.js'").replaceAll("'./core.js'","'./lib/learning-core.js'")
  .replaceAll('"/core.js"','"./lib/learning-core.js"').replaceAll('"./core.js"','"./lib/learning-core.js"');
const core=(await readFile(resolve(root,'experiments/learning-demo/core.js'),'utf8')).replaceAll('../../dist/lib/model.js','./model.js');
await writeFile(resolve(root,'dist/learning.html'),html);
await writeFile(resolve(root,'dist/learning.js'),js);
await writeFile(resolve(root,'dist/learning.css'),await readFile(resolve(source,'live.css'),'utf8'));
await writeFile(resolve(root,'dist/lib/learning-core.js'),core);
const configPath=resolve(root,'dist/learning-config.json');
try{await readFile(configPath);}catch(error){
  if(error.code!=='ENOENT')throw error;
  await writeFile(configPath,JSON.stringify({endpoint:''})+'\n');
}
console.log('Built the read-only learning view. The shared Wikipedia frontend is unchanged.');
