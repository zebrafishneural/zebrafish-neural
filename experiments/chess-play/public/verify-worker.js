const paths=[
  'experiments/chess/lib/selector.mjs',
  'experiments/chess/public/lib/model.js',
  'experiments/chess/public/lib/chess.js',
  'experiments/chess/public/lib/chess-LICENSE.txt',
  'experiments/chess-play/verification/verify.mjs'
];
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
async function readAsset(path,maxBytes){
  const response=await fetch(new URL(`./replay/${path}`,import.meta.url),{cache:'no-store',credentials:'omit',redirect:'error'});
  if(!response.ok)throw Error('The replay source could not be loaded.');
  const bytes=await response.arrayBuffer();if(bytes.byteLength>maxBytes)throw Error('The replay source exceeds its size limit.');return bytes;
}
let used=false;
self.onmessage=async({data})=>{
  if(used)return;used=true;const {id,record}=data;
  try{
    const manifest=JSON.parse(new TextDecoder().decode(await readAsset('source-manifest.json',12000)));
    if(manifest.schemaVersion!==1||!Array.isArray(manifest.files)||manifest.files.length!==paths.length||!/^[a-f0-9]{40}$/.test(manifest.modelRevision)||!(manifest.verificationRevision===null||/^[a-f0-9]{40}$/.test(manifest.verificationRevision))||!/^[a-f0-9]{64}$/.test(manifest.bundleHash)||await hash(new TextEncoder().encode(JSON.stringify(manifest.files)))!==manifest.bundleHash)throw Error('The replay manifest is invalid.');
    for(const path of paths){
      const entries=manifest.files.filter(item=>item.path===path);
      if(entries.length!==1||!/^[a-f0-9]{64}$/.test(entries[0].sha256)||await hash(await readAsset(`bundles/${manifest.bundleHash}/${path}`,2*1024*1024))!==entries[0].sha256)throw Error('The replay source does not match its file manifest. Reload before trying again.');
    }
    const recordHash=await hash(new TextEncoder().encode(JSON.stringify(record)));
    const {verifyDecision}=await import(`./replay/bundles/${manifest.bundleHash}/experiments/chess-play/verification/verify.mjs`);
    const result=await verifyDecision(record,{onProgress:progress=>self.postMessage({type:'progress',id,...progress})});
    self.postMessage({type:'result',id,result,recordHash,manifest});
  }catch(error){self.postMessage({type:'error',id,reason:error.message||'Replay could not run in this browser.'});}
};
