import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, readdir, unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PlayRuntime} from '../lib/runtime.mjs';
import {createPlayStore} from '../lib/store.mjs';
import {BASE_WEIGHTS, decisionSteps} from '../../chess/lib/selector.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'zneuro-play-test-'));
  const store = await createPlayStore(dir), runtime = await new PlayRuntime({store, ...options}).initialize();
  t.after(async () => { await runtime.close(); await rm(dir, {recursive: true, force: true}); });
  return {dir, store, runtime};
}
async function finishFish(runtime, id) {
  for (let attempt = 0; attempt < 5000; attempt++) {
    await runtime.tick();
    assert.equal(runtime.error, null);
    if (!runtime.sessions.get(id).pending) return;
  }
  assert.fail('Fish did not finish within the declared step bound.');
}
const input = (expectedPly = 0, requestId = 'test-move-0001') => ({from: 'e2', to: 'e4', expectedPly, requestId});
const rejectsCode = (action, code) => assert.rejects(action, failure => failure.code === code);

test('human moves are legal and versioned; duplicate requests cannot play twice', async t => {
  const {runtime} = await fixture(t), game = await runtime.create('w');
  assert.equal(game.state.status, 'waiting-player'); assert.equal(game.state.legalMoves.length, 20);
  await rejectsCode(runtime.mutate(game.gameId, game.token, 'move', {...input(), to: 'e5'}), 'ILLEGAL_MOVE');
  await rejectsCode(runtime.mutate(game.gameId, game.token, 'move', input(1)), 'STALE_POSITION');
  const outcomes = await Promise.all([runtime.mutate(game.gameId, game.token, 'move', input()), runtime.mutate(game.gameId, game.token, 'move', input())]);
  assert.equal(outcomes[0].state.game.ply, 1); assert.equal(outcomes[1].duplicate, true);
  assert.equal(outcomes[0].state.status, 'queued');
  await rejectsCode(runtime.mutate(game.gameId, game.token, 'move', {...input(1, 'test-move-0002'), from: 'd2', to: 'd4'}), 'NOT_YOUR_TURN');
  await rejectsCode(runtime.mutate(game.gameId, game.token, 'move', {...input(), to: 'e3'}), 'IDEMPOTENCY_CONFLICT');
});

test('sessions have isolated bearer tokens and store hashes only', async t => {
  const {runtime, dir} = await fixture(t), one = await runtime.create('w'), two = await runtime.create('b');
  assert.notEqual(one.gameId, two.gameId); assert.notEqual(one.token, two.token);
  assert.throws(() => runtime.authorize(one.gameId, two.token), failure => failure.code === 'UNAUTHORIZED');
  assert.throws(() => runtime.authorize(one.gameId, ''), failure => failure.code === 'UNAUTHORIZED');
  const disk = await readFile(join(dir, `${one.gameId}.json`), 'utf8');
  assert.ok(!disk.includes(one.token)); assert.ok(disk.includes('tokenHash'));
  assert.ok(!JSON.stringify(one.state).includes('tokenHash'));
  assert.equal(two.state.humanColor, 'b'); assert.equal(two.state.game.fishColor, 'w');
});

test('fish move and all streamed rates come from the original deterministic selector', async t => {
  const events = [], {runtime, store} = await fixture(t, {onState: (_, state) => events.push(state), stepsPerTick: 32});
  const game = await runtime.create('w'); await runtime.mutate(game.gameId, game.token, 'move', input());
  const pending = structuredClone(runtime.sessions.get(game.gameId).pending);
  await finishFish(runtime, game.gameId);
  const decision = await store.getDecision(game.gameId, 2), generator = decisionSteps(pending.fen, {seed: pending.seed, weights: BASE_WEIGHTS});
  const samples = []; let result;
  for (;;) { const next = generator.next(); if (next.done) { result = next.value; break; } const {retina, ...sample} = next.value; samples.push(sample); }
  assert.equal(decision.selectedUci, result.selectedUci); assert.deepEqual(decision.comparisons, result.comparisons);
  assert.deepEqual(decision.samples, samples); assert.deepEqual(decision.weights, BASE_WEIGHTS);
  assert.ok(events.some(state => state.status === 'comparing' && state.selection?.rates.length === 8));
  const state = runtime.snapshot(runtime.authorize(game.gameId, game.token));
  assert.equal(state.game.ply, 2); assert.equal(state.status, 'waiting-player'); assert.equal(state.scope.training, false);
  assert.equal(state.game.moves[1].actor, 'fish'); assert.equal(state.game.moves[0].actor, 'human');
});

