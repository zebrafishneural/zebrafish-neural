import {randomUUID} from 'node:crypto';
import {BASE_WEIGHTS,PARAMS} from '../../dist/lib/learning-core.js';
import {validateConfig,createChallenge,stepChallenge,exportChallenge} from '../../dist/lib/challenge.js';

export const BODY_LIMIT=8*1024;
export const PUBLIC_WEIGHTS_URL='https://learning.zebraneural.com/api/status';
const CACHE_MS=30000, MAX_STEPS=1500;
const finite=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(message,status=400)=>Object.assign(new Error(message),{status});

function originAllowed(req,deploymentHost) {
  const origin=req.headers?.origin;
  if(origin===undefined)return true;
  if(typeof origin!=='string')return false;
  if(origin==='https://zebraneural.com'||origin==='https://www.zebraneural.com')return true;
  const host=req.headers?.host;
  if(typeof host!=='string')return false;
  const preview=deploymentHost();
  if(typeof preview==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app$/i.test(preview)&&host.toLowerCase()===preview.toLowerCase()&&origin==='https://'+preview.toLowerCase())return true;
  const local=/^(localhost|127\.0\.0\.1)(?::([0-9]{1,5}))?$/.exec(host);
  return !!local&&(!local[2]||Number(local[2])>=1&&Number(local[2])<=65535)&&origin==='http://'+host;
}

function writeJSON(req,res,status,value) {
  res.statusCode=status;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.end(req.method==='HEAD'?undefined:JSON.stringify(value));
}
function begin(req,res,methods,deploymentHost) {
  res.setHeader('Cache-Control','no-store, max-age=0');
  res.setHeader('X-Content-Type-Options','nosniff');
  if(req.headers?.origin!==undefined)res.setHeader('Vary','Origin');
  if(!originAllowed(req,deploymentHost)){writeJSON(req,res,403,{error:'This request origin is not allowed.'});return false;}
  if(!methods.includes(req.method)){res.setHeader('Allow',methods.join(', '));writeJSON(req,res,405,{error:'Method not allowed.'});return false;}
  return true;
}
function parseBodyBytes(raw) {
  const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw,'utf8');
  if(bytes.length>BODY_LIMIT)throw fail('Request body exceeds 8 KiB.',413);
  try{return JSON.parse(bytes.toString('utf8'));}catch{throw fail('Request body must be valid JSON.');}
}
async function bodyJSON(req) {
  if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers?.['content-type']||''))throw fail('Use application/json.',415);
  const length=req.headers?.['content-length'];
  if(length!==undefined&&(!/^\d+$/.test(String(length))||Number(length)>BODY_LIMIT))throw fail('Request body exceeds 8 KiB.',413);
  if(req.body!==undefined) {
    if(typeof req.body==='string'||Buffer.isBuffer(req.body))return parseBodyBytes(req.body);
    let encoded;
    try{encoded=JSON.stringify(req.body);}catch{throw fail('Invalid JSON body.');}
    if(typeof encoded!=='string')throw fail('Invalid JSON body.');
    if(Buffer.byteLength(encoded,'utf8')>BODY_LIMIT)throw fail('Request body exceeds 8 KiB.',413);
    return req.body;
  }
  return new Promise((resolve,reject)=>{
    let size=0,settled=false;const chunks=[];
    req.on('data',chunk=>{
      if(settled)return;const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      size+=bytes.length;
      if(size>BODY_LIMIT){settled=true;chunks.length=0;reject(fail('Request body exceeds 8 KiB.',413));return;}
      chunks.push(bytes);
    });
    req.on('end',()=>{if(settled)return;settled=true;try{resolve(parseBodyBytes(Buffer.concat(chunks)));}catch(error){reject(error);}});
    req.on('error',()=>{if(!settled){settled=true;reject(fail('Request body could not be read.'));}});
    req.on('aborted',()=>{if(!settled){settled=true;reject(fail('Request body was interrupted.'));}});
  });
}
function verifyInput(value) {
  if(!object(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'config')||!Object.hasOwn(value,'weights')||!object(value.config))throw fail('Expected only config and weights; outcomes are recomputed by the server.');
  if(!Array.isArray(value.weights)||value.weights.length!==6||!Array.from(value.weights).every((n,i)=>finite(n,PARAMS[i].min,PARAMS[i].max)))throw fail('Expected six finite gains inside the declared parameter bounds.');
  try{return {config:validateConfig(value.config),weights:[...value.weights]};}catch(error){throw fail(error.message);}
}
function recalculate(config,weights) {
  const experiment=createChallenge(config,weights);
  for(let step=0;step<MAX_STEPS&&!experiment.finished;step++)stepChallenge(experiment);
  if(!experiment.finished)throw fail('The challenge exceeded the fixed computation limit.',500);
  const result=exportChallenge(experiment);
  return {modelVersion:result.modelVersion,taskVersion:result.taskVersion,config:result.config,weights:result.weights,
    results:{baseline:result.arms.baseline.result,learned:result.arms.learned.result}};
}

