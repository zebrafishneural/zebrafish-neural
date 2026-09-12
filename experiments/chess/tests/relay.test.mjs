import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { startRelay } from '../relay.mjs';

async function fixture(t, options = {}) {
  const seen = [], sources = [], messages = [];
  const snapshot = { schemaVersion: 1, seq: 1, game: { id: 'fixture', ply: 0 } };
  let handler = (req, res) => {
    res.setHeader('Content-Type', req.url.endsWith('.pgn') ? 'application/x-chess-pgn' : 'application/json');
    res.setHeader('Set-Cookie', 'must-not-forward=1');
    res.end(req.method === 'HEAD' ? undefined : req.url.endsWith('.pgn') ? '[Result "*"]\n*' : JSON.stringify({ path: req.url }));
  };
  const origin = createServer((req, res) => { seen.push({ url: req.url, method: req.method, headers: req.headers }); handler(req, res); });
  const wss = new WebSocketServer({ server: origin });
  wss.on('connection', (ws, req) => {
    sources.push({ ws, headers: req.headers });
    ws.on('error', () => {});
    ws.on('message', message => messages.push(message.toString()));
    ws.send(JSON.stringify(snapshot));
  });
  await new Promise(done => origin.listen(0, '127.0.0.1', done));
  const upstream = `http://127.0.0.1:${origin.address().port}`;
  const relay = await startRelay({ port: 0, upstream, ...options });
  const clients = [], clientErrors = [];
  let tearingDown = false;
  async function closeClient(ws) {
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise(done => {
      const timer = setTimeout(() => ws.terminate(), 1000);
      ws.once('close', () => { clearTimeout(timer); done(); });
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'Test completed.');
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    });
  }
  t.after(async () => {
    tearingDown = true;
    await Promise.all(clients.map(closeClient));
    await relay.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(done => wss.close(done));
    const closed = new Promise(done => origin.close(done)); origin.closeAllConnections(); await closed;
    assert.deepEqual(clientErrors, [], 'Accepted spectator connections had no unexpected transport errors.');
  });
  async function http(path, { method = 'GET', headers = {} } = {}) {
    return new Promise((ok, no) => {
      const req = request({ hostname: '127.0.0.1', port: relay.port, path, method, headers }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      }); req.on('error', no); req.end();
    });
  }
  async function connect(extra = {}) {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws`, { origin: 'https://zebraneural.com', ...extra });
    clients.push(ws);
    ws.on('error', error => { if (!tearingDown) clientErrors.push(error.message); });
    // Observe both promises immediately: a failed handshake rejects both events.
    const [, message] = await Promise.all([once(ws, 'open'), once(ws, 'message')]).catch(error => { throw new Error(`Accepted WS (${extra.origin ?? 'default'}) failed: ${error.message}`, { cause: error }); });
    return { ws, first: JSON.parse(message[0].toString()) };
  }
  async function rejected(extra = {}, path = '/ws') {
    // A rejected upgrade is an HTTP response, not an established WebSocket.
    // Read it to completion without constructing then aborting a WS client.
    return new Promise((ok, no) => {
      const req = request({ hostname: '127.0.0.1', port: relay.port, path, agent: false, headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...(extra.origin === undefined ? {} : { Origin: extra.origin }), ...extra.headers,
      } }, res => {
        res.once('error', no);
        res.once('end', () => ok(res.statusCode));
        res.resume();
      });
      req.once('upgrade', (res, socket) => { socket.destroy(); no(new Error('Unexpected WebSocket acceptance.')); });
      req.once('error', no);
      req.end();
    });
  }
  return { relay, seen, sources, messages, snapshot, http, connect, rejected, setHandler: value => { handler = value; } };
}

test('read-only allowlist, exact CORS/Host and no forwarded user headers', async t => {
  const app = await fixture(t);
  for (const path of ['/healthz', '/api/state', '/api/games', '/api/games/game_1', '/api/games/game_1.pgn', '/api/games/game_1/moves/10000']) assert.equal((await app.http(path)).status, 200);
  const response = await app.http('/api/state', { headers: { Origin: 'https://zebraneural.com', Authorization: 'secret', Cookie: 'secret=1', 'X-Test': 'secret', 'X-Forwarded-For': '203.0.113.9' } });
  assert.equal(response.headers['access-control-allow-origin'], 'https://zebraneural.com');
  assert.equal(response.headers.vary, 'Origin');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['set-cookie'], undefined);
  for (const header of ['origin', 'authorization', 'cookie', 'x-test', 'x-forwarded-for']) assert.equal(app.seen.at(-1).headers[header], undefined);
  const head = await app.http('/api/state', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.equal(app.seen.at(-1).method, 'HEAD');
  assert.equal((await app.http('/api/state', { headers: { Origin: 'https://www.zebraneural.com' } })).status, 200);
  assert.equal((await app.http('/api/state', { headers: { Origin: 'http://127.0.0.1:4196' } })).status, 200);
  const accepted = app.seen.length;
  for (const path of ['/', '/index.html', '/data/checkpoint.json', '/api/state?x=1', '/api/games/../state', '/api/games/%2e%2e', '/api/games/g/moves/0', '/api/games/g/moves/10001', '//api/state']) assert.equal((await app.http(path)).status, 404, path);
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) assert.equal((await app.http('/api/state', { method })).status, 405);
  for (const origin of ['https://evil.example', 'https://zebraneural.com.evil.example', 'null']) assert.equal((await app.http('/api/state', { headers: { Origin: origin } })).status, 403);
  assert.equal((await app.http('/api/state', { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal(app.seen.length, accepted, 'Rejected requests never reach the runtime.');
});

test('HTTP response size, type, JSON validity and total timeout are bounded', async t => {
  const app = await fixture(t, { maxResponseBytes: 64, timeoutMs: 60 });
  app.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: 'x'.repeat(100) })); });
  assert.equal((await app.http('/api/state')).status, 502);
  app.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>no</html>'); });
  assert.equal((await app.http('/api/state')).status, 502);
  app.setHandler((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{invalid'); });
  assert.equal((await app.http('/api/state')).status, 502);
  app.setHandler(() => {});
  assert.equal((await app.http('/api/state')).status, 504);
});

test('spectators share one upstream snapshot stream and cannot send runtime messages', async t => {
  const app = await fixture(t);
  const first = await app.connect({ headers: { Authorization: 'never-forward' } });
  const second = await app.connect();
  assert.deepEqual(first.first, app.snapshot);
  assert.deepEqual(second.first, app.snapshot);
  assert.equal(app.sources.length, 1);
  assert.equal(app.sources[0].headers.origin, undefined);
  assert.equal(app.sources[0].headers.authorization, undefined);
  const nextFirst = once(first.ws, 'message'), nextSecond = once(second.ws, 'message');
  app.sources[0].ws.send(JSON.stringify({ ...app.snapshot, seq: 2 }));
  assert.equal(JSON.parse((await nextFirst)[0]).seq, 2);
  assert.equal(JSON.parse((await nextSecond)[0]).seq, 2);
  const closed = once(first.ws, 'close');
  first.ws.send('{"move":"e2e4"}');
  assert.equal((await closed)[0], 1008);
  assert.deepEqual(app.messages, []);
  assert.equal(second.ws.readyState, WebSocket.OPEN);
});

test('WebSocket origins, endpoint, actual-port Host and spectator limit are enforced', async t => {
  const app = await fixture(t, { maxSpectators: 2 });
  assert.equal(await app.rejected({ origin: 'https://evil.example' }), 403);
  assert.equal(await app.rejected({ headers: { Host: 'localhost:4396' } }), 403);
  assert.equal(await app.rejected({}, '/api/state'), 404);
  await app.connect();
  await app.connect({ origin: undefined });
  assert.equal(await app.rejected(), 503);
  assert.equal(app.sources.length, 1);
});

test('bad upstream snapshots close spectators and a later connection can recover', async t => {
  const app = await fixture(t);
  const first = await app.connect();
  const closed = once(first.ws, 'close');
  app.sources[0].ws.send('{"not":"a snapshot"}');
  assert.equal((await closed)[0], 1011);
  const second = await app.connect();
  assert.deepEqual(second.first, app.snapshot);
  assert.equal(app.sources.length, 2);
});

test('configuration cannot expose a public/upstream file origin or enlarge hard limits', async () => {
  for (const upstream of ['https://127.0.0.1:4196', 'http://example.com', 'http://127.0.0.1:4196/data', 'http://user:pass@127.0.0.1:4196']) await assert.rejects(startRelay({ upstream }), /Upstream/);
  await assert.rejects(startRelay({ maxSpectators: 129 }), /maxSpectators/);
  await assert.rejects(startRelay({ maxResponseBytes: 8 * 1024 * 1024 + 1 }), /maxResponseBytes/);
  await assert.rejects(startRelay({ allowedOrigins: ['https://zebraneural.com/'] }), /exact HTTP/);
});
