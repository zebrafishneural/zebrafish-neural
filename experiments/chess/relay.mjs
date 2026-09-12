import { createServer, request } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const DEFAULT_ORIGINS = ['https://zebraneural.com', 'https://www.zebraneural.com', 'http://127.0.0.1:4196', 'http://localhost:4196'];
function route(path) {
  if (['/healthz', '/api/state', '/api/games'].includes(path)) return true;
  if (/^\/api\/games\/[a-zA-Z0-9_-]{1,80}(?:\.pgn)?$/.test(path)) return true;
  const move = path.match(/^\/api\/games\/[a-zA-Z0-9_-]{1,80}\/moves\/([1-9]\d{0,4})$/);
  return Boolean(move && Number(move[1]) <= 10000);
}

export async function startRelay({ port = 4396, upstream = 'http://127.0.0.1:4196', allowedOrigins = DEFAULT_ORIGINS, timeoutMs = 10000, maxResponseBytes = 8 * 1024 * 1024, maxSpectators = 128 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new TypeError('Invalid relay port.');
  const target = new URL(upstream);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new TypeError('Upstream must be an HTTP origin on 127.0.0.1.');
  for (const [label, value, maximum] of [['timeoutMs', timeoutMs, 60000], ['maxResponseBytes', maxResponseBytes, 8 * 1024 * 1024], ['maxSpectators', maxSpectators, 128]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`Invalid ${label}.`);
  }
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 16) throw new TypeError('Invalid allowed origins.');
  const origins = new Set(allowedOrigins.map(origin => {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new TypeError('Allowed origins must be exact HTTP(S) origins.');
    return origin;
  }));
  let boundPort = port, source = null, latest = null, closing = false, broadcastData = null, positionKey = null;
  const activeRequests = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512, perMessageDeflate: {threshold:1024,zlibDeflateOptions:{level:1},concurrencyLimit:4} });
  const authorized = req => req.headers.host === `127.0.0.1:${boundPort}` && (req.headers.origin === undefined || origins.has(req.headers.origin));
  const baseHeaders = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (origins.has(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  };
  const json = (req, res, status, error) => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ error }));
  };
  const send = (client, data) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (client.bufferedAmount > 256 * 1024) { client.terminate(); return; }
    client.send(data, error => { if (error) client.terminate(); });
  };
  const broadcast = () => {
    if (!latest || latest === broadcastData) return;
    broadcastData = latest;
    for (const client of wss.clients) send(client, latest);
  };
  // A single shared source, five public visual samples per second. Committed
  // board changes are sent immediately; full decision traces remain available.
  const visualTimer = setInterval(broadcast, 200);visualTimer.unref();
  function disconnectSource(code = 1013, reason = 'Upstream disconnected; retry.') {
    const previous = source;
    source = null; latest = null; broadcastData = null; positionKey = null;
    previous?.terminate();
    for (const client of wss.clients) client.close(code, reason);
  }
  function connectSource() {
    if (source || closing) return;
    const url = new URL('/ws', target); url.protocol = 'ws:';
    const current = new WebSocket(url, { handshakeTimeout: timeoutMs, maxPayload: maxResponseBytes, perMessageDeflate: false, followRedirects: false });
    source = current;
    current.on('message', (buffer, binary) => {
      if (source !== current) return;
      try {
        if (binary || buffer.length > maxResponseBytes) throw new Error('Invalid snapshot.');
        const data = buffer.toString('utf8'), snapshot = JSON.parse(data);
        if (!snapshot || snapshot.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0 || !snapshot.game || typeof snapshot.game !== 'object' || Array.isArray(snapshot.game)) throw new Error('Invalid snapshot.');
        latest = data;
        const key = `${snapshot.streamId}/${snapshot.game.id}/${snapshot.game.ply}/${snapshot.status}`;
        if (key !== positionKey) { positionKey = key; broadcast(); }
      } catch { disconnectSource(1011, 'Invalid upstream snapshot.'); }
    });
    current.on('error', () => { if (source === current) disconnectSource(); });
    current.on('close', () => { if (source === current) disconnectSource(); });
  }
  const server = createServer({ maxHeaderSize: 16384, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 5000 }, (req, res) => {
    baseHeaders(req, res);
    if (!authorized(req)) { json(req, res, 403, 'Origin or host not allowed.'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.setHeader('Allow', 'GET, HEAD'); res.setHeader('Connection', 'close'); json(req, res, 405, 'Read-only relay.'); return; }
    if (!route(req.url)) { json(req, res, 404, 'Route not available.'); return; }
    if (closing || activeRequests.size >= 32) { json(req, res, 503, 'Relay busy; retry.'); return; }
    const forwarded = request(new URL(req.url, target), { method: req.method, headers: { Accept: req.url.endsWith('.pgn') ? 'application/x-chess-pgn' : 'application/json' }, agent: false });
    activeRequests.add(forwarded);
    let settled = false;
    const cleanup = () => { clearTimeout(timer); activeRequests.delete(forwarded); };
    const fail = (status, message) => {
      if (settled) return;
      settled = true; cleanup(); forwarded.destroy(); json(req, res, status, message);
    };
    const timer = setTimeout(() => fail(504, 'Upstream response timed out.'), timeoutMs);
    forwarded.on('error', () => fail(502, 'Upstream unavailable.'));
    res.on('close', () => { if (!settled) { settled = true; cleanup(); forwarded.destroy(); } });
    forwarded.on('response', response => {
      const chunks = []; let bytes = 0;
      const expectedType = req.url.endsWith('.pgn') ? 'application/x-chess-pgn' : 'application/json';
      const type = response.headers['content-type'] ?? '';
      // Error bodies for a missing PGN can legitimately be JSON.
      if (!type.toLowerCase().startsWith(expectedType) && !(req.url.endsWith('.pgn') && (response.statusCode ?? 200) >= 400 && type.toLowerCase().startsWith('application/json'))) { response.destroy(); fail(502, 'Unexpected upstream content.'); return; }
      if (Number(response.headers['content-length']) > maxResponseBytes) { response.destroy(); fail(502, 'Upstream response too large.'); return; }
      response.on('error', () => fail(502, 'Incomplete upstream response.'));
      response.on('aborted', () => fail(502, 'Incomplete upstream response.'));
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) { response.destroy(); fail(502, 'Upstream response too large.'); }
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        const body = Buffer.concat(chunks);
        if (req.method !== 'HEAD' && type.toLowerCase().startsWith('application/json')) {
          try { JSON.parse(body.toString('utf8')); } catch { fail(502, 'Invalid upstream JSON.'); return; }
        }
        settled = true; cleanup();
        res.setHeader('Content-Type', type.toLowerCase().startsWith('application/json') ? 'application/json; charset=utf-8' : 'application/x-chess-pgn; charset=utf-8');
        if (req.url.endsWith('.pgn') && (response.statusCode ?? 200) < 400) res.setHeader('Content-Disposition', `attachment; filename="${req.url.split('/').at(-1)}"`);
        res.writeHead(response.statusCode ?? 502);
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    });
    forwarded.end();
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    const reject = (status, text) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    if (!authorized(req)) { reject(403, 'Forbidden'); return; }
    if (req.method !== 'GET' || req.url !== '/ws') { reject(404, 'Not Found'); return; }
    if (closing || wss.clients.size >= maxSpectators) { reject(503, 'Service Unavailable'); return; }
    wss.handleUpgrade(req, socket, head, client => {
      client.alive = true;
      client.on('pong', () => { client.alive = true; });
      client.on('message', () => client.close(1008, 'Read-only snapshots.'));
      client.on('error', () => {});
      client.on('close', () => {
        if (wss.clients.size === 0) { const previous = source; source = null; latest = null; previous?.terminate(); }
      });
      if (latest && source?.readyState === WebSocket.OPEN) send(client, latest);
      connectSource();
    });
  });
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.alive || client.bufferedAmount > 256 * 1024) { client.terminate(); continue; }
      client.alive = false; client.ping();
    }
  }, 15000);
  heartbeat.unref();
  try {
    await new Promise((ok, no) => { server.once('error', no); server.listen(port, '127.0.0.1', ok); });
    boundPort = server.address().port;
  } catch (error) { clearInterval(heartbeat); clearInterval(visualTimer); wss.close(); throw error; }
  return {
    port: boundPort, upstream: target.origin,
    async close() {
      if (closing) return;
      closing = true; clearInterval(heartbeat); clearInterval(visualTimer);
      const previous = source; source = null; latest = null; previous?.terminate();
      for (const client of wss.clients) client.terminate();
      for (const pending of activeRequests) pending.destroy();
      await new Promise(done => wss.close(done));
      const closed = new Promise(done => server.close(done));
      server.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relay = await startRelay({ port: Number(process.env.CHESS_RELAY_PORT || 4396), upstream: process.env.CHESS_RELAY_UPSTREAM || 'http://127.0.0.1:4196' });
  console.log(`Read-only chess relay: http://127.0.0.1:${relay.port} -> ${relay.upstream}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); process.exit(0); });
}
