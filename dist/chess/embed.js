// Homepage embedding reuses the public observer, without a second navigation bar.
if(window.parent!==window&&new URLSearchParams(location.search).get('embed')==='home'){
  document.documentElement.classList.add('home-embed');
  document.addEventListener('DOMContentLoaded',()=>{
    const main=document.querySelector('main');
    let lastHeight=0;
    const resize=()=>{
      const height=Math.ceil(main.getBoundingClientRect().height);
      if(height!==lastHeight){lastHeight=height;parent.postMessage({type:'zebrafish-chess-height',height},location.origin);}
    };
    new ResizeObserver(resize).observe(main);resize();
    // Outbound navigation should use the whole page, not replace the embedded game.
    for(const link of document.querySelectorAll('a[href]'))if(!link.getAttribute('href').startsWith('#')&&!link.target)link.target='_top';
  });
}