test('default stream exposes each input feature and both comparison orientations', async t => {
  const selections = [], {runtime} = await fixture(t, {onState: (_, state) => { if (state.selection) selections.push(state.selection); }});
  const game = await runtime.create('b'); await finishFish(runtime, game.gameId);
  assert.deepEqual([...new Set(selections.map(sample => sample.featureId))].sort(), ['captureValue', 'centralControl', 'destinationSafety', 'givesCheck']);
  assert.deepEqual([...new Set(selections.map(sample => sample.orientation))].sort(), ['forward', 'swapped']);
  for (const sample of selections) assert.equal(sample.rates.length, 8);
});

test('restart resumes durable pending decision and preserves idempotency after fish reply', async t => {
  const {runtime, store} = await fixture(t, {stepsPerTick: 2}), game = await runtime.create('w');
  await runtime.mutate(game.gameId, game.token, 'move', input()); await runtime.tick();
  const before = structuredClone(runtime.sessions.get(game.gameId));
  await runtime.close();
  const restarted = await new PlayRuntime({store, stepsPerTick: 128}).initialize(); t.after(() => restarted.close());
  assert.deepEqual(restarted.sessions.get(game.gameId), before);
  await finishFish(restarted, game.gameId);
  const duplicate = await restarted.mutate(game.gameId, game.token, 'move', input());
  assert.equal(duplicate.duplicate, true); assert.equal(duplicate.committedPly, 1); assert.equal(duplicate.state.game.ply, 2);
});

test('decision written before interrupted checkpoint commit is recovered without a duplicate move', async t => {
  const {runtime, store} = await fixture(t, {stepsPerTick: 512}), game = await runtime.create('w');
  await runtime.mutate(game.gameId, game.token, 'move', input());
  const save = store.saveSession; store.saveSession = async session => { if (session.game.ply === 2) throw Error('Simulated interrupted checkpoint commit'); return save(session); };
  await runtime.tick(); assert.ok(runtime.error); assert.equal(runtime.sessions.get(game.gameId).game.ply, 1);
  const orphan = await store.getDecision(game.gameId, 2); assert.ok(orphan);
  await runtime.close(); store.saveSession = save;
  const restarted = await new PlayRuntime({store, stepsPerTick: 512}).initialize(); t.after(() => restarted.close());
  assert.equal(restarted.sessions.get(game.gameId).game.ply, 1);
  await finishFish(restarted, game.gameId);
  const record = await store.getDecision(game.gameId, 2);
  assert.deepEqual(record, orphan); assert.equal(restarted.sessions.get(game.gameId).game.moves.length, 2);
});

test('thinking jobs and game capacity are bounded; queued sessions all finish', async t => {
  const {runtime} = await fixture(t, {maxGames: 3, maxJobs: 1, stepsPerTick: 64});
  const games = await Promise.all([runtime.create('b'), runtime.create('b'), runtime.create('b')]);
  await rejectsCode(runtime.create('w'), 'CAPACITY');
  await runtime.tick(); assert.equal(runtime.jobs.size, 1); assert.equal(runtime.health().queued, 2);
  for (let index = 0; index < 100; index++) { await runtime.tick(); assert.ok(runtime.jobs.size <= 1); if (!runtime.health().queued && !runtime.jobs.size) break; }
  for (const game of games) assert.equal(runtime.sessions.get(game.gameId).game.ply, 1);
});

