import {PlayBoard} from './board.js';
import {BrainView} from '/chess/lib/brain-view.js';
import {REGIONS} from '/chess/lib/model.js';
import {Chess} from '/chess/lib/chess.js';
import {clearVerification,setVerificationDecision,decisionContext} from './verification-panel.js';

const $=id=>document.getElementById(id);
const SESSION_KEY='zebrafish.play.session.v1';
const num=(value,digits=3)=>Number.isFinite(value)?value.toFixed(digits):'—';
const signed=value=>Number.isFinite(value)?`${value>0?'+':''}${value.toFixed(5)}`:'—';
const colorName=color=>color==='w'?'White':'Black';
const phases={'waiting-player':'Your turn',queued:'Your fish is in the queue',comparing:'The fish is comparing moves',gameover:'Game complete',error:'The game needs attention'};
let session=null,state=null,serviceReady=false,connected=false,busy=false,chosenColor='w';
let bootTimer=null,bootInFlight=false;
let httpBase=location.origin,wsUrl='',socket=null,reconnectTimer=null,attempt=0,lastReceived=0,streamId=null,sequence=-1,connectionEpoch=0;
let fish=null,lastSample=null,positionKey='',movesKey='',decisionKey='',decisionRecord=null,decisionRequest=0,promotionMove=null,autoInspectedPly=0;
const board=new PlayBoard($('chess-board'),chooseMove);board.setPosition(new Chess().fen());
let brain;
try{brain=new BrainView($('brain'));brain.setData(null,'model');}
catch{brain={setRates(){},select(){},reset(){}};const message=document.createElement('p');message.className='brain-unavailable';message.textContent='The network view is unavailable in this browser. Your game and numerical model activity still work.';document.querySelector('.brain-stage').append(message);}
const rows=[0,1,2,3,5,6,4,7].map(index=>{const row=document.createElement('div');row.className='rate';const label=document.createElement('span');label.textContent=REGIONS[index].name;const value=document.createElement('output');value.textContent='—';const meter=document.createElement('div');meter.className='rate-meter';const fill=document.createElement('i');meter.append(fill);row.append(label,value,meter);$('rates').append(row);return {index,row,value,fill};});
const compactComparison=document.createElement('p');compactComparison.className='compact-comparison';compactComparison.textContent='Candidate comparisons appear during the fish’s turn.';document.querySelector('.brain-toolbar').after(compactComparison);

