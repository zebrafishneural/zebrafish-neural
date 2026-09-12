import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createStore } from '../lib/store.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'zebra-chess-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: await createStore(directory) };
}

test('roundtrip and fresh store recover complete checkpoint, decisions and archives', async t => {
  const { directory, store } = await fixture(t);
  assert.equal(await store.loadCheckpoint(), null);
  assert.equal(await store.getDecision('game_1', 1), null);
  assert.equal(await store.getGame('game_1'), null);
  assert.deepEqual(await store.listGames(), []);
  const checkpoint = { gameId: 'game_1', history: ['e2e4', 'e7e5'], seed: 42, pending: { rates: [0, 0.2, 1], move: 'g1f3' } };
  const decision = { fen: 'source position', move: 'e2e4', scores: { forward: 0.6, back: 0.2 } };
  const game = { id: 'game_1', startedAt: '2026-09-12T10:00:00Z', finishedAt: '2026-09-12T10:05:00Z', result: '1-0', ply: 2, fishColor: 'w', opponent: 'baseline', history: checkpoint.history };
  await store.saveCheckpoint(checkpoint);
  await store.saveDecision('game_1', 1, decision);
  await store.saveGame(game);
  const reopened = await createStore(directory);
  assert.deepEqual(await reopened.loadCheckpoint(), checkpoint);
  assert.deepEqual(await reopened.getDecision('game_1', 1), decision);
  assert.deepEqual(await reopened.getGame('game_1'), game);
  assert.deepEqual(await reopened.listGames(), [{ id: game.id, startedAt: game.startedAt, finishedAt: game.finishedAt, result: game.result, ply: 2, fishColor: 'w', opponent: 'baseline' }]);
  const wrapper = JSON.parse(await readFile(join(directory, 'checkpoint.json'), 'utf8'));
  assert.equal(wrapper.schemaVersion, 1);
  assert.equal(wrapper.sha256, createHash('sha256').update(JSON.stringify(wrapper.payload)).digest('hex'));
});

test('canonical identical rewrites are accepted; immutable conflicts preserve original', async t => {
  const { store } = await fixture(t);
  await store.saveDecision('stable', 5, { z: 1, a: { y: 2, x: 3 } });
  await store.saveDecision('stable', 5, { a: { x: 3, y: 2 }, z: 1 });
  await assert.rejects(store.saveDecision('stable', 5, { z: 2, a: { y: 2, x: 3 } }), /Conflicting immutable/);
  assert.deepEqual(await store.getDecision('stable', 5), { a: { x: 3, y: 2 }, z: 1 });
  await store.saveGame({ id: 'stable', result: '1-0' });
  await store.saveGame({ result: '1-0', id: 'stable' });
  await assert.rejects(store.saveGame({ id: 'stable', result: '0-1' }), /Conflicting immutable/);
});

test('checkpoint replacement retains previous verified commit and leaves no pending files', async t => {
  const { directory, store } = await fixture(t);
  await store.saveCheckpoint({ ply: 1, history: ['e4'] });
  await store.saveCheckpoint({ ply: 2, history: ['e4', 'e5'] });
  assert.deepEqual((JSON.parse(await readFile(join(directory, 'checkpoint.previous.json'), 'utf8'))).payload, { history: ['e4'], ply: 1 });
  await store.saveCheckpoint({ history: ['e4', 'e5'], ply: 2 });
  assert.deepEqual((JSON.parse(await readFile(join(directory, 'checkpoint.previous.json'), 'utf8'))).payload, { history: ['e4'], ply: 1 });
  assert.deepEqual((await readdir(directory)).sort(), ['checkpoint.json', 'checkpoint.previous.json']);
});

test('damaged checkpoint fails loudly despite a valid backup and cannot be overwritten', async t => {
  const { directory, store } = await fixture(t);
  await store.saveCheckpoint({ ply: 1 });
  await store.saveCheckpoint({ ply: 2 });
  const path = join(directory, 'checkpoint.json');
  const wrapper = JSON.parse(await readFile(path, 'utf8'));
  wrapper.payload.ply = 99;
  await writeFile(path, JSON.stringify(wrapper));
  await assert.rejects(store.loadCheckpoint(), /Corrupt storage.*SHA-256 mismatch/);
  await assert.rejects(store.saveCheckpoint({ ply: 3 }), /Corrupt storage/);
  await unlink(path);
  await assert.rejects(store.loadCheckpoint(), /previous checkpoint exists/);
  await assert.rejects(store.saveCheckpoint({ ply: 3 }), /restore explicitly/);
});

test('corrupt decision and archive reject reads, listing and attempted replacement', async t => {
  const { directory, store } = await fixture(t);
  await store.saveDecision('damage', 1, { move: 'e4' });
  await writeFile(join(directory, 'decisions', 'damage', '000000000001.json'), '{truncated');
  await assert.rejects(store.getDecision('damage', 1), /Corrupt storage/);
  await assert.rejects(store.saveDecision('damage', 1, { move: 'e4' }), /Corrupt storage/);
  await store.saveGame({ id: 'damage' });
  await writeFile(join(directory, 'games', 'damage.json'), '{"schemaVersion":1}');
  await assert.rejects(store.getGame('damage'), /Corrupt storage/);
  await assert.rejects(store.listGames(), /Corrupt storage/);
});

test('IDs and ply validation prevent traversal and unsupported JSON is rejected', async t => {
  const { store } = await fixture(t);
  for (const id of ['../escape', '..', '/absolute', 'a/b', 'a\\b', 'C:escape', '', 'a'.repeat(81), 123]) {
    await assert.rejects(store.getGame(id), /Invalid game ID/);
    await assert.rejects(store.saveGame({ id }), /Invalid game ID/);
    await assert.rejects(store.getDecision(id, 1), /Invalid game ID/);
    await assert.rejects(store.saveDecision(id, 1, {}), /Invalid game ID/);
  }
  for (const ply of [0, -1, 1.5, 10001, NaN, '1']) await assert.rejects(store.saveDecision('safe', ply, {}), /Ply must/);
  for (const payload of [{ missing: undefined }, { n: Infinity }, { n: BigInt(2) }, { date: new Date() }, []]) await assert.rejects(store.saveCheckpoint(payload), /JSON/);
  const cyclic = {}; cyclic.self = cyclic;
  await assert.rejects(store.saveCheckpoint(cyclic), /JSON/);
  await assert.rejects(store.saveGame({ id: 'one', gameId: 'two' }), /disagree/);
});

test('archive summaries are newest first and support a gameId payload', async t => {
  const { store } = await fixture(t);
  await store.saveGame({ id: 'old', startedAt: '2026-09-11T10:00:00Z', ply: 8 });
  await store.saveGame({ gameId: 'new', startedAt: '2026-09-12T10:00:00Z', history: ['e4', 'e5'] });
  const { listGames } = store;
  const summaries = await listGames();
  assert.deepEqual(summaries.map(game => game.id), ['new', 'old']);
  assert.equal(summaries[0].ply, 2);
});