/** Native Node/Vercel handlers. Each factory owns only a short-lived public-data cache. */
export function createChallengeHandlers({fetchImpl=globalThis.fetch,now=Date.now,deploymentHost=()=>process.env.VERCEL_URL}={}) {
  let cached=null,inflight=null;
  async function loadWeights() {
    if(cached&&now()-Date.parse(cached.fetchedAt)>=0&&now()-Date.parse(cached.fetchedAt)<CACHE_MS)return {...cached,cached:true};
    if(inflight)return {...await inflight,cached:true};
    inflight=(async()=>{
      let result;
      try {
        const response=await fetchImpl(PUBLIC_WEIGHTS_URL,{signal:AbortSignal.timeout(5000),redirect:'error',headers:{Accept:'application/json'}});
        if(!response.ok)throw new Error('Public status unavailable');
        const payload=await response.json(),learner=payload.learner,values=learner?.championWeights,sourceAt=payload.persistedAt??payload.serverAt;
        if(!Array.isArray(values)||values.length!==6||!Array.from(values).every((n,i)=>finite(n,PARAMS[i].min,PARAMS[i].max))||!Number.isSafeInteger(learner.championGeneration)||learner.championGeneration<0||typeof sourceAt!=='string'||!Number.isFinite(Date.parse(sourceAt)))throw new Error('Invalid public parameters');
        result={weights:[...values],championGeneration:learner.championGeneration,source:'public-learning',sourceUrl:PUBLIC_WEIGHTS_URL,sourceAt,fallback:false,notice:'Saved public controller parameters, replayed with frozen gains. This challenge does not train them.'};
      } catch {
        result={weights:[...BASE_WEIGHTS],championGeneration:0,source:'original-parameters',sourceUrl:null,sourceAt:null,fallback:true,notice:'Public parameters were unavailable or invalid. Using the original fixed parameters.'};
      }
      cached={...result,fetchedAt:new Date(now()).toISOString(),cached:false};return cached;
    })();
    try{return await inflight;}finally{inflight=null;}
  }
  return {
    async weights(req,res) {
      if(!begin(req,res,['GET','HEAD'],deploymentHost))return;
      try{writeJSON(req,res,200,await loadWeights());}catch{writeJSON(req,res,500,{error:'The parameter response could not be created.'});}
    },
    async verify(req,res) {
      if(!begin(req,res,['POST'],deploymentHost))return;
      try {
        const {config,weights}=verifyInput(await bodyJSON(req));
        const result=recalculate(config,weights);
        writeJSON(req,res,200,{verifiedAt:new Date(now()).toISOString(),verificationId:randomUUID(),...result});
      } catch(error) {writeJSON(req,res,error.status??500,{error:error.status?error.message:'The challenge could not be recomputed.'});}
    }
  };
}

const handlers=createChallengeHandlers();
export const challengeWeights=handlers.weights;
export const challengeVerify=handlers.verify;
