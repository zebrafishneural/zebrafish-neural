import {ChessBoard} from '/chess/board.js';
import {Chess} from '/chess/lib/chess.js';
const NAMES={p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
export class PlayBoard extends ChessBoard {
  constructor(container,onMove){super(container);this.onMove=onMove;this.enabled=false;this.humanColor='w';this.selected=null;this.focusSquare='e2';container.removeAttribute('role');this.render();}
  update(fen,lastMove,{enabled,color}){const changed=this.fen!==fen;this.enabled=enabled;this.humanColor=color;if(changed)this.selected=null;this.fen=fen;this.lastMove=lastMove;this.render();}
  setOrientation(color){this.orientation=color;this.render();}
  render(){
    const focusedSquare=this.container.querySelector('.board-targets')?.contains(document.activeElement)?document.activeElement.dataset.square:null;
    super.render();this.container.querySelector('.board-targets')?.remove();
    if(!this.onMove)return;
    const board=this.fen?new Chess(this.fen):null;
    this.container.setAttribute('aria-label','Your chessboard. Arrow keys move between squares. Enter selects a piece or destination; Escape cancels.');
    const overlay=document.createElement('div');overlay.className='board-targets';
    const moves=this.enabled&&this.selected?board.moves({square:this.selected,verbose:true}):[];
    for(let row=0;row<8;row++)for(let col=0;col<8;col++){
      const file=this.orientation==='w'?col:7-col,rank=this.orientation==='w'?7-row:row,square=String.fromCharCode(97+file)+(rank+1);
      const piece=board?.get(square),legal=moves.some(move=>move.to===square);
      const button=document.createElement('button');button.type='button';button.dataset.square=square;button.tabIndex=square===this.focusSquare?0:-1;
      button.dataset.selected=String(square===this.selected);button.dataset.legal=String(legal);button.dataset.capture=String(legal&&Boolean(piece));button.dataset.movable=String(this.enabled&&piece?.color===this.humanColor);
      button.setAttribute('aria-label',`${square}${piece?`, ${piece.color==='w'?'White':'Black'} ${NAMES[piece.type]}`:', empty'}${legal?', legal destination':''}${this.selected===square?', selected':''}`);
      button.setAttribute('aria-disabled',String(!this.enabled));
      button.onclick=()=>this.choose(square);
      button.onkeydown=event=>{
        const offsets={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]};
        if(event.key==='Escape'){event.preventDefault();this.selected=null;this.render();this.focus(square);return;}
        if(!offsets[event.key])return;event.preventDefault();const [dx,dy]=offsets[event.key];const target=overlay.children[Math.max(0,Math.min(7,row+dy))*8+Math.max(0,Math.min(7,col+dx))];this.focus(target.dataset.square);
      };
      button.onfocus=()=>{this.focusSquare=square;for(const child of overlay.children)child.tabIndex=child===button?0:-1;};overlay.append(button);
    }
    this.container.append(overlay);
    if(focusedSquare)this.focus(focusedSquare);
  }
  focus(square){this.focusSquare=square;this.container.querySelector(`[data-square="${square}"]`)?.focus({preventScroll:true});}
  choose(square){
    if(!this.enabled||!this.fen)return;
    const board=new Chess(this.fen),piece=board.get(square);
    if(this.selected===square){this.selected=null;this.render();this.focus(square);return;}
    if(this.selected){const moves=board.moves({square:this.selected,verbose:true}).filter(move=>move.to===square);if(moves.length){const from=this.selected;this.selected=null;this.onMove({from,to:square,promotions:moves.map(move=>move.promotion).filter(Boolean)});return;}}
    this.selected=piece?.color===this.humanColor?square:null;this.render();this.focus(square);
  }
}
