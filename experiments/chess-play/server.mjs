import {createServer} from 'node:http';
import {createServer as createLeaseServer, isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {readFile, mkdir, realpath, lstat} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer, WebSocket} from 'ws';
import {createPlayStore, PlayError, ID} from './lib/store.mjs';
import {PlayRuntime} from './lib/runtime.mjs';

const previewRoot = resolve(import.meta.dirname, '../../dist');
const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'};
const loopback = address => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address);
const tokenFor = req => /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
const fail = (status, code, message) => { throw new PlayError(status, code, message); };
function checkedLimit(value, fallback, max) {
  if (value === undefined || value === '') return fallback;
  const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > max) throw Error('Invalid service resource limit.');
  return number;
}
async function takeLease(dataDir) {
  await mkdir(dataDir, {recursive: true});
  const actual = (await realpath(dataDir)).toLowerCase(), port = 20000 + createHash('sha256').update(actual).digest().readUInt16LE() % 20000;
  const server = createLeaseServer(socket => socket.destroy());
  await new Promise((yes, no) => { server.once('error', () => no(Error('The play data directory already has an owner, or its lease port is occupied.'))); server.listen({port, host: '127.0.0.1', exclusive: true}, yes); });
  return {server, port};
}
class RateGate {
  constructor(now = Date.now) { this.now = now; this.entries = new Map(); }
  allow(key, limit, window = 60000) {
    const now = this.now();
    if (this.entries.size >= 4096) for (const [name, entry] of this.entries) if (entry.until <= now) this.entries.delete(name);
    let entry = this.entries.get(key);
    if (!entry || entry.until <= now) {
      if (this.entries.size >= 4096 && !entry) return false;
      entry = {count: 0, until: now + window}; this.entries.set(key, entry);
    }
    return ++entry.count <= limit;
  }
}
async function bodyFor(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) fail(415, 'JSON_REQUIRED', 'Content-Type must be application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(415, 'ENCODING_UNSUPPORTED', 'Compressed request bodies are not supported.');
  const length = Number(req.headers['content-length'] || 0);
  if (!Number.isFinite(length) || length > 2048) fail(413, 'TOO_LARGE', 'Request body is too large.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 2048) fail(413, 'TOO_LARGE', 'Request body is too large.'); chunks.push(chunk); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'INVALID_JSON', 'Request must contain a JSON object.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'INVALID_JSON', 'Request must contain a JSON object.');
  return body;
}

