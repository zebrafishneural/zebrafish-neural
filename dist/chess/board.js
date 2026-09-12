import {Chess} from './lib/chess.js';
const NS='http://www.w3.org/2000/svg';
const NAMES={p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
const GEOMETRY={
  p:'<circle cx="22.5" cy="11.8" r="5.1"/><path d="M18.4 17c-.9 3.2-.3 6.3-2.6 10.6h13.4c-2.3-4.3-1.7-7.4-2.6-10.6Z"/><path d="M15.8 28h13.4l2.8 5.6H13Z"/><path d="M12 34h21v4H12Z"/>',
  r:'<path d="M12 8h5v5h3V8h5v5h3V8h5v10l-4 4v9H16v-9l-4-4Z"/><path d="M15 31h15l3 4H12Z"/><path d="M11 35h23v4H11Z"/><path d="M16 18h13M17 23h11" fill="none"/>',
  n:'<path d="M13 33c.7-7.6 4.6-9 7.8-13l-7.5 2.4-4-3.2L16 11l6-3 2-5 4 5c7 3.5 9 12 6 25Z"/><path d="M14 33h19l2 5H11Z"/><path d="m17 13 4-2M23 24l-3 8" fill="none"/><circle cx="22" cy="14" r="1.2" fill="currentColor" stroke="none"/>',
  b:'<path d="M22.5 5c-4.5 4.7-9 7.7-9 13.2 0 4.9 3.1 7.3 9 7.3s9-2.4 9-7.3C31.5 12.7 27 9.7 22.5 5Z"/><path d="m24.7 9.1-5.2 8.4" fill="none" stroke-width="2.5"/><path d="M19 25.5h7l2.5 6H16.5Z"/><path d="M15 32h15l3 5H12Z"/><path d="M11 37h23v3H11Z"/>',
  q:'<circle cx="9" cy="10" r="2.5"/><circle cx="16" cy="6" r="2.5"/><circle cx="22.5" cy="4" r="2.5"/><circle cx="29" cy="6" r="2.5"/><circle cx="36" cy="10" r="2.5"/><path d="m9 13 5 13h17l5-13-7 8 0-12-6.5 11L16 9v12Z"/><path d="M15 26h15l-2 6H17Z"/><path d="M15 32h15l3 5H12Z"/><path d="M11 37h23v3H11Z"/>',
  k:'<path d="M21 3h3v4h4v3h-4v5h-3v-5h-4V7h4Z"/><path d="M22.5 17c-7-8-15-2-11 6l5 8h12l5-8c4-8-4-14-11-6Z"/><path d="M16.5 31h12l2 4h-16Z"/><path d="M12 35h21v5H12Z"/><path d="M22.5 17v12" fill="none"/>'
};
function node(tag,attributes={}){const element=document.createElementNS(NS,tag);for(const [key,value]of Object.entries(attributes))element.setAttribute(key,String(value));return element;}
export class ChessBoard{
  constructor(container){this.container=container;this.orientation='w';this.fen=null;this.lastMove=null;this.svg=node('svg',{viewBox:'0 0 560 560',role:'presentation','aria-hidden':'true'});container.append(this.svg);this.render();}
  setPosition(fen,lastMove=null){if(fen===this.fen&&lastMove?.from===this.lastMove?.from&&lastMove?.to===this.lastMove?.to)return;new Chess(fen);this.fen=fen;this.lastMove=lastMove;this.render();}
  flip(){this.orientation=this.orientation==='w'?'b':'w';this.render();}
  render(){
    const board=this.fen?new Chess(this.fen):null,description=[];this.svg.replaceChildren();
    this.svg.append(node('rect',{x:0,y:0,width:560,height:560,fill:'#fff'}));
    for(let row=0;row<8;row++)for(let col=0;col<8;col++){
      const file=this.orientation==='w'?col:7-col,rank=this.orientation==='w'?7-row:row,square=String.fromCharCode(97+file)+(rank+1),x=24+col*64,y=24+row*64;
      this.svg.append(node('rect',{x,y,width:64,height:64,fill:(file+rank)%2?'#e8eeeb':'#78918d'}));
      if(square===this.lastMove?.from||square===this.lastMove?.to)this.svg.append(node('rect',{x,y,width:64,height:64,class:'board-square-highlight'}));
      const piece=board?.get(square);
      if(piece){
        if(piece.type==='k'&&piece.color===board.turn()&&board.isCheck())this.svg.append(node('rect',{x,y,width:64,height:64,class:'board-check'}));
        const group=node('g',{transform:`translate(${x+6.5} ${y+5.5}) scale(1.13)`,fill:piece.color==='w'?'#f9fbfa':'#17313b',stroke:piece.color==='w'?'#28424a':'#061821','stroke-width':1.5,'stroke-linecap':'round','stroke-linejoin':'round',color:piece.color==='w'?'#28424a':'#b9ccc9',class:'board-piece'});
        group.innerHTML=GEOMETRY[piece.type];this.svg.append(group);description.push(`${piece.color==='w'?'White':'Black'} ${NAMES[piece.type]} ${square}`);
      }
    }
    this.svg.append(node('rect',{x:24,y:24,width:512,height:512,fill:'none',stroke:'#627f7e','stroke-width':1}));
    for(let i=0;i<8;i++){
      const file=this.orientation==='w'?i:7-i,rank=this.orientation==='w'?8-i:i+1;
      const bottom=node('text',{x:56+i*64,y:552,'text-anchor':'middle',class:'board-coordinate'});bottom.textContent=String.fromCharCode(97+file);
      const side=node('text',{x:10,y:60+i*64,'text-anchor':'middle',class:'board-coordinate'});side.textContent=String(rank);this.svg.append(bottom,side);
    }
    this.container.setAttribute('aria-label',board?`Shared chess position. ${board.turn()==='w'?'White':'Black'} to move. ${description.join('; ')}.`:'Waiting for the shared chess position.');
  }
}