test('resignation is durable and idempotent even while fish is comparing', async t => {
  const {runtime, store} = await fixture(t), game = await runtime.create('b');
  await runtime.tick(); assert.equal(runtime.jobs.size, 1);
  const request = {expectedPly: 0, requestId: 'test-resign-0001'};
  const result = await runtime.mutate(game.gameId, game.token, 'resign', request);
  assert.equal(result.state.status, 'gameover'); assert.equal(result.state.game.result.winner, 'w'); assert.equal(runtime.jobs.size, 0);
  assert.equal((await runtime.mutate(game.gameId, game.token, 'resign', request)).duplicate, true);
  const restarted = await new PlayRuntime({store}).initialize(); t.after(() => restarted.close());
  assert.equal(restarted.snapshot(restarted.authorize(game.gameId, game.token)).status, 'gameover');
});

test('expired session token cannot be used and only that session data is reclaimed', async t => {
  let now = 1000;
  const {runtime, dir} = await fixture(t, {now: () => now, lifetimeMs: 100, maxGames: 1, stepsPerTick: 512});
  const old = await runtime.create('b'); await finishFish(runtime, old.gameId);
  assert.equal((await readdir(dir)).length, 2);
  now = 1100;
  assert.throws(() => runtime.authorize(old.gameId, old.token), failure => failure.code === 'EXPIRED');
  const fresh = await runtime.create('w'); assert.notEqual(fresh.gameId, old.gameId);
  assert.deepEqual(await readdir(dir), [`${fresh.gameId}.json`]);
});

test('storage damage and configured disk quota fail safely', async t => {
  const {runtime, dir} = await fixture(t), game = await runtime.create('w');
  const path = join(dir, `${game.gameId}.json`), wrapped = JSON.parse(await readFile(path, 'utf8'));
  wrapped.payload.game.fen = 'damaged'; await writeFile(path, JSON.stringify(wrapped));
  const broken = await createPlayStore(dir);
  await assert.rejects(new PlayRuntime({store: broken}).initialize(), /integrity/);
  const tinyDir = await mkdtemp(join(tmpdir(), 'zneuro-play-quota-')); t.after(() => rm(tinyDir, {recursive: true, force: true}));
  const tiny = await new PlayRuntime({store: await createPlayStore(tinyDir, {maxBytes: 100})}).initialize(); t.after(() => tiny.close());
  await rejectsCode(tiny.create('w'), 'STORAGE_FULL'); assert.equal(tiny.sessions.size, 0);
});

test('restart and record downloads reject missing or cross-game committed decisions', async t => {
  const {runtime, store, dir} = await fixture(t, {stepsPerTick: 512}), first = await runtime.create('b'), second = await runtime.create('b');
  await finishFish(runtime, first.gameId); await finishFish(runtime, second.gameId);
  const wrong = await store.getDecision(second.gameId, 1);
  await store.saveDecision(first.gameId, 1, wrong);
  await assert.rejects(runtime.decision(first.gameId, first.token, 1), /inconsistent/);
  await assert.rejects(new PlayRuntime({store}).initialize(), /inconsistent/);
  await unlink(join(dir, `${first.gameId}-1.json`));
  const reloadedStore = await createPlayStore(dir);
  await assert.rejects(new PlayRuntime({store: reloadedStore}).initialize(), /missing/);
});

test('storage-full pause recovers only after expired sessions free actual bytes', async t => {
  let now = 1000;
  const {runtime, store} = await fixture(t, {now: () => now, lifetimeMs: 100, stepsPerTick: 512});
  const expired = await runtime.create('b'); await finishFish(runtime, expired.gameId);
  now = 1050;
  const live = await runtime.create('b'), saved = store.saveDecision;
  store.saveDecision = async () => { const failure = Error('Simulated storage capacity'); failure.code = 'STORAGE_FULL'; throw failure; };
  await runtime.tick(); assert.equal(runtime.error?.code, 'STORAGE_FULL');
  await runtime.prune(); assert.ok(runtime.error);
  now = 1100; store.saveDecision = saved;
  await runtime.prune(); assert.equal(runtime.error, null); assert.ok(runtime.sessions.has(live.gameId));
  await finishFish(runtime, live.gameId); assert.equal(runtime.sessions.get(live.gameId).game.ply, 1);
});
