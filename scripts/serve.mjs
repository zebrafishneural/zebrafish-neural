import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import challengeWeights from '../api/challenge-weights.js';
import challengeVerify from '../api/challenge-verify.js';
const root = resolve(import.meta.dirname, '../dist');
const port = Number(process.env.PORT || 4173);
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.bin':'application/octet-stream', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.md':'text/plain; charset=utf-8' };
const server = createServer(async (req,res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if(path==='/api/challenge-weights'){await challengeWeights(req,res);return;}
    if(path==='/api/challenge-verify'){await challengeVerify(req,res);return;}
    const target = resolve(root, '.' + (path.endsWith('/') ? path+'index.html' : path));
    if(target !== root && !target.startsWith(root+sep)) {res.writeHead(403).end();return;}
    if(!(await stat(target)).isFile()){res.writeHead(404).end('Not found');return;}
    res.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});
    res.end(await readFile(target));
  } catch { res.writeHead(404).end('Not found'); }
});
server.listen(port,'127.0.0.1',()=>console.log(`Zebrafish Neural ready: http://127.0.0.1:${port}`));
