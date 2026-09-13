import {Chess} from '/chess/lib/chess.js';

const $=id=>document.getElementById(id);
const repository='https://github.com/zebrafishneural/zebrafish-neural';
let current=null,worker=null,timer=null,generation=0,report=null;
function node(tag,text){const el=document.createElement(tag);el.textContent=text;return el;}
function stop(){worker?.terminate();worker=null;clearTimeout(timer);}
function status(kind,title,detail){$('verification-panel').dataset.status=kind;$('verify-status').textContent=title;$('verify-detail').textContent=detail;}

// Bind a reproducible record to the selected move in the displayed saved game.
// This cross-check does not authenticate the server which supplied that game.
export function decisionContext(game,selected){
  const board=new Chess();let context;
  if(game.moves.length!==game.ply||!Number.isInteger(game.seed)||game.seed<0||game.seed>0xffffffff)throw Error('Invalid saved game history.');
  for(const [index,item] of game.moves.entries()){
    const before=board.fen(),turn=board.turn();
    if(item.ply!==index+1||typeof item.uci!=='string')throw Error('Invalid move history.');
    const move=board.move({from:item.uci.slice(0,2),to:item.uci.slice(2,4),...(item.uci[4]?{promotion:item.uci[4]}:{})});
    if(move.san!==item.san||item.actor!==(turn===game.fishColor?'fish':'human'))throw Error('Move history does not match the saved game.');
    if(item.ply===selected.ply){
      if(item.actor!=='fish'||item.uci!==selected.uci)throw Error('Select a saved fish move.');
      context={gameId:game.id,ply:item.ply,actor:'fish',selectedUci:item.uci,selectedSan:item.san,fen:before,fenBefore:before,fenAfter:board.fen(),seed:(game.seed^Math.imul(item.ply+1,0x9e3779b1))>>>0,weights:[...game.weights],weightsHash:game.weightsHash};
    }
  }
  if(board.fen()!==game.fen||!context)throw Error('The selected move does not match the saved board.');
  return context;
}
export function clearVerification(){
  generation++;stop();current=null;report=null;
  status('idle','Select a fish move','Its position, seed, fixed gains and complete activity record can be replayed here.');
  $('verify-run').disabled=true;$('verify-report').hidden=true;$('verify-checks').replaceChildren();$('verify-meta').hidden=true;
  $('verify-source').href=`${repository}/tree/36effb98570f2562d0e7a0ac443828477cf63ae2/experiments/chess`;
}
export function setVerificationDecision(record,context){
  clearVerification();current={record:structuredClone(record),context};
  status('idle','Not checked',`Ready to replay ${record.selectedSan}. The replay runs locally without changing your game.`);
  $('verify-run').disabled=false;$('verify-meta').hidden=false;
  $('verify-model').textContent=record.modelVersion;$('verify-selector').textContent=record.selectorVersion;$('verify-seed').textContent=String(record.seed);
  $('verify-weights').textContent=record.weights.join(', ');$('verify-weights-hash').textContent=record.weightsHash;$('verify-record-hash').textContent='Computed when you replay this move';
  $('verify-revision').textContent='36effb98570f2562d0e7a0ac443828477cf63ae2';
}
function bindingChecks(record,context){
  return Object.keys(context).filter(key=>JSON.stringify(record[key])!==JSON.stringify(context[key]));
}
function showChecks(checks){
  $('verify-checks').replaceChildren(...checks.map(check=>{const li=node('li',`${check.passed?'✓':'×'} ${check.label}`);li.dataset.passed=String(check.passed);return li;}));
}
function failed(detail){stop();$('verify-run').disabled=!current;status('error','Could not verify',detail);}
async function run(){
  if(!current||worker)return;const id=++generation,{record,context}=current;report=null;$('verify-report').hidden=true;$('verify-checks').replaceChildren();
  const fields=bindingChecks(record,context);
  if(fields.length){status('mismatch','Record does not match this game',`The selected move differs in: ${fields.join(', ')}.`);showChecks([{label:'Selected game, move, position and seed',passed:false}]);return;}
  if(new TextEncoder().encode(JSON.stringify(record)).byteLength>8*1024*1024){failed('The record exceeds the 8 MiB replay limit.');return;}
  status('running','Replaying the controller','Checking source files, then recomputing every comparison.');$('verify-run').disabled=true;
  try{
    worker=new Worker(new URL('./verify-worker.js',import.meta.url),{type:'module'});
    timer=setTimeout(()=>{if(id===generation)failed('Replay timed out. Your game is unaffected; you can try again or use the independent verifier.');},30000);
    worker.onerror=()=>{if(id===generation)failed('The replay worker could not run. Try again or use the independent verifier below.');};
    worker.onmessage=({data})=>{
      if(id!==generation||data.id!==id)return;
      if(data.type==='progress'){$('verify-detail').textContent=`Recomputed ${data.samples} activity samples…`;return;}
      if(data.type==='error'){failed(data.reason);return;}
      if(data.type!=='result')return;
      stop();$('verify-run').disabled=false;
      const {result,manifest,recordHash}=data,c=result.computed;
      report={schemaVersion:1,checkedAt:new Date().toISOString(),recordSha256:recordHash,gameBinding:{passed:true,expected:context},sourceManifest:manifest,replay:result};
      $('verify-record-hash').textContent=recordHash;$('verify-revision').textContent=manifest.modelRevision;
      $('verify-source').href=`${repository}/tree/${manifest.modelRevision}/experiments/chess`;
      if(manifest.verificationRevision){
        $('verify-cli-source').href=`${repository}/tree/${manifest.verificationRevision}/experiments/chess-play/verification`;
        $('verify-commands').textContent=`git clone ${repository}.git\ncd zebrafish-neural\ngit checkout ${manifest.verificationRevision}\nnode experiments/chess-play/verification/cli.mjs /path/to/decision.json`;
      }
      const checks=[{id:'game',label:'Selected game, committed move, position and derived seed',passed:true},{id:'files',label:'Replay source files match the downloadable SHA-256 manifest',passed:true},...result.checks];showChecks(checks);
      $('verify-report').hidden=false;
      if(result.ok)status('verified',c.forcedMove?'Reproduced · only legal move':'Reproduced in your browser',c.forcedMove?`${c.selectedSan} is the only legal move. No neural comparison was needed.`:`${c.selectedSan} matched: ${c.candidateCount} legal moves, ${c.comparisonCount} comparisons and all ${c.sampleCount} activity samples. Numeric tolerance: 10⁻¹².`);
      else status('mismatch',result.status==='invalid'?'Record could not be validated':'Replay mismatch',result.reason);
    };
    worker.postMessage({id,record});
  }catch(error){failed(error.message||'Browser replay is unavailable.');}
}
$('verify-run').onclick=run;
$('verify-report').onclick=()=>{
  if(!report)return;const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`${report.gameBinding.expected.gameId}-ply-${report.gameBinding.expected.ply}-verification.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
};
window.addEventListener('pagehide',()=>{generation++;stop();if(current){$('verify-run').disabled=false;status('idle','Not checked','Replay was interrupted. You can run it again.');}});
