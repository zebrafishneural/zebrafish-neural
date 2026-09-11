import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserController,sampleRetina,VIEWPORT} from '../runtime/controller.mjs';
import {allowedNavigation} from '../runtime/policy.mjs';
const {width:w,height:h}=VIEWPORT;
const cursor={x:.5,y:.5,heading:-Math.PI/2};
function pattern(mirror=false){const data=new Uint8Array(w*h).fill(255);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const px=mirror?w-1-x:x;if(px<w/2)data[y*w+x]=(Math.floor(px/9)+Math.floor(y/9))%2?255:0;}return data;}
test('Uniform page brightness produces zero contrast rather than saturated activity',()=>{
 for(const v of [0,128,255]){const input=sampleRetina(new Uint8Array(w*h).fill(v),w,h,cursor);for(const f of Object.values(input.features))assert.ok(f<1e-6);}
});
test('Mirrored screenshots reverse the motor differential',()=>{
 const results=[false,true].map(mirror=>{const c=new BrowserController();c.state.fish={...c.state.fish,...cursor};c.observe(pattern(mirror),w,h,1000);for(let i=0;i<40;i++)c.advance(.02,1000+i*20);return c.state.rates[6]-c.state.rates[5];});
 assert.ok(results[0]<-.01);assert.ok(results[1]>.01);assert.ok(Math.abs(results[0]+results[1])<.02);
});
test('Browser pixels survive model stepping and missing frames suspend actions',()=>{
 const c=new BrowserController();assert.equal(c.advance(.02,1000),null);c.observe(pattern(),w,h,1000);const pixels=Array.from(c.state.retina);c.advance(.1,1100);assert.deepEqual(Array.from(c.state.retina),pixels);const t=c.state.time;assert.equal(c.advance(.1,6000),null);assert.equal(c.state.time,t);
});
test('Disabling outputs prevents cursor movement and click proposals',()=>{
 const c=new BrowserController();c.observe(pattern(),w,h,1000);const body={...c.state.fish};for(let i=0;i<80;i++)assert.equal(c.advance(.02,1000+i*20,false),null);assert.deepEqual(c.state.fish,body);assert.ok(c.state.rates.some(r=>r>0));
});
test('Recorded frame sequence replays deterministically and checkpoints restore model state',()=>{
 const a=new BrowserController(),b=new BrowserController();
 for(let f=0;f<8;f++){const frame=pattern(f%2===0);for(const c of [a,b]){c.observe(frame,w,h,1000+f*100,f+1);for(let i=0;i<5;i++)c.advance(.02,1000+f*100+i*20);}}
 assert.deepEqual(a.checkpoint(),b.checkpoint());const restored=new BrowserController(a.checkpoint());assert.deepEqual(restored.checkpoint(),a.checkpoint());assert.equal(restored.advance(.02,3000),null);
});
test('Navigation allows article links while rejecting forms, redirects and external hosts',()=>{
 assert.equal(allowedNavigation('https://en.wikipedia.org/wiki/Zebrafish#Behavior'),true);
 for(const url of ['http://en.wikipedia.org/wiki/Zebrafish','https://en.wikipedia.org/wiki/Special:UserLogin','https://en.wikipedia.org/wiki/Special%3AUserLogin','https://en.wikipedia.org/w/index.php?title=Zebrafish&action=edit','https://en.wikipedia.org/wiki/Zebrafish?action=edit','https://en.wikipedia.org.evil.test/wiki/Zebrafish','https://user:pass@en.wikipedia.org/wiki/Zebrafish','https://127.0.0.1/wiki/Zebrafish','javascript:alert(1)'])assert.equal(allowedNavigation(url),false,url);
});