export async function startPlayServer({port = checkedLimit(process.env.PLAY_PORT, 4200, 65535), dataDir = resolve(process.env.PLAY_DATA_DIR || resolve(import.meta.dirname, 'data')),
  origins = (process.env.PLAY_ORIGINS || 'https://zebraneural.com').split(',').map(value => value.trim()).filter(Boolean),
  trustProxy = process.env.PLAY_TRUST_PROXY || '', runtimeOptions = {}, autoStart = true,
  maxBytes = checkedLimit(process.env.PLAY_MAX_DATA_BYTES, 512 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
  createPerMinute = 4, createGlobalPerMinute = 40, maxSockets = 256, maxSocketsPerIp = 8} = {}) {
  if (![ '', 'loopback' ].includes(trustProxy)) throw Error('PLAY_TRUST_PROXY must be empty or loopback.');
  const originSet = new Set(origins.map(origin => {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw Error('Origins must be exact HTTP(S) origins.');
    return origin;
  }));
  let server, runtime, wss, heartbeat;
  const owner = await takeLease(dataDir), rate = new RateGate(), socketCounts = new Map();
  try {
    const store = await createPlayStore(dataDir, {maxBytes});
    wss = new WebSocketServer({noServer: true, maxPayload: 1024, perMessageDeflate: false});
    function emit(id, state) {
      const data = JSON.stringify(state);
      for (const ws of wss.clients) {
        if (ws.gameId !== id || ws.readyState !== WebSocket.OPEN) continue;
        if (ws.bufferedAmount > 256 * 1024) { ws.terminate(); continue; }
        ws.send(data); if (state.type === 'expired') ws.close(1008, 'Session expired');
      }
    }
    runtime = new PlayRuntime({store,
      maxGames: checkedLimit(process.env.PLAY_MAX_GAMES, 128, 2048), maxJobs: checkedLimit(process.env.PLAY_MAX_JOBS, 2, 4),
      maxPlies: checkedLimit(process.env.PLAY_MAX_PLIES, 160, 300), lifetimeMs: checkedLimit(process.env.PLAY_SESSION_HOURS, 24, 168) * 3600000,
      ...runtimeOptions, onState: emit});
    await runtime.initialize();
    const allowedOrigin = req => typeof req.headers.origin === 'string' && originSet.has(req.headers.origin);
    const sourceIp = req => {
      const address = req.socket.remoteAddress || 'unknown';
      if (trustProxy === 'loopback' && loopback(address)) {
        const forwarded = req.headers['x-forwarded-for'];
        if (typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
      }
      return address;
    };
    server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Vary', 'Origin');
      if (allowedOrigin(req)) {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      }
      const json = (status, value) => { res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8'}); res.end(req.method === 'HEAD' ? undefined : JSON.stringify(value)); };
      try {
        const ip = sourceIp(req);
        if (req.headers.origin && !allowedOrigin(req)) fail(403, 'ORIGIN', 'Origin is not permitted.');
        if (!rate.allow(`http:${ip}`, 180)) { res.setHeader('Retry-After', '60'); fail(429, 'RATE_LIMIT', 'Too many requests. Please wait a minute.'); }
        if (req.method === 'OPTIONS') {
          if (!allowedOrigin(req)) fail(403, 'ORIGIN', 'An allowed Origin is required.');
          res.writeHead(204); res.end(); return;
        }
        if (!['GET', 'HEAD', 'POST'].includes(req.method)) fail(405, 'METHOD', 'Method not allowed.');
        const url = new URL(req.url, 'http://localhost'), path = url.pathname;
        if (url.search && path.startsWith('/api/')) fail(400, 'QUERY', 'Query parameters are not supported.');
        if (path === '/healthz' && ['GET', 'HEAD'].includes(req.method)) { json(runtime.error ? 503 : 200, runtime.health()); return; }
        if (req.method === 'POST' && !allowedOrigin(req)) fail(403, 'ORIGIN', 'An allowed Origin is required.');
        if (path === '/api/play/games' && req.method === 'POST') {
          const body = await bodyFor(req);
          if (!rate.allow(`create:${ip}`, createPerMinute) || !rate.allow('create-global', createGlobalPerMinute)) { res.setHeader('Retry-After', '60'); fail(429, 'RATE_LIMIT', 'New game limit reached. Resume your existing game or wait a minute.'); }
          json(201, await runtime.create(body.color)); return;
        }
        const match = /^\/api\/play\/games\/(play_[a-f0-9]{32})(?:\/(move|resign|pgn|moves\/(\d{1,3})))?$/.exec(path);
        if (match) {
          const [, id, action, plyText] = match, token = tokenFor(req);
          const session = runtime.authorize(id, token);
          if (!action && ['GET', 'HEAD'].includes(req.method)) { json(200, runtime.snapshot(session)); return; }
          if (['move', 'resign'].includes(action) && req.method === 'POST') { json(200, await runtime.mutate(id, token, action, await bodyFor(req))); return; }
          if (action === 'pgn' && ['GET', 'HEAD'].includes(req.method)) {
            res.writeHead(200, {'Content-Type': 'application/x-chess-pgn; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.pgn"`}); res.end(req.method === 'HEAD' ? undefined : session.game.pgn); return;
          }
          if (plyText && ['GET', 'HEAD'].includes(req.method)) {
            const ply = Number(plyText);
            json(200, await runtime.decision(id, token, ply)); return;
          }
          fail(405, 'METHOD', 'Method not allowed for this route.');
        }
        if (path.startsWith('/api/') || path.startsWith('/play-ws')) fail(404, 'NOT_FOUND', 'Route not found.');
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'METHOD', 'Method not allowed.');
        // Only frontend assets are served. Runtime data and project files never enter this route.
        const mapped = ['/', '/play', '/play/'].includes(path) ? '/play/index.html' : path;
        if (!mapped.startsWith('/play/') && !mapped.startsWith('/chess/')) fail(404, 'NOT_FOUND', 'Not found.');
        const permittedRoot = resolve(previewRoot, mapped.startsWith('/play/') ? 'play' : 'chess');
        const file = resolve(previewRoot, '.' + decodeURIComponent(mapped));
        if (!file.startsWith(permittedRoot + sep)) fail(404, 'NOT_FOUND', 'Not found.');
        const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail(404, 'NOT_FOUND', 'Not found.');
        const actual = await realpath(file); if (!actual.startsWith(permittedRoot + sep)) fail(404, 'NOT_FOUND', 'Not found.');
        res.writeHead(200, {'Content-Type': types[extname(file)] || 'application/octet-stream'}); res.end(req.method === 'HEAD' ? undefined : await readFile(file));
      } catch (failure) {
        if (!res.headersSent) {
          const status = failure.status || (failure.code === 'ENOENT' ? 404 : 500);
          json(status, {error: failure.status ? failure.message : status === 404 ? 'Not found.' : 'The request could not be completed.', code: failure.status ? failure.code : 'REQUEST_FAILED'});
        } else res.end();
      }
    });
    server.requestTimeout = 10000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxConnections = 512;
    server.on('clientError', (_, socket) => socket.destroy());
    server.on('upgrade', (req, socket, head) => {
      const ip = sourceIp(req);
      if (req.url !== '/play-ws' || !allowedOrigin(req) || wss.clients.size >= maxSockets || (socketCounts.get(ip) || 0) >= maxSocketsPerIp || !rate.allow(`ws:${ip}`, 30)) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, ws => {
        socketCounts.set(ip, (socketCounts.get(ip) || 0) + 1);
        const timer = setTimeout(() => ws.close(1008, 'Authentication required'), 3000);
        ws.on('close', () => { clearTimeout(timer); const count = (socketCounts.get(ip) || 1) - 1; if (count) socketCounts.set(ip, count); else socketCounts.delete(ip); });
        ws.on('error', () => {});
        ws.on('message', data => {
          try {
            if (ws.gameId) throw Error('This connection is read-only.');
            const message = JSON.parse(data.toString());
            if (message.type !== 'subscribe') throw Error('Subscribe first.');
            const session = runtime.authorize(message.gameId, message.token);
            if ([...wss.clients].filter(client => client.gameId === message.gameId).length >= 4) throw Error('Too many game connections.');
            ws.gameId = session.game.id; clearTimeout(timer); ws.send(JSON.stringify(runtime.snapshot(session)));
          } catch { ws.close(1008, 'Invalid subscription'); }
        });
      });
    });
    await new Promise((yes, no) => { server.once('error', no); server.listen(port, '127.0.0.1', yes); });
    port = server.address().port;
    originSet.add(`http://127.0.0.1:${port}`); originSet.add(`http://localhost:${port}`);
    heartbeat = setInterval(() => {
      for (const id of new Set([...wss.clients].map(ws => ws.gameId).filter(Boolean))) {
        const session = runtime.sessions.get(id);
        if (!session || runtime.now() >= session.expiresAt) emit(id, {type: 'expired', error: 'This game session has expired.'});
        else runtime.publish(session);
      }
    }, 5000);
    if (autoStart) runtime.start();
    return {runtime, store, port, dataDir, leasePort: owner.port,
      async close() { clearInterval(heartbeat); await runtime.close(); for (const ws of wss.clients) ws.terminate(); await new Promise(done => wss.close(done)); await new Promise(done => server.close(done)); await new Promise(done => owner.server.close(done)); }};
  } catch (failure) {
    clearInterval(heartbeat); await runtime?.close(); for (const ws of wss?.clients || []) ws.terminate(); wss?.close(); server?.close(); await new Promise(done => owner.server.close(done)); throw failure;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startPlayServer();
  console.log(`You vs the Fish: http://127.0.0.1:${app.port}/play/ | private player sessions | frozen controller gains`);
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await app.close(); process.exit(0); });
}
