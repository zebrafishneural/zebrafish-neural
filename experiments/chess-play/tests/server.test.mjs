import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {startPlayServer} from '../server.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zneuro-play-http-'));
  const app = await startPlayServer({port: 0, dataDir: dir, autoStart: false, ...options}), base = `http://127.0.0.1:${app.port}`;
  t.after(async () => { await app.close(); await rm(dir, {recursive: true, force: true}); });
  async function request(path, {method = 'GET', token, body, origin = base, headers = {}} = {}) {
    return fetch(base + path, {method, headers: {...(origin ? {Origin: origin} : {}), ...(token ? {Authorization: `Bearer ${token}`} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {}), ...headers}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  }
  async function create(color = 'w', headers = {}) { const response = await request('/api/play/games', {method: 'POST', body: {color}, headers}); assert.equal(response.status, 201); return response.json(); }
  return {app, dir, base, request, create};
}
function nextMessage(ws) { return Promise.race([once(ws, 'message').then(([data]) => JSON.parse(data.toString())), new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('WebSocket message timed out')), 3000); timer.unref(); })]); }

test('HTTP origins, private game authorization, legal mutation and PGN are enforced', async t => {
  const {request, create, app} = await fixture(t), one = await create(), two = await create();
  assert.equal((await request('/healthz', {origin: null})).status, 200);
  assert.equal((await request('/api/play/games', {method: 'POST', body: {}, origin: null})).status, 403);
  assert.equal((await request('/api/play/games', {method: 'POST', body: {}, origin: 'https://attacker.invalid'})).status, 403);
  assert.equal((await request('/api/play/games', {method: 'POST', body: {}, headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await request(`/api/play/games/${one.gameId}`)).status, 401);
  assert.equal((await request(`/api/play/games/${one.gameId}`, {token: two.token})).status, 401);
  assert.equal((await request(`/api/play/games/${one.gameId}?token=${one.token}`, {token: one.token})).status, 400);
  assert.equal((await request('/data/anything.json')).status, 404);
  assert.equal((await request('/api/play/games')).status, 404);
  const body = {from: 'e2', to: 'e4', expectedPly: 0, requestId: 'http-move-0001'};
  const moved = await request(`/api/play/games/${one.gameId}/move`, {method: 'POST', token: one.token, body});
  assert.equal(moved.status, 200); assert.equal((await moved.json()).state.game.ply, 1);
  assert.equal((await request(`/api/play/games/${one.gameId}/moves/1`, {token: one.token})).status, 404);
  for (let step = 0; step < 1000 && app.runtime.sessions.get(one.gameId).pending; step++) await app.runtime.tick();
  const record = await request(`/api/play/games/${one.gameId}/moves/2`, {token: one.token}); assert.equal(record.status, 200); assert.equal((await record.json()).actor, 'fish');
  const pgn = await request(`/api/play/games/${one.gameId}/pgn`, {token: one.token}); assert.equal(pgn.status, 200); assert.match(await pgn.text(), /1\. e4/);
  const untouched = await request(`/api/play/games/${two.gameId}`, {token: two.token}); assert.equal((await untouched.json()).game.ply, 0);
});

test('same-game websocket clients share actual snapshots and wrong token closes', async t => {
  const {app, base, create} = await fixture(t), one = await create('b'), two = await create('w');
  const makeWs = () => new WebSocket(base.replace('http:', 'ws:') + '/play-ws', {origin: base});
  const a = makeWs(), b = makeWs(); t.after(() => { a.terminate(); b.terminate(); });
  await Promise.all([once(a, 'open'), once(b, 'open')]);
  const firstA = nextMessage(a), firstB = nextMessage(b);
  a.send(JSON.stringify({type: 'subscribe', gameId: one.gameId, token: one.token})); b.send(JSON.stringify({type: 'subscribe', gameId: one.gameId, token: one.token}));
  assert.deepEqual((await firstA).game, (await firstB).game);
  const nextA = nextMessage(a), nextB = nextMessage(b); await app.runtime.tick();
  const [left, right] = await Promise.all([nextA, nextB]); assert.deepEqual(left, right); assert.equal(left.status, 'comparing'); assert.equal(left.selection.rates.length, 8);
  const bad = makeWs(); t.after(() => bad.terminate()); await once(bad, 'open');
  const closed = once(bad, 'close'); bad.send(JSON.stringify({type: 'subscribe', gameId: one.gameId, token: two.token}));
  assert.equal((await closed)[0], 1008);
});

test('untrusted forwarded IP cannot bypass new-game rate limit; explicit local proxy can', async t => {
  const ordinary = await fixture(t, {createPerMinute: 1}); await ordinary.create('w', {'X-Forwarded-For': '198.51.100.1'});
  assert.equal((await ordinary.request('/api/play/games', {method: 'POST', body: {color: 'w'}, headers: {'X-Forwarded-For': '198.51.100.2'}})).status, 429);
  const proxy = await fixture(t, {createPerMinute: 1, trustProxy: 'loopback'});
  await proxy.create('w', {'X-Forwarded-For': '198.51.100.1'}); await proxy.create('w', {'X-Forwarded-For': '198.51.100.2'});
  assert.equal((await proxy.request('/api/play/games', {method: 'POST', body: {color: 'w'}, headers: {'X-Forwarded-For': '198.51.100.2'}})).status, 429);
});

test('payload bounds and single data-directory ownership are enforced', async t => {
  const {request, dir} = await fixture(t);
  assert.equal((await request('/api/play/games', {method: 'POST', body: {color: 'w', pad: 'x'.repeat(3000)}})).status, 413);
  await assert.rejects(startPlayServer({port: 0, dataDir: dir}), /already has an owner/);
});
