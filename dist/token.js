const announcement=document.getElementById('token-copy-status');
for(const button of document.querySelectorAll('[data-copy-contract]')){
 button.addEventListener('click',async()=>{
  try{
   await navigator.clipboard.writeText(button.dataset.copyContract);
   button.textContent='Copied';
   announcement.textContent='ZNEURO contract address copied.';
  }catch{
   button.textContent='Select address';
   announcement.textContent='Copy unavailable. Select the displayed contract address to copy it.';
  }
  setTimeout(()=>{button.textContent='Copy CA';},1800);
 });
}
