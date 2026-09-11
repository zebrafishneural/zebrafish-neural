export const SEEDS=[
 'https://en.wikipedia.org/wiki/Zebrafish',
 'https://en.wikipedia.org/wiki/Neuroscience',
 'https://en.wikipedia.org/wiki/Animal_locomotion',
 'https://en.wikipedia.org/wiki/Visual_system',
 'https://en.wikipedia.org/wiki/Neural_circuit'
];
export function allowedNavigation(value){
 try{
  const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||u.hostname!=='en.wikipedia.org'||u.search)return false;
  const path=decodeURIComponent(u.pathname);
  return path.startsWith('/wiki/')&&!path.slice(6).includes(':')&&!/\.(pdf|zip|exe|dmg|mp4|ogg)$/i.test(path);
 }catch{return false;}
}
export function allowedResource(value){
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&(u.hostname==='en.wikipedia.org'||u.hostname==='upload.wikimedia.org'||u.hostname==='commons.wikimedia.org'||u.hostname==='meta.wikimedia.org');}catch{return false;}
}
