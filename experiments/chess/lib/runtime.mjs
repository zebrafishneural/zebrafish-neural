import {randomBytes,createHash} from 'node:crypto';
import {Chess} from '../public/lib/chess.js';
import {BASE_WEIGHTS,FEATURES,SELECTOR_VERSION,decisionSteps} from './selector.mjs';

const clone=value=>structuredClone(value);
const openings=[[],['d4','d5'],['e4','e5'],['Nf3','d5']];
const pieceValue={p:1,n:3,b:3,r:5,q:9,k:0};
function rng(seed){let s=seed>>>0;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
const moveSeed=(game,ply)=>(game.seed^Math.imul(ply+1,0x9e3779b1))>>>0;
const toUci=m=>m.from+m.to+(m.promotion||'');
const uciObject=uci=>{if(typeof uci!=='string'||!/^([a-h][1-8]){2}[qrbn]?$/.test(uci))throw Error('Invalid UCI move.');return {from:uci.slice(0,2),to:uci.slice(2,4),...(uci.length===5?{promotion:uci[4]}:{})};};
function tagBoard(board,game){board.header('Event','Shared Chess local experiment','Site','Local preview','Round',String(game.id),'White',game.fishColor==='w'?'Zebrafish Neural':game.opponent,'Black',game.fishColor==='b'?'Zebrafish Neural':game.opponent,'Result',game.result?(game.result.outcome==='draw'?'1/2-1/2':game.result.winner==='w'?'1-0':'0-1'):'*');}
function boardFor(game){const board=new Chess();for(const m of game.moves)board.move(uciObject(m.uci));if(board.fen()!==game.fen)throw Error('Saved move history does not match the saved board.');tagBoard(board,game);return board;}
function resultFor(board,fishColor,ply,maxPlies){
 if(board.isCheckmate())return {outcome:board.turn()===fishColor?'loss':'win',reason:'Checkmate',winner:board.turn()==='w'?'b':'w'};
 for(const [test,reason] of [['isStalemate','Stalemate'],['isInsufficientMaterial','Insufficient material'],['isThreefoldRepetition','Threefold repetition'],['isDrawByFiftyMoves','Fifty-move rule']])if(board[test]())return {outcome:'draw',reason,winner:null};
 if(ply>=maxPlies)return {outcome:'draw',reason:`Demo move limit (${maxPlies} plies)`,winner:null};
 return null;
}

export class ChessRuntime{
 constructor({store,onState=()=>{},stepsPerTick=4,tickMs=50,opponentDelayMs=1000,betweenGamesMs=6000,maxPlies=160,now=Date.now}){
  Object.assign(this,{store,onState,stepsPerTick,tickMs,opponentDelayMs,betweenGamesMs,maxPlies,now});
  this.streamId=randomBytes(8).toString('hex');this.seq=0;this.gameNumber=0;this.stats={games:0,wins:0,draws:0,losses:0};this.game=null;this.pending=null;this.selection=null;this.generator=null;this.trace=[];this.status='starting';this.stopped=false;this.busy=false;this.error=null;
 }
 checkpoint(game=this.game,pending=this.pending){return {schemaVersion:1,gameNumber:this.gameNumber,game:clone(game),pending:clone(pending),stats:clone(this.stats),maxPlies:this.maxPlies};}
 async initialize(){
  const saved=await this.store.loadCheckpoint();
  if(saved){if(saved.schemaVersion!==1||!saved.game||!Number.isInteger(saved.gameNumber))throw Error('Unsupported chess checkpoint.');this.game=clone(saved.game);this.gameNumber=saved.gameNumber;this.stats=clone(saved.stats);this.pending=clone(saved.pending);this.maxPlies=saved.maxPlies;this.board=boardFor(this.game);if(JSON.stringify(this.game.weights)!==JSON.stringify(BASE_WEIGHTS))throw Error('Saved controller weights require their matching runtime version.');if(this.game.selectorVersion!==SELECTOR_VERSION)throw Error('Saved selector version does not match this runtime.');}
  else await this.newGame();
  if(this.game.result){await this.store.saveGame(this.game);this.status='between_games';this.nextAt=this.now()+this.betweenGamesMs;}
  else{this.status=this.game.turn===this.game.fishColor?'selecting':'opponent';this.nextAt=this.now()+this.opponentDelayMs;}
  this.publish();return this;
 }
 async newGame(){
  const n=this.gameNumber+1,seed=randomBytes(4).readUInt32LE(),board=new Chess(),moves=[];
  for(const san of openings[(n-1)%openings.length]){const m=board.move(san);moves.push({ply:moves.length+1,san:m.san,uci:toUci(m),actor:'opening',from:m.from,to:m.to,at:new Date(this.now()).toISOString()});}
  const game={id:`chess-${String(n).padStart(6,'0')}-${seed.toString(16).padStart(8,'0')}`,seed,startedAt:new Date(this.now()).toISOString(),finishedAt:null,fishColor:n%2?'w':'b',fen:board.fen(),turn:board.turn(),ply:moves.length,moves,result:null,opponent:'Seeded capture bot',weightsLabel:'Original controller · frozen gains',weights:[...BASE_WEIGHTS],weightsHash:createHash('sha256').update(JSON.stringify(BASE_WEIGHTS)).digest('hex'),selectorVersion:SELECTOR_VERSION};
  tagBoard(board,game);game.pgn=board.pgn();const checkpoint={schemaVersion:1,gameNumber:n,game,stats:this.stats,pending:null,maxPlies:this.maxPlies};await this.store.saveCheckpoint(checkpoint);
  this.gameNumber=n;this.game=game;this.board=board;this.pending=null;this.selection=null;this.generator=null;this.trace=[];this.status=game.turn===game.fishColor?'selecting':'opponent';this.nextAt=this.now()+this.opponentDelayMs;
 }
 snapshot(){return {schemaVersion:1,streamId:this.streamId,seq:this.seq,sentAt:new Date(this.now()).toISOString(),status:this.status,game:clone(this.game),selection:clone(this.selection),stats:clone(this.stats),...(this.error?{error:this.error}:{}),scope:{local:true,training:false,controller:'Eight-state controller with a handcrafted chess input adapter',simulationSpeed:this.stepsPerTick*.04/(this.tickMs/1000),rules:'chess.js 1.4.0',maxPlies:this.maxPlies}};}
 publish(){this.seq++;this.onState(this.snapshot());}
 async beginSelection(){
  const ply=this.game.ply+1;
  if(!this.pending){const pending={ply,seed:moveSeed(this.game,ply),fen:this.game.fen};await this.store.saveCheckpoint(this.checkpoint(this.game,pending));this.pending=pending;}
  if(this.pending.fen!==this.game.fen||this.pending.ply!==ply)throw Error('Pending decision is not attached to the current position.');
  this.generator=decisionSteps(this.game.fen,{seed:this.pending.seed,weights:this.game.weights});this.trace=[];this.selection=null;this.status='selecting';
 }
 async commit(uci,actor,decision=null){
  const old=this.game,board=boardFor(old),m=board.move(uciObject(uci));
  if(!m)throw Error('The selected move was not legal.');
  const ply=old.ply+1,at=new Date(this.now()).toISOString(),draft=clone(old);
  draft.moves.push({ply,san:m.san,uci:toUci(m),actor,from:m.from,to:m.to,at,...(actor==='fish'?{decisionId:`${old.id}:${ply}`}:{})});
  draft.ply=ply;draft.fen=board.fen();draft.turn=board.turn();draft.result=resultFor(board,draft.fishColor,ply,this.maxPlies);tagBoard(board,draft);draft.pgn=board.pgn({maxWidth:80,newline:'\n'});
  if(decision){const record={...decision,gameId:old.id,ply,actor:'fish',fenBefore:old.fen,fenAfter:draft.fen,featureDefinitions:FEATURES,samples:this.trace,weightsHash:old.weightsHash};await this.store.saveDecision(old.id,ply,record);}
  const stats=clone(this.stats);if(draft.result){draft.finishedAt=at;stats.games++;stats[draft.result.outcome==='win'?'wins':draft.result.outcome==='loss'?'losses':'draws']++;}
  await this.store.saveCheckpoint({schemaVersion:1,gameNumber:this.gameNumber,game:draft,pending:null,stats,maxPlies:this.maxPlies});
  this.game=draft;this.board=board;this.stats=stats;this.pending=null;this.generator=null;this.trace=[];this.selection=null;
  if(draft.result){await this.store.saveGame(draft);this.status='between_games';this.nextAt=this.now()+this.betweenGamesMs;}
  else{this.status='committed';this.nextAt=this.now()+this.opponentDelayMs;}
  this.publish();
 }
 opponentMove(){
  const legal=this.board.moves({verbose:true}),random=rng(moveSeed(this.game,this.game.ply+1));
  const scored=legal.map(m=>({m,w:.6+(pieceValue[m.captured]||0)*1.4+(m.san.includes('+')?.7:0)+(m.promotion?6:0)}));let p=random()*scored.reduce((sum,x)=>sum+x.w,0);
  for(const x of scored){p-=x.w;if(p<=0)return toUci(x.m);}return toUci(scored.at(-1).m);
 }
 async tick(){
  if(this.stopped||this.busy||this.error)return;this.busy=true;
  try{
   if(this.game.result){if(this.now()>=this.nextAt){await this.newGame();this.publish();}return;}
   if(this.status==='committed'){if(this.now()<this.nextAt)return;this.status=this.game.turn===this.game.fishColor?'selecting':'opponent';this.nextAt=this.now()+this.opponentDelayMs;this.publish();return;}
   if(this.game.turn!==this.game.fishColor){this.status='opponent';if(this.now()>=this.nextAt)await this.commit(this.opponentMove(),'opponent');return;}
   if(!this.generator)await this.beginSelection();
   for(let i=0;i<this.stepsPerTick;i++){
    const next=this.generator.next();
    if(next.done){if(!next.value?.selectedUci)throw Error('The controller returned no move for a playable position.');await this.commit(next.value.selectedUci,'fish',next.value);return;}
    this.selection=next.value;
    const {retina,...sample}=next.value;this.trace.push(sample);
   }
   this.publish();
  }catch(error){this.error=error.message;this.status='error';this.publish();console.error('Chess runtime:',error.stack);}
  finally{this.busy=false;}
 }
 start(){if(this.timer)return;this.timer=setInterval(()=>void this.tick(),this.tickMs);this.heartbeat=setInterval(()=>{if(!this.stopped)this.publish();},1000);}
 async close(){this.stopped=true;clearInterval(this.timer);clearInterval(this.heartbeat);while(this.busy)await new Promise(r=>setTimeout(r,10));}
 async getGame(id){return id===this.game.id?clone(this.game):this.store.getGame(id);}
 async listGames(){return this.store.listGames();}
}
