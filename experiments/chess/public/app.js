import {BrainView} from './lib/brain-view.js';
import {REGIONS} from './lib/model.js';
import {ChessBoard} from './board.js';

const $=id=>document.getElementById(id);
const number=(value,digits=3)=>Number.isFinite(value)?value.toFixed(digits):'—';
const signed=(value,digits=4)=>Number.isFinite(value)?`${value>0?'+':''}${value.toFixed(digits)}`:'—';
const time=value=>Number.isFinite(Date.parse(value))?`${new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'UTC'}).format(new Date(value))} UTC`:'—';
const short=value=>typeof value==='string'&&value.length>20?`${value.slice(0,8)}…${value.slice(-6)}`:String(value??'—');
const actorLabel={fish:'Controller',opponent:'Opponent',opening:'Opening'};
const phases={selecting:'Comparing moves',opponent:'Opponent to move',committed:'Move committed',between_games:'Between games',error:'Game reported an error'};
let snapshot=null,streamId=null,lastSeq=-1,lastReceived=0,lastSample=null,lastSampleGame=null,connectionOnline=false;
let socket=null,reconnectTimer=null,connecting=false,reconnectAttempt=0,historyGame=null,historySelection='live',selectedMoveKey=null,inspectorRequest=0;
let moveSignature='',gamesSignature='',archiveLoading=false,comparisonKey='',trace=[];
let httpBase=location.origin,wsUrl=new URL('/ws',location.href),transportReady=false;
let fishView=null,fishVisible=true;
wsUrl.protocol=location.protocol==='https:'?'wss:':'ws:';
const board=new ChessBoard($('chess-board'));
const brain=new BrainView($('brain'));brain.setData(null,'model');
const retinaScratch=document.createElement('canvas');retinaScratch.width=32;retinaScratch.height=16;
const retinaScratchContext=retinaScratch.getContext('2d'),retinaContext=$('retina').getContext('2d');
const rows=[0,1,2,3,5,6,4,7].map(index=>{
  const row=document.createElement('div');row.className='rate';const label=document.createElement('span');label.textContent=REGIONS[index].name;
  const value=document.createElement('output');value.textContent='—';const meter=document.createElement('div');meter.className='rate-meter';const fill=document.createElement('i');meter.append(fill);row.append(label,value,meter);$('rates').append(row);return {index,row,value,fill};
});
function el(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;}
function gamePath(id,suffix=''){return `/api/games/${encodeURIComponent(id)}${suffix}`;}
function apiURL(path){if(!path.startsWith('/api/'))throw Error('Unsupported record route.');return `${httpBase}${path}`;}
function localHost(host){return ['localhost','127.0.0.1','[::1]'].includes(host);}
function transportURL(value,kind){
  if(typeof value!=='string'||!value.trim())throw Error('Invalid chess connection configuration.');
  const url=new URL(value);
  const secure=kind==='http'?'https:':'wss:',insecure=kind==='http'?'http:':'ws:';
  if((url.protocol!==secure&&!(url.protocol===insecure&&localHost(url.hostname)&&localHost(location.hostname)))||url.username||url.password||url.search||url.hash)throw Error('Invalid chess connection configuration.');
  return url;
}
async function configureTransport(){
  try{
    const config=await readJSON(new URL('./chess-config.json',location.href));
    if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Invalid chess connection configuration.');
    if(config.httpBase!==undefined&&config.httpBase!=='')httpBase=transportURL(config.httpBase,'http').href.replace(/\/+$/,'');
    if(config.wsUrl!==undefined&&config.wsUrl!=='')wsUrl=transportURL(config.wsUrl,'ws');
    else{wsUrl=new URL(`${httpBase}/ws`);wsUrl.protocol=wsUrl.protocol==='https:'?'wss:':'ws:';}
    transportReady=true;
  }catch(error){if(error.status===404)transportReady=true;else throw error;}
}
async function readJSON(url){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{const response=await fetch(url,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});if(!response.ok){const error=Error(`The record is unavailable (${response.status}).`);error.status=response.status;throw error;}if(!(response.headers.get('content-type')||'').includes('application/json'))throw Error('The server did not return a JSON record.');return await response.json();}finally{clearTimeout(timer);}
}
function getJSON(path){return readJSON(apiURL(path));}
function validRates(value){return Array.isArray(value)&&value.length===8&&value.every(rate=>Number.isFinite(rate)&&rate>=0&&rate<=1);}
function validGame(game){
  return game&&typeof game.id==='string'&&typeof game.fen==='string'&&['w','b'].includes(game.fishColor)&&['w','b'].includes(game.turn)&&Number.isInteger(game.ply)&&Array.isArray(game.moves)&&game.moves.every(move=>Number.isInteger(move.ply)&&typeof move.san==='string'&&['fish','opponent','opening'].includes(move.actor));
}
function validateState(state){
  if(!state||state.schemaVersion!==1||!Number.isInteger(state.seq)||typeof state.streamId!=='string'||typeof state.sentAt!=='string'||!Object.hasOwn(phases,state.status)||!validGame(state.game))throw Error('Unsupported shared-game snapshot.');
  if(!state.stats||!['games','wins','draws','losses'].every(key=>Number.isInteger(state.stats[key])&&state.stats[key]>=0))throw Error('Invalid recorded game totals.');
  if(state.selection!==null&&state.selection!==undefined){const s=state.selection;if(!validRates(s.rates)||!Array.isArray(s.retina)||s.retina.length!==512||s.retina.some(value=>!Number.isFinite(value)||value<0||value>1)||!Number.isFinite(s.modelTime)||!Number.isFinite(s.margin)||!s.left||!s.right||typeof s.left.san!=='string'||typeof s.right.san!=='string'||!['forward','swapped'].includes(s.orientation))throw Error('Invalid controller comparison sample.');}
  return state;
}
function setConnection(online,message){
  connectionOnline=online;$('connection-state').dataset.online=String(online);$('connection-state').textContent=online?'Connected':'Connection interrupted';
  $('connection-detail').textContent=message||'The last received position and model sample are retained.';
  $('connection-notice').hidden=online;
  $('connection-notice').textContent='No fresh shared-state message has arrived. The board and brain retain the last received data; they do not continue locally.';
  if(!online){$('brain-sample-state').textContent='CONNECTION INTERRUPTED';applyFish(true);}
}
function applyFish(paused=!connectionOnline||!snapshot?.selection){
  if(!fishView||!lastSample)return;
  fishView.setState({rates:[...lastSample.rates],drive:lastSample.rates[7],turn:lastSample.rates[5]-lastSample.rates[6],time:lastSample.modelTime,paused});
}
async function loadFish(){
  try{
    const {FishView}=await import('./fish/viewer.js');
    fishView=new FishView($('fish-body'),{mode:'body',interactive:true});fishView.setView('side');
    fishView.setActive(fishVisible&&!document.hidden);$('fish-placeholder').hidden=true;applyFish();
  }catch(error){$('fish-placeholder').textContent='The 3D body is unavailable in this browser.';}
}
function scheduleReconnect(){
  clearTimeout(reconnectTimer);const delay=Math.min(10000,800*2**Math.min(reconnectAttempt++,4));
  reconnectTimer=setTimeout(connect,delay);
}
async function connect(){
  if(connecting)return;connecting=true;clearTimeout(reconnectTimer);
  const previous=socket;socket=null;if(previous){previous.onclose=null;previous.close();}
  try{
    if(!transportReady)await configureTransport();
    const state=validateState(await getJSON('/api/state'));lastSeq=-1;receive(state);
    const ws=new WebSocket(wsUrl.href);socket=ws;
    ws.onopen=()=>{if(socket!==ws)return;reconnectAttempt=0;};
    ws.onmessage=event=>{if(socket!==ws)return;try{receive(validateState(JSON.parse(event.data)));}catch(error){setConnection(false,'The shared state could not be validated. Reconnecting.');ws.close();}};
    ws.onclose=()=>{if(socket!==ws)return;socket=null;setConnection(false,snapshot?`Last shared snapshot ${time(snapshot.sentAt)}.`:'Waiting for the shared game.');scheduleReconnect();};
    ws.onerror=()=>{if(socket===ws)ws.close();};
  }catch(error){setConnection(false,snapshot?`Last shared snapshot ${time(snapshot.sentAt)}.`:'The shared game is unavailable. Retrying.');scheduleReconnect();}
  finally{connecting=false;}
}
function receive(state){
  lastReceived=performance.now();setConnection(true,`Shared snapshot ${time(state.sentAt)}.`);
  if(state.streamId!==streamId){streamId=state.streamId;lastSeq=-1;comparisonKey='';trace=[];}
  if(state.seq<=lastSeq)return;lastSeq=state.seq;snapshot=state;
  const game=state.game;
  $('game-id').textContent=short(game.id);$('game-id').title=game.id;$('fish-color').textContent=game.fishColor==='w'?'White':'Black';
  $('fish-side').textContent=game.fishColor==='w'?'White':'Black';$('fish-side-chip').textContent=game.fishColor==='w'?'W':'B';$('fish-side-chip').dataset.side=game.fishColor;
  const fishMove=game.moves.findLast(move=>move.actor==='fish');$('fish-last-move').textContent=fishMove?`Last controller move: ${Math.ceil(fishMove.ply/2)}${fishMove.ply%2?'.':'…'} ${fishMove.san}`:'Waiting for the controller’s first move.';
  $('game-phase').textContent=phases[state.status];$('game-count').textContent=state.stats.games.toLocaleString('en-US');$('score').textContent=`${state.stats.wins} / ${state.stats.draws} / ${state.stats.losses}`;
  $('opponent-label').textContent=game.opponent;$('weights-label').textContent=game.weightsLabel;
  board.setPosition(game.fen,game.moves.at(-1));$('board-empty').hidden=true;
  const outcome=game.result?.outcome;
  $('board-status').textContent=outcome?`${outcome==='win'?'Controller win':outcome==='loss'?'Controller loss':'Draw'} · ${game.result.reason}`:`${game.turn==='w'?'White':'Black'} to move · ${game.turn===game.fishColor?'neural controller':game.opponent}`;
  const move=game.moves.at(-1);$('last-move').textContent=move?`${Math.ceil(move.ply/2)}${move.ply%2?'.':'…'} ${move.san} · ${actorLabel[move.actor]}`:'No committed moves';
  if(state.selection)renderSelection(state.selection,game.id,game.ply);
  else renderWaiting(state.status);
  const signature=`${game.id}/${game.ply}/${historySelection}`;
  if(historySelection==='live'&&signature!==moveSignature){moveSignature=signature;renderMoves(game);}
  const nextGames=`${game.id}/${state.stats.games}`;
  if(nextGames!==gamesSignature){gamesSignature=nextGames;refreshGames();}
}
function renderSelection(sample,gameId,ply){
  lastSample=sample;lastSampleGame=gameId;
  applyFish(false);
  const key=`${gameId}/${ply}/${sample.comparisonIndex}/${sample.orientation}`;
  if(key!==comparisonKey){comparisonKey=key;trace=[];}
  if(!trace.length||trace.at(-1).t!==sample.modelTime){trace.push({t:sample.modelTime,left:sample.rates[5],right:sample.rates[6]});if(trace.length>180)trace.shift();}
  brain.setRates(sample.rates);const selected=sample.rates[5]>sample.rates[6]?5:sample.rates[6]>sample.rates[5]?6:-1;brain.select(selected);
  rows.forEach(row=>{row.value.textContent=number(sample.rates[row.index]);row.fill.style.width=`${sample.rates[row.index]*100}%`;row.row.classList.toggle('selected',row.index===selected);});
  const image=retinaScratchContext.createImageData(32,16);sample.retina.forEach((value,index)=>{const gray=Math.round(value*255);image.data[index*4]=gray;image.data[index*4+1]=gray;image.data[index*4+2]=gray;image.data[index*4+3]=255;});retinaScratchContext.putImageData(image,0,0);retinaContext.imageSmoothingEnabled=false;retinaContext.drawImage(retinaScratch,0,0,320,160);
  $('candidate-left').textContent=sample.left.san;$('candidate-left').title=sample.left.uci||'';$('candidate-right').textContent=sample.right.san;$('candidate-right').title=sample.right.uci||'';
  $('comparison-count').textContent=`${sample.comparisonIndex} / ${sample.comparisonCount} · ${sample.orientation==='swapped'?'SWAPPED':'FORWARD'}`;
  $('feature-label').textContent=sample.featureLabel;$('live-margin').textContent=`Motor L − R: ${signed(sample.margin)}`;
  $('brain-sample-state').textContent='CURRENT COMPARISON';$('model-time').textContent=`Model time ${number(sample.modelTime,2)} s`;
  renderTrace();
}
function renderWaiting(status){
  applyFish(true);
  $('comparison-count').textContent=status==='opponent'?'OPPONENT TURN':status==='between_games'?'BETWEEN GAMES':'NO ACTIVE COMPARISON';
  $('candidate-left').textContent='—';$('candidate-right').textContent='—';$('candidate-left').removeAttribute('title');$('candidate-right').removeAttribute('title');
  $('feature-label').textContent=status==='opponent'?'Waiting for the opponent.':'No comparison is currently active.';$('live-margin').textContent='Motor L − R: —';
  $('brain-sample-state').textContent=lastSample?`LAST SAMPLE · ${short(lastSampleGame)}`:'WAITING FOR A SAMPLE';
  if(lastSample)$('trace-caption').textContent='Last received comparison; held while no selection is active.';
}
function renderTrace(){
  const canvas=$('motor-trace'),c=canvas.getContext('2d'),w=canvas.width,h=canvas.height,left=35,right=w-10,top=13,bottom=h-29;
  c.clearRect(0,0,w,h);c.fillStyle='#fff';c.fillRect(0,0,w,h);c.font='11px monospace';c.textBaseline='middle';
  for(const value of [0,.5,1]){const y=bottom-value*(bottom-top);c.strokeStyle='#dbe3e6';c.lineWidth=1;c.beginPath();c.moveTo(left,y);c.lineTo(right,y);c.stroke();c.fillStyle='#78909a';c.textAlign='right';c.fillText(value.toFixed(1),left-7,y);}
  if(!trace.length)return;
  const start=trace[0].t,end=trace.at(-1).t,span=Math.max(.02,end-start);
  for(const [field,color]of [['left','#317566'],['right','#599bb1']]){c.strokeStyle=color;c.fillStyle=color;c.lineWidth=2.5;c.beginPath();trace.forEach((point,index)=>{const x=left+(point.t-start)/span*(right-left),y=bottom-point[field]*(bottom-top);if(index)c.lineTo(x,y);else c.moveTo(x,y);});c.stroke();if(trace.length===1){c.beginPath();c.arc(left,bottom-trace[0][field]*(bottom-top),3,0,Math.PI*2);c.fill();}}
  c.fillStyle='#78909a';c.textBaseline='top';c.textAlign='left';c.fillText(`${number(start,2)} s`,left,bottom+10);c.textAlign='right';c.fillText(`${number(end,2)} s`,right,bottom+10);
  $('trace-caption').textContent=`${trace.length} received samples · this comparison orientation only.`;
}
function inspectedGame(){return historySelection==='live'?snapshot?.game:historyGame;}
function setDownload(id,path){const link=$(id);link.href=apiURL(path);link.removeAttribute('aria-disabled');link.target='_blank';link.rel='noopener noreferrer';}
function renderMoves(game){
  if(!game)return;$('move-count').textContent=`${game.moves.length} PLIES`;
  $('history-context').textContent=historySelection==='live'?`Current game ${short(game.id)}. The board above remains live.`:`Inspecting saved game ${short(game.id)}. The board above remains on the current shared game.`;
  setDownload('download-pgn',gamePath(game.id,'.pgn'));setDownload('download-game',gamePath(game.id));
  if(!game.moves.length){$('moves').replaceChildren(el('p','Moves will appear as the server commits them.','empty-state'));return;}
  const groups=new Map();for(const move of game.moves){const turn=Math.ceil(move.ply/2);if(!groups.has(turn))groups.set(turn,[]);groups.get(turn).push(move);}
  const nodes=[];for(const [turn,moves]of groups){const row=el('div',undefined,'move-row');row.append(el('span',`${turn}.`,'move-number'));for(const parity of [1,0]){const move=moves.find(item=>item.ply%2===parity);if(!move){row.append(el('span'));continue;}const button=el('button',undefined,'move-button');button.type='button';button.dataset.key=`${game.id}/${move.ply}`;button.setAttribute('aria-pressed',String(selectedMoveKey===button.dataset.key));button.setAttribute('aria-label',`Inspect ${actorLabel[move.actor]} move ${turn}${parity?' white':' black'} ${move.san}`);button.append(el('span',move.san),el('small',actorLabel[move.actor]));button.addEventListener('click',()=>inspectMove(game.id,move));row.append(button);}nodes.push(row);}
  const list=$('moves'),wasNearBottom=list.scrollTop+list.clientHeight>=list.scrollHeight-35;list.replaceChildren(...nodes);if(wasNearBottom&&historySelection==='live')list.scrollTop=list.scrollHeight;
}
async function refreshGames(){
  if(archiveLoading)return;archiveLoading=true;
  try{
    const data=await getJSON('/api/games');if(!Array.isArray(data))throw Error('Invalid game index.');
    const options=[el('option','Current shared game')];options[0].value='live';
    for(const item of data){if(!item||typeof item.id!=='string'||item.id===snapshot?.game.id)continue;const result=item.result?.outcome;const option=el('option',`${short(item.id)}${result?` · ${result==='win'?'Controller win':result==='loss'?'Controller loss':'Draw'}`:''}`);option.value=item.id;options.push(option);}
    if(historySelection!=='live'&&!options.some(option=>option.value===historySelection)){const option=el('option',`Selected game ${short(historySelection)}`);option.value=historySelection;options.push(option);}
    $('game-select').replaceChildren(...options);$('game-select').value=historySelection;$('archive-status').textContent='';
  }catch(error){$('archive-status').textContent='Saved games are temporarily unavailable. The shared game is unaffected.';}
  finally{archiveLoading=false;}
}
async function changeHistory(){
  const value=$('game-select').value;historySelection=value;selectedMoveKey=null;moveSignature='';
  if(value==='live'){historyGame=null;renderMoves(snapshot?.game);return;}
  $('archive-status').textContent='Loading the saved game.';
  try{const record=await getJSON(gamePath(value)),game=record.game||record;if(historySelection!==value)return;if(!game||game.id!==value||!Array.isArray(game.moves))throw Error('Invalid game record.');historyGame=game;renderMoves(game);$('archive-status').textContent='';}
  catch(error){if(historySelection===value)$('archive-status').textContent='This saved game could not be loaded. Choose Current shared game to return to its move record.';}
}
function clearInspector(message,label){$('inspector-content').hidden=true;$('inspector-status').textContent=message;$('inspector-label').textContent=label;}
function decisionRecord(record){
  const decision=record?.decision||record;
  if(!decision||typeof decision.selectedUci!=='string'||typeof decision.selectedSan!=='string'||!Array.isArray(decision.featureDefinitions)||!decision.featureDefinitions.length||!Array.isArray(decision.candidates)||!Array.isArray(decision.comparisons))throw Error('Unsupported decision record.');
  if(decision.featureDefinitions.some(feature=>typeof feature.id!=='string'||typeof feature.label!=='string'||typeof feature.description!=='string'))throw Error('Invalid feature definitions.');
  if(decision.candidates.some(candidate=>typeof candidate.uci!=='string'||typeof candidate.san!=='string'||!Array.isArray(candidate.features)||candidate.features.length!==decision.featureDefinitions.length||candidate.features.some(value=>!Number.isFinite(value)||value<0||value>1)))throw Error('Invalid candidate features.');
  if(decision.comparisons.some(pair=>!Number.isFinite(pair.forwardMargin)||!Number.isFinite(pair.reverseMargin)||!Number.isFinite(pair.margin)||typeof pair.winnerUci!=='string'))throw Error('Invalid comparison margins.');
  return decision;
}
async function inspectMove(gameId,move){
  const request=++inspectorRequest;selectedMoveKey=`${gameId}/${move.ply}`;document.querySelectorAll('.move-button').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.key===selectedMoveKey)));
  const label=`${Math.ceil(move.ply/2)}${move.ply%2?'.':'…'} ${move.san}`;
  if(move.actor==='opening'){clearInspector('This move was supplied by the experiment’s opening setup. No neural-controller decision is attached to it.',`${label} · OPENING`);return;}
  if(move.actor==='opponent'){clearInspector('This is a move by the recorded opponent. It has no neural-controller candidate comparison.',`${label} · OPPONENT`);return;}
  clearInspector('Loading the recorded candidate features and comparisons. The shared board continues independently.',`${label} · LOADING`);
  try{
    const url=gamePath(gameId,`/moves/${move.ply}`),record=await getJSON(url);if(request!==inspectorRequest)return;
    const decision=decisionRecord(record);renderDecision(decision,gameId,move,url);
  }catch(error){if(request===inspectorRequest)clearInspector('This decision record is not available yet. Select the move again to retry; no explanation is substituted for its data.',`${label} · RECORD UNAVAILABLE`);}
}
function renderDecision(decision,gameId,move,url){
  $('inspector-content').hidden=false;$('inspector-label').textContent=`${Math.ceil(move.ply/2)}${move.ply%2?'.':'…'} ${move.san} · RECORDED`;
  $('inspector-status').textContent=`Recorded controller choice from game ${short(gameId)}, ply ${move.ply}. Candidate features and motor comparisons are shown below. The board and neural panel above stay on the shared game.`;
  $('decision-selected').textContent=`${decision.selectedSan} (${decision.selectedUci})`;
  $('decision-comparisons').textContent=String(decision.comparisonCount??decision.comparisons.length);$('decision-duration').textContent=Number.isFinite(decision.modelDuration)?`${number(decision.modelDuration,2)} s`:'—';
  const head=el('tr');head.append(el('th','Move'));decision.featureDefinitions.forEach(feature=>head.append(el('th',feature.label)));$('candidate-head').replaceChildren(head);
  $('candidate-rows').replaceChildren(...decision.candidates.map(candidate=>{const row=el('tr');if(candidate.uci===decision.selectedUci)row.className='chosen-candidate';row.append(el('td',`${candidate.san} · ${candidate.uci}${candidate.uci===decision.selectedUci?' ✓':''}`));candidate.features.forEach(value=>row.append(el('td',number(value))));return row;}));
  $('feature-definitions').replaceChildren(...decision.featureDefinitions.map(feature=>{const paragraph=el('p');paragraph.append(el('strong',`${feature.label}. `),document.createTextNode(feature.description));return paragraph;}));
  const moveName=uci=>{const candidate=decision.candidates.find(item=>item.uci===uci);return candidate?`${candidate.san} (${uci})`:uci;};
  $('comparison-rows').replaceChildren(...decision.comparisons.map(pair=>{const row=el('tr');[pair.index,moveName(pair.leftUci),moveName(pair.rightUci),signed(pair.forwardMargin),signed(pair.reverseMargin),signed(pair.margin),moveName(pair.winnerUci)].forEach(value=>row.append(el('td',value)));return row;}));
  $('tie-breaks').replaceChildren(...decision.comparisons.filter(pair=>pair.tieBreak).map(pair=>el('p',`Pair ${pair.index}: ${pair.tieBreak.reason}. Recorded seeded draw ${number(pair.tieBreak.draw,6)} selected ${moveName(pair.tieBreak.selectedUci)}.`)));
  setDownload('download-decision',url);$('decision-version').textContent=`${decision.modelVersion??''} · ${decision.selectorVersion??''} · seed ${decision.seed??'—'}`;
}
$('flip-board').addEventListener('click',()=>board.flip());$('reset-view').addEventListener('click',()=>brain.reset());$('game-select').addEventListener('change',changeHistory);
setInterval(()=>{
  if(lastReceived&&performance.now()-lastReceived>5000&&connectionOnline){setConnection(false,snapshot?`Last shared snapshot ${time(snapshot.sentAt)}.`:'No fresh shared message.');if(socket){const stale=socket;socket=null;stale.onclose=null;stale.close();}scheduleReconnect();}
},500);
const fishObserver=new IntersectionObserver(entries=>{fishVisible=entries[0].isIntersecting;fishView?.setActive(fishVisible&&!document.hidden);},{threshold:.01});fishObserver.observe($('fish-body'));
document.addEventListener('visibilitychange',()=>fishView?.setActive(fishVisible&&!document.hidden));
window.addEventListener('pagehide',()=>{clearTimeout(reconnectTimer);fishView?.setActive(false);if(socket){socket.onclose=null;socket.close();}});
renderTrace();connect();loadFish();