function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=String(text);if(className)node.className=className;return node;}
function notice(text=''){ $('notice').hidden=!text;$('notice').textContent=text; }
function local(host){return ['127.0.0.1','localhost','[::1]'].includes(host);}
function endpoint(value,kind){const url=new URL(value);if(url.username||url.password||url.search||url.hash||!(url.protocol===(kind==='http'?'https:':'wss:')||local(location.hostname)&&local(url.hostname)&&url.protocol===(kind==='http'?'http:':'ws:')))throw Error('Invalid game service configuration.');return url;}
async function request(path,{method='GET',body,auth=true,raw=false}={}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
  const headers={Accept:raw?'application/x-chess-pgn':'application/json'};
  if(auth){if(!session?.token)throw Error('No game access key.');headers.Authorization=`Bearer ${session.token}`;}
  if(body!==undefined)headers['Content-Type']='application/json';
  try{const response=await fetch(`${httpBase}${path}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:controller.signal});if(!response.ok){const data=await response.json().catch(()=>({}));const error=Error(typeof data.error==='string'?data.error:`The server returned ${response.status}.`);error.status=response.status;error.retryAfter=response.headers.get('retry-after');throw error;}return raw?response.text():response.json();}finally{clearTimeout(timer);}
}
function path(suffix=''){return `/api/play/games/${encodeURIComponent(session.gameId)}${suffix}`;}
function validState(value){
  const game=value?.game;
  if(value?.schemaVersion!==1||!Number.isInteger(value.seq)||typeof value.streamId!=='string'||!Object.hasOwn(phases,value.status)||!game||typeof game.id!=='string'||typeof game.fen!=='string'||!['w','b'].includes(game.humanColor)||!['w','b'].includes(game.fishColor)||!['w','b'].includes(game.turn)||!Number.isInteger(game.ply)||!Array.isArray(game.moves)||game.moves.length>1000)throw Error('The server returned an invalid game state.');
  if(session&&game.id!==session.gameId)throw Error('A different game was received.');
  if(value.selection){const sample=value.selection;if(!Array.isArray(sample.rates)||sample.rates.length!==8||sample.rates.some(n=>!Number.isFinite(n)||n<0||n>1)||typeof sample.left?.san!=='string'||typeof sample.right?.san!=='string'||!Number.isFinite(sample.modelTime)||!Number.isFinite(sample.margin))throw Error('The controller sample could not be validated.');}
  return value;
}
function connection(online,message){
  connected=online;$('connection-state').dataset.online=String(online);$('connection-state').textContent=online?(session?'Connected':'Ready to play'):(session?'Reconnecting':'Service unavailable');$('connection-detail').textContent=message||'Moves and model activity are computed on the server.';
  if(!online&&session){$('brain-status').textContent='CONNECTION INTERRUPTED';applyFish(true);}
  controls();
}
function controls(){
  const playable=Boolean(connected&&!busy&&state?.status==='waiting-player'&&state.game.turn===state.game.humanColor);
  const key=state?`${state.game.fen}/${playable}/${state.game.humanColor}`:`idle/${chosenColor}`;
  if(key!==positionKey){positionKey=key;board.update(state?.game.fen||new Chess().fen(),state?.game.moves.at(-1),{enabled:playable,color:state?.game.humanColor||chosenColor});}
  $('start-game').disabled=!serviceReady||busy;$('resign').disabled=!session||!connected||busy||!state||['gameover','error'].includes(state.status);$('new-game').hidden=state?.status!=='gameover';$('new-game').disabled=busy;
  $('download-pgn').disabled=!session||!state;$('download-game').disabled=!session||!state;
  document.querySelectorAll('[data-color]').forEach(button=>button.disabled=busy);
}
function saveSession(){try{localStorage.setItem(SESSION_KEY,JSON.stringify({...session,httpBase}));}catch{notice('This browser could not save your game access key. Keep this tab open to retain access.');}}
function forgetSession(){session=null;try{localStorage.removeItem(SESSION_KEY);}catch{};}
function dropSocket(){connectionEpoch++;clearTimeout(reconnectTimer);if(socket){socket.onclose=null;socket.close();socket=null;}}
function reconnect(){clearTimeout(reconnectTimer);if(!session)return;reconnectTimer=setTimeout(connect,Math.min(10000,800*2**Math.min(attempt++,4)));}
async function connect(){
  if(!session)return;dropSocket();const id=session.gameId,epoch=connectionEpoch;
  try{
    const current=await request(path());if(session?.gameId!==id||epoch!==connectionEpoch)return;receive(validState(current));
    const ws=new WebSocket(wsUrl);socket=ws;
    ws.onopen=()=>{if(socket===ws)ws.send(JSON.stringify({type:'subscribe',gameId:session.gameId,token:session.token}));};
    ws.onmessage=event=>{if(socket!==ws)return;try{const value=JSON.parse(event.data);receive(validState(value));attempt=0;}catch{connection(false,'The game stream could not be validated. Retrying.');ws.close();}};
    ws.onerror=()=>{if(socket===ws)ws.close();};
    ws.onclose=()=>{if(socket!==ws)return;socket=null;connection(false,'Your last saved position is retained. Reconnecting to the server.');reconnect();};
  }catch(error){
    if(session?.gameId!==id||epoch!==connectionEpoch)return;
    if([401,403,404,410].includes(error.status)){dropSocket();forgetSession();state=null;streamId=null;sequence=-1;$('setup').hidden=false;resetDisplay();notice('This game access key is no longer valid or its record has expired. You can start a new game.');connection(serviceReady);return;}
    connection(false,'Your board is retained while the server connection is restored.');reconnect();
  }
}
function receive(next){
  lastReceived=performance.now();connection(true,`Private game · ${colorName(next.game.humanColor)} is yours`);
  if(next.streamId!==streamId){streamId=next.streamId;sequence=-1;}
  if(next.seq<=sequence)return;sequence=next.seq;state=next;const game=state.game;
  $('setup').hidden=true;$('side-label').textContent=`You play ${colorName(game.humanColor)} · The fish plays ${colorName(game.fishColor)}`;$('fish-heading').textContent=`The fish plays ${colorName(game.fishColor)}`;$('fish-side-chip').textContent=game.fishColor.toUpperCase();$('fish-side-chip').dataset.side=game.fishColor;
  const move=game.moves.at(-1),lastFish=game.moves.findLast(item=>item.actor==='fish');
  $('fish-side-note').textContent=lastFish?`Last reply: ${lastFish.san} · original frozen gains`:'Original frozen gains · waiting for its turn';
  $('last-move').textContent=move?`${Math.ceil(move.ply/2)}${move.ply%2?'.':'…'} ${move.san} · ${move.actor==='fish'?'Fish':'You'}`:'No moves played';
  $('game-id').textContent=game.id;$('turn-banner').dataset.phase=state.status;$('turn-title').textContent=phases[state.status];
  if(Number.isFinite(Date.parse(state.expiresAt)))$('retention-note').textContent=`This session expires ${new Date(state.expiresAt).toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'})} in your local time and is capped at ${state.scope?.maxPlies||160} half-moves.`;
  $('turn-detail').textContent=state.status==='waiting-player'?(new Chess(game.fen).isCheck()?'You are in check.':'Click a piece to see legal moves.'):state.status==='queued'?'Your position is saved. Waiting for a compute slot.':state.status==='comparing'?'Recorded neural comparisons are arriving alongside the board.':state.status==='error'?'Your saved record is retained.':game.result?.reason||'Saved to your game record.';
  if(state.status==='gameover')$('turn-title').textContent=resultLabel(game.result);
  if(state.selection)showSample(state.selection);else holdSample();
  if(movesKey!==`${game.id}/${game.ply}`){movesKey=`${game.id}/${game.ply}`;renderMoves(game);}
  if(lastFish&&lastFish.ply>autoInspectedPly){autoInspectedPly=lastFish.ply;inspect(lastFish);}
  controls();
}
function resultLabel(result){if(result?.outcome==='win')return 'The fish wins.';if(result?.outcome==='loss')return 'You beat the fish.';if(result?.outcome==='draw')return 'A drawn game.';return 'Game complete.';}
function showSample(sample){
  lastSample=sample;brain.setRates(sample.rates);const selected=sample.rates[5]>sample.rates[6]?5:sample.rates[5]<sample.rates[6]?6:-1;brain.select(selected);
  for(const row of rows){row.value.textContent=num(sample.rates[row.index]);row.fill.style.width=`${sample.rates[row.index]*100}%`;row.row.classList.toggle('selected',row.index===selected);}
  $('candidate-left').textContent=sample.left.san;$('candidate-right').textContent=sample.right.san;$('candidate-left').title=sample.left.uci||'';$('candidate-right').title=sample.right.uci||'';
  compactComparison.textContent=`${sample.left.san} ↔ ${sample.right.san} · ${sample.featureLabel}`;
  $('comparison-count').textContent=`${sample.comparisonIndex} / ${sample.comparisonCount}`;$('feature-label').textContent=`${sample.featureLabel} · ${sample.orientation==='swapped'?'inputs swapped to check channel bias':'forward comparison'}`;$('motor-margin').textContent=signed(sample.margin);
  $('brain-status').textContent='LIVE COMPARISON';$('sample-status').textContent='Received from your game';$('model-time').textContent=`${num(sample.modelTime,2)} model s`;applyFish(false);
}
function holdSample(){
  compactComparison.textContent=state?.status==='queued'?'Your fish is waiting for a compute slot.':state?.status==='gameover'?'Game complete · inspect recorded decisions below.':'Candidate comparisons resume on the fish’s turn.';
  $('brain-status').textContent=lastSample?'LAST RECEIVED SAMPLE':state?.status==='queued'?'WAITING IN QUEUE':'WAITING FOR A FISH MOVE';$('sample-status').textContent=lastSample?'Held between comparisons':'No model sample yet';
  $('candidate-left').textContent='—';$('candidate-right').textContent='—';$('candidate-left').removeAttribute('title');$('candidate-right').removeAttribute('title');$('motor-margin').textContent='—';$('comparison-count').textContent=state?.status==='waiting-player'?'YOUR TURN':'IDLE';$('feature-label').textContent=state?.status==='queued'?'Your fish will compare moves when a compute slot is available.':state?.status==='gameover'?'The match is complete. Inspect its saved decisions below.':'The fish compares legal moves after your turn.';applyFish(true);
}
function applyFish(paused=true){if(fish&&lastSample)fish.setState({rates:[...lastSample.rates],drive:lastSample.rates[7],turn:lastSample.rates[5]-lastSample.rates[6],time:lastSample.modelTime,paused});}
function renderMoves(game){
  $('move-count').textContent=`${game.ply} PLIES`;
  if(!game.moves.length){$('moves').replaceChildren(element('p','Make the first move to begin.','empty-state'));return;}
  const contents=[];for(let index=0;index<game.moves.length;index+=2){const row=element('div',undefined,'move-row');row.append(element('span',String(index/2+1)+'.','move-number'));for(const move of game.moves.slice(index,index+2)){const button=element('button',undefined,'move-button');button.type='button';button.dataset.actor=move.actor;button.dataset.ply=String(move.ply);button.setAttribute('aria-pressed',String(decisionKey===`${game.id}/${move.ply}`));button.append(document.createTextNode(move.san),element('small',move.actor==='fish'?'FISH · INSPECT':'YOU'));button.onclick=()=>inspect(move);row.append(button);}contents.push(row);}
  const nearBottom=$('moves').scrollHeight-$('moves').scrollTop-$('moves').clientHeight<55;$('moves').replaceChildren(...contents);if(nearBottom)$('moves').scrollTop=$('moves').scrollHeight;
}
function resetDisplay(){
  clearVerification();
  lastSample=null;autoInspectedPly=0;decisionRecord=null;decisionKey='';decisionRequest++;positionKey='';movesKey='';brain.setRates(Array(8).fill(0));brain.select(-1);
  rows.forEach(row=>{row.value.textContent='—';row.fill.style.width='0%';row.row.classList.remove('selected');});fish?.setState({rates:Array(8).fill(0),drive:0,turn:0,time:0,paused:true});
  $('decision-content').hidden=true;$('decision-tag').textContent='WAITING FOR A FISH MOVE';$('decision-summary').textContent='After the fish replies, its recorded candidate features and comparison results appear here.';$('moves').replaceChildren(element('p','Your moves and the fish’s replies will appear here.','empty-state'));$('move-count').textContent='0 PLIES';$('fish-heading').textContent='Meet your opponent';$('fish-side-note').textContent='The same controller as the live chess experiment.';$('fish-side-chip').textContent='F';$('fish-side-chip').removeAttribute('data-side');$('side-label').textContent='Choose a side to begin.';$('game-id').textContent='NO GAME STARTED';$('last-move').textContent='Standard starting position';$('turn-title').textContent='Your move starts the experiment.';$('turn-detail').textContent='Select a color above.';$('turn-banner').removeAttribute('data-phase');$('model-time').textContent='—';holdSample();controls();
}
async function start(){
  if(busy||!serviceReady)return;busy=true;notice();controls();
  try{const data=await request('/api/play/games',{method:'POST',body:{color:chosenColor},auth:false});if(typeof data.gameId!=='string'||typeof data.token!=='string'||data.token.length<20)throw Error('The server did not return a game access key.');dropSocket();session={gameId:data.gameId,token:data.token};saveSession();state=null;streamId=null;sequence=-1;resetDisplay();const next=validState(data.state);board.setOrientation(next.game.humanColor);receive(next);connect();}
  catch(error){notice(error.status===429?'The service is busy. Please wait a moment before starting another game.':error.message||'The game could not be started.');}
  finally{busy=false;controls();}
}
function chooseMove(move){
  if(busy||!connected||state?.status!=='waiting-player')return;
  const action={from:move.from,to:move.to,expectedPly:state.game.ply};
  if(move.promotions.length){promotionMove=action;$('promotion-dialog').showModal();return;}
  mutate('/move',action);
}
async function mutate(suffix,body){
  if(busy||!session)return;busy=true;notice();controls();const gameId=session.gameId,requestId=crypto.randomUUID();
  try{
    let result;for(let n=0;n<2;n++){try{result=await request(path(suffix),{method:'POST',body:{...body,requestId}});break;}catch(error){if(error.status||n===1)throw error;}}
    if(session?.gameId===gameId)receive(validState(result.state));
  }catch(error){
    if(session?.gameId!==gameId)return;
    notice(error.status===409?'The saved position changed. Your board has been refreshed; choose your move again.':error.status===429?'The server is busy. Your game is saved; try again shortly.':error.message||'The move was not confirmed. Reconnecting to the saved position.');
    await connect();
  }finally{busy=false;controls();}
}
async function inspect(move){
  if(!session)return;const requestNumber=++decisionRequest;decisionKey=`${session.gameId}/${move.ply}`;decisionRecord=null;
  clearVerification();const inspectedGame=state?.game;
  for(const button of document.querySelectorAll('.move-button'))button.setAttribute('aria-pressed',String(Number(button.dataset.ply)===move.ply));
  $('decision-content').hidden=true;$('decision-tag').textContent=`${Math.ceil(move.ply/2)}${move.ply%2?'.':'…'} ${move.san} · ${move.actor==='fish'?'FISH':'YOU'}`;
  if(move.actor!=='fish'){$('decision-summary').textContent='You played this move. Select a fish reply to inspect the controller’s recorded comparisons.';return;}
  $('decision-summary').textContent='Loading the saved decision from your game.';
  try{const record=await request(path(`/moves/${move.ply}`));if(requestNumber!==decisionRequest)return;const decision=record.decision||record;
    if(!Array.isArray(decision.candidates)||!Array.isArray(decision.comparisons)||typeof decision.selectedUci!=='string'||decision.candidates.some(candidate=>!Array.isArray(candidate.features)||candidate.features.length!==4||candidate.features.some(x=>!Number.isFinite(x)))||decision.comparisons.some(pair=>!Number.isFinite(pair.margin)))throw Error('Invalid decision record.');
    decisionRecord=record;setVerificationDecision(record,decisionContext(inspectedGame,move));const name=uci=>decision.candidates.find(candidate=>candidate.uci===uci)?.san||uci;
    const finalPair=decision.comparisons.at(-1);
    $('decision-summary').textContent=finalPair?(finalPair.tieBreak?`The final pair tied within the declared motor tolerance. The saved seeded tie-break selected ${decision.selectedSan}.`:`The final comparison selected ${decision.selectedSan} over ${name(finalPair.winnerUci===finalPair.leftUci?finalPair.rightUci:finalPair.leftUci)}. Its combined motor margin was ${signed(finalPair.margin)}.`):`${decision.selectedSan} was the only legal move available.`;
    $('decision-selected').textContent=`${decision.selectedSan} (${decision.selectedUci})`;$('decision-candidates').textContent=String(decision.candidates.length);$('decision-duration').textContent=`${num(decision.modelDuration,2)} model s`;
    $('candidate-rows').replaceChildren(...decision.candidates.map(candidate=>{const row=element('tr');if(candidate.uci===decision.selectedUci)row.className='chosen-candidate';row.append(element('td',`${candidate.san}${candidate.uci===decision.selectedUci?' ✓':''}`));candidate.features.forEach(value=>row.append(element('td',num(value))));return row;}));
    $('comparison-rows').replaceChildren(...decision.comparisons.map(pair=>{const row=element('tr');[pair.index,name(pair.leftUci),name(pair.rightUci),signed(pair.margin),`${name(pair.winnerUci)}${pair.tieBreak?' · seeded tie-break':''}`].forEach(value=>row.append(element('td',value)));return row;}));
    $('decision-version').textContent=`${decision.selectorVersion} · seed ${decision.seed}`;$('decision-content').hidden=false;
  }catch{if(requestNumber===decisionRequest)$('decision-summary').textContent='The saved decision could not be loaded. Select this move again to retry.';}
}
function download(text,filename,type){const url=URL.createObjectURL(new Blob([text],{type})),link=document.createElement('a');link.href=url;link.download=filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
async function exportGame(kind){if(!session)return;try{const gameId=session.gameId;const data=await request(path(kind==='pgn'?'/pgn':''),{raw:kind==='pgn'});download(kind==='pgn'?data:JSON.stringify(data.game||data,null,2),`${gameId}.${kind}`,kind==='pgn'?'application/x-chess-pgn':'application/json');}catch{notice('This download is temporarily unavailable. Your saved game is retained.');}}
async function boot(){
  if(bootInFlight)return;bootInFlight=true;clearTimeout(bootTimer);
  try{const response=await fetch(new URL('./play-config.json',location.href),{cache:'no-store'});if(!response.ok)throw Error('The game configuration is unavailable.');const config=await response.json();if(config.httpBase)httpBase=endpoint(config.httpBase,'http').href.replace(/\/+$/,'');if(config.wsUrl)wsUrl=endpoint(config.wsUrl,'ws').href;else{const url=new URL('/play-ws',httpBase);url.protocol=url.protocol==='https:'?'wss:':'ws:';wsUrl=url.href;}
    const health=await request('/healthz',{auth:false});if(!health.ok)throw Error('The game service is not ready yet.');serviceReady=true;notice();connection(true);
    let saved;try{saved=JSON.parse(localStorage.getItem(SESSION_KEY)||'null');}catch{}
    if(saved?.httpBase===httpBase&&typeof saved.gameId==='string'&&typeof saved.token==='string'){session={gameId:saved.gameId,token:saved.token};await connect();if(state)board.setOrientation(state.game.humanColor);}
  }catch(error){serviceReady=false;connection(false,'Checking again shortly. Your saved game access is retained.');notice(error.message);bootTimer=setTimeout(boot,5000);}
  finally{bootInFlight=false;}
}
document.querySelectorAll('[data-color]').forEach(button=>button.addEventListener('click',()=>{chosenColor=button.dataset.color;document.querySelectorAll('[data-color]').forEach(item=>item.setAttribute('aria-pressed',String(item===button)));board.setOrientation(chosenColor==='b'?'b':'w');controls();}));
$('start-game').onclick=start;$('flip-board').onclick=()=>board.flip();$('reset-view').onclick=()=>brain.reset();
$('new-game').onclick=()=>{dropSocket();forgetSession();state=null;streamId=null;sequence=-1;$('setup').hidden=false;resetDisplay();connection(serviceReady);$('start-game').focus();};
$('resign').onclick=()=>$('resign-dialog').showModal();$('cancel-resign').onclick=()=>$('resign-dialog').close();$('confirm-resign').onclick=()=>{$('resign-dialog').close();if(state)mutate('/resign',{expectedPly:state.game.ply});};
document.querySelectorAll('[data-promotion]').forEach(button=>button.onclick=()=>{const move=promotionMove;promotionMove=null;$('promotion-dialog').close();if(move)mutate('/move',{...move,promotion:button.dataset.promotion});});
$('cancel-promotion').onclick=()=>{promotionMove=null;$('promotion-dialog').close();};$('promotion-dialog').addEventListener('cancel',()=>promotionMove=null);
$('download-pgn').onclick=()=>exportGame('pgn');$('download-game').onclick=()=>exportGame('json');$('download-decision').onclick=()=>{if(decisionRecord&&session)download(JSON.stringify(decisionRecord,null,2),`${session.gameId}-decision-${decisionKey.split('/').at(-1)}.json`,'application/json');};
setInterval(()=>{if(session&&connected&&lastReceived&&performance.now()-lastReceived>15000){connection(false,'No fresh server message. Restoring the saved game connection.');dropSocket();reconnect();}},2000);
window.addEventListener('online',()=>{if(session)connect();else if(!serviceReady)boot();});
window.addEventListener('pagehide',()=>{clearTimeout(bootTimer);dropSocket();fish?.setActive(false);});window.addEventListener('pageshow',event=>{if(event.persisted){fish?.setActive(!document.hidden);if(session)connect();else if(!serviceReady)boot();}});
document.addEventListener('visibilitychange',()=>fish?.setActive(!document.hidden));
import('/chess/fish/viewer.js').then(({FishView})=>{fish=new FishView($('fish-body'),{mode:'body',interactive:true});fish.setView('side');$('fish-placeholder').hidden=true;applyFish(!connected||!state?.selection);}).catch(()=>{$('fish-placeholder').textContent='The 3D body is unavailable in this browser. You can still play and inspect model decisions.';});
boot();
