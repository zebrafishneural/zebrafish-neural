import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { Chess } from '../public/lib/chess.js';
import { ChessRuntime } from '../lib/runtime.mjs';
import { createStore } from '../lib/store.mjs';
import { BASE_WEIGHTS, FEATURES, decisionSteps } from '../lib/selector.mjs';

const fixedTime = Date.parse('2026-09-12T12:00:00.000Z');
const moveObject = uci => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci.length === 5 ? { promotion: uci[4] } : {}) });

async function fixture(t, options = {}) {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'zebra-chess-runtime-'));
  const runtimes = [];
  const store = await createStore(directory);
  const clock = { value: fixedTime };
  function make(extra = {}) {
    const runtime = new ChessRuntime({ store, now: () => clock.value, stepsPerTick: 10000, opponentDelayMs: 0, betweenGamesMs: 5000, maxPlies: 12, ...options, ...extra });
    runtimes.push(runtime);
    return runtime;
  }
  t.after(async () => {
    for (const runtime of runtimes) await runtime.close();
    const rel = relative(tempRoot, resolve(directory));
    assert.ok(rel.startsWith('zebra-chess-runtime-') && !rel.includes(sep), 'Cleanup stays inside its explicit temporary directory.');
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, store, clock, make };
}

async function advanceUntil(runtime, predicate, maximum = 1000) {
  for (let count = 0; count < maximum && !predicate(); count++) {
    await runtime.tick();
    assert.equal(runtime.error, null, `Runtime failure: ${runtime.error}`);
  }
  assert.ok(predicate(), 'Runtime reached the expected state within the bounded tick count.');
}

function replay(game) {
  const board = new Chess();
  for (const [index, move] of game.moves.entries()) {
    assert.equal(move.ply, index + 1);
    const legal = board.moves({ verbose: true }).some(candidate => candidate.from + candidate.to + (candidate.promotion ?? '') === move.uci);
    assert.ok(legal, `Ply ${move.ply} (${move.uci}) is legal in its recorded position.`);
    assert.equal(board.move(moveObject(move.uci)).san, move.san);
  }
  assert.equal(board.fen(), game.fen);
  assert.equal(board.turn(), game.turn);
  assert.equal(board.history().length, game.ply);
  const fromPgn = new Chess();
  fromPgn.loadPgn(game.pgn);
  assert.equal(fromPgn.fen(), game.fen);
  assert.deepEqual(fromPgn.history(), board.history());
  return board;
}

test('autonomous game saves legal full PGN, real decision evidence and truthful final counters', async t => {
  const { store, make } = await fixture(t);
  const publications = [];
  const runtime = make({ onState: state => publications.push(state) });
  await runtime.initialize();
  await advanceUntil(runtime, () => runtime.game.result !== null);
  const game = runtime.game;
  const board = replay(game);
  assert.equal(runtime.status, 'between_games');
  assert.equal(game.finishedAt, new Date(fixedTime).toISOString());
  assert.deepEqual(game.weights, BASE_WEIGHTS);
  assert.equal(runtime.stats.games, 1);
  assert.equal(runtime.stats.wins + runtime.stats.draws + runtime.stats.losses, 1);
  const counter = { win: 'wins', draw: 'draws', loss: 'losses' }[game.result.outcome];
  assert.equal(runtime.stats[counter], 1);
  if (game.result.reason.startsWith('Demo move limit')) {
    assert.equal(game.ply, 12);
    assert.equal(game.result.outcome, 'draw');
    assert.equal(game.result.winner, null);
  } else assert.ok(board.isGameOver());

  const before = new Chess();
  for (const move of game.moves) {
    const fenBefore = before.fen();
    before.move(moveObject(move.uci));
    const record = await store.getDecision(game.id, move.ply);
    if (move.actor === 'fish') {
      assert.ok(record);
      assert.equal(record.selectedUci, move.uci);
      assert.equal(record.selectedSan, move.san);
      assert.equal(record.fenBefore, fenBefore);
      assert.equal(record.fenAfter, before.fen());
      assert.equal(record.actor, 'fish');
      assert.equal(record.weightsHash, game.weightsHash);
      assert.deepEqual(record.weights, BASE_WEIGHTS);
      assert.deepEqual(record.featureDefinitions, FEATURES);
      assert.equal(record.modelSteps, record.samples.length * 2);
      assert.equal(record.comparisonCount, record.candidates.length - 1);
      assert.equal(record.samples.length > 0, record.candidates.length > 1);
      assert.ok(record.samples.every(sample => sample.rates.length === 8 && sample.rates.every(value => Number.isFinite(value) && value >= 0 && value <= 1)));
      assert.ok(record.samples.every(sample => !Object.hasOwn(sample, 'retina')));
    } else assert.equal(record, null, 'Opponent moves do not fabricate neural decision records.');
  }
  assert.deepEqual(await store.getGame(game.id), game);
  assert.deepEqual((await store.loadCheckpoint()).game, game);
  assert.equal((await runtime.listGames()).length, 1);
  assert.ok(publications.every((state, index) => state.seq === index + 1));
  assert.ok(publications.every(state => state.scope.local === true && state.scope.training === false));

  await runtime.close();
  const restored = make();
  await restored.initialize();
  assert.deepEqual(restored.game, game);
  assert.deepEqual(restored.stats, runtime.stats, 'Restarting a completed game must not count its outcome again.');
  assert.equal((await restored.listGames()).length, 1);
});

test('restart mid-selection deterministically regenerates its full trace and preserves committed history', async t => {
  const { store, make } = await fixture(t);
  const runtime = make();
  await runtime.initialize();
  await advanceUntil(runtime, () => runtime.game.ply === 2);
  runtime.stepsPerTick = 3;
  await advanceUntil(runtime, () => runtime.trace.length >= 3);
  const saved = await store.loadCheckpoint();
  const history = structuredClone(saved.game.moves);
  const prefix = structuredClone(runtime.trace);
  assert.equal(saved.pending.ply, 3);
  assert.equal(saved.pending.fen, saved.game.fen);

  const generator = decisionSteps(saved.pending.fen, { seed: saved.pending.seed, weights: saved.game.weights });
  const expectedSamples = [];
  let completed;
  for (;;) {
    const next = generator.next();
    if (next.done) { completed = next.value; break; }
    const { retina, ...sample } = next.value;
    expectedSamples.push(sample);
  }
  assert.deepEqual(expectedSamples.slice(0, prefix.length), prefix);
  await runtime.close();

  const restored = make();
  await restored.initialize();
  assert.notEqual(restored.streamId, runtime.streamId);
  assert.deepEqual(restored.game.moves, history);
  assert.deepEqual(restored.pending, saved.pending);
  await advanceUntil(restored, () => restored.game.ply === 3);
  assert.deepEqual(restored.game.moves.slice(0, 2), history);
  assert.equal(restored.game.moves[2].uci, completed.selectedUci);
  assert.equal(restored.pending, null);
  const record = await store.getDecision(restored.game.id, 3);
  assert.deepEqual(record.samples, expectedSamples);
  assert.deepEqual(record.comparisons, completed.comparisons);
  assert.equal(record.seed, saved.pending.seed);
  assert.equal((await store.loadCheckpoint()).pending, null);
  replay(restored.game);
});

test('decision saved before a failed checkpoint commit can be replayed without immutable conflict', async t => {
  const { store, make } = await fixture(t);
  let failCommit = true;
  const injectedStore = {
    ...store,
    async saveCheckpoint(payload) {
      if (failCommit && payload.game.ply === 1 && payload.pending === null) {
        failCommit = false;
        throw new Error('Injected crash after decision save.');
      }
      return store.saveCheckpoint(payload);
    },
  };
  const runtime = make({ store: injectedStore });
  await runtime.initialize();
  // Call the persistence boundary directly, avoiding tick's expected console error.
  await runtime.beginSelection();
  let decision;
  for (;;) {
    const next = runtime.generator.next();
    if (next.done) { decision = next.value; break; }
    const { retina, ...sample } = next.value;
    runtime.trace.push(sample);
  }
  await assert.rejects(runtime.commit(decision.selectedUci, 'fish', decision), /Injected crash/);
  const savedRecord = await store.getDecision(runtime.game.id, 1);
  assert.ok(savedRecord);
  assert.equal((await store.loadCheckpoint()).game.ply, 0);
  assert.equal((await store.loadCheckpoint()).pending.ply, 1);
  await runtime.close();

  const restored = make();
  await restored.initialize();
  await advanceUntil(restored, () => restored.game.ply === 1);
  assert.deepEqual(await store.getDecision(restored.game.id, 1), savedRecord);
  assert.equal(restored.game.moves[0].uci, savedRecord.selectedUci);
  assert.equal(restored.error, null);
});

test('restored move history retains repetition state and records a genuine repetition draw', async t => {
  const { store, make } = await fixture(t, { maxPlies: 160 });
  const original = make();
  await original.initialize();
  const checkpoint = original.checkpoint();
  const board = new Chess();
  checkpoint.game.moves = [];
  for (const san of ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1']) {
    const move = board.move(san);
    checkpoint.game.moves.push({ ply: checkpoint.game.moves.length + 1, uci: move.from + move.to, san: move.san, actor: 'opening', from: move.from, to: move.to, at: new Date(fixedTime).toISOString() });
  }
  Object.assign(checkpoint.game, { fen: board.fen(), turn: board.turn(), ply: 7, pgn: board.pgn() });
  await store.saveCheckpoint(checkpoint);
  await original.close();
  const restored = make();
  await restored.initialize();
  await restored.commit('f6g8', 'opponent');
  assert.equal(replay(restored.game).isThreefoldRepetition(), true);
  assert.deepEqual(restored.game.result, { outcome: 'draw', reason: 'Threefold repetition', winner: null });
  assert.deepEqual(restored.stats, { games: 1, wins: 0, draws: 1, losses: 0 });
  assert.ok(restored.game.pgn.includes('[Result "1/2-1/2"]'));
});

test('next game changes color and opening while keeping completed history and counters', async t => {
  const { clock, make, store } = await fixture(t, { maxPlies: 4 });
  const runtime = make();
  await runtime.initialize();
  await advanceUntil(runtime, () => runtime.game.result !== null);
  const first = structuredClone(runtime.game);
  const counters = structuredClone(runtime.stats);
  await runtime.tick();
  assert.equal(runtime.game.id, first.id, 'Finished game remains visible before the inter-game delay.');
  clock.value += 5000;
  await runtime.tick();
  assert.equal(runtime.gameNumber, 2);
  assert.notEqual(runtime.game.id, first.id);
  assert.equal(first.fishColor, 'w');
  assert.equal(runtime.game.fishColor, 'b');
  assert.deepEqual(runtime.game.moves.map(move => move.san), ['d4', 'd5']);
  assert.ok(runtime.game.moves.every(move => move.actor === 'opening'));
  assert.equal(runtime.game.result, null);
  assert.deepEqual(runtime.stats, counters);
  assert.deepEqual(await store.getGame(first.id), first);
  assert.equal((await store.loadCheckpoint()).game.id, runtime.game.id);
  replay(runtime.game);
});

test('a legal checkmate is counted relative to the fish color, with matching PGN result', async t => {
  for (const fishColor of ['w', 'b']) {
    await t.test(fishColor === 'w' ? 'fish loses as white' : 'fish wins as black', async t => {
      const { store, make } = await fixture(t, { maxPlies: 160 });
      const original = make();
      await original.initialize();
      const checkpoint = original.checkpoint();
      const board = new Chess();
      checkpoint.game.moves = [];
      for (const san of ['f3', 'e5', 'g4']) {
        const move = board.move(san);
        checkpoint.game.moves.push({ ply: checkpoint.game.moves.length + 1, uci: move.from + move.to, san: move.san, actor: 'opening', from: move.from, to: move.to, at: new Date(fixedTime).toISOString() });
      }
      Object.assign(checkpoint.game, { fishColor, fen: board.fen(), turn: board.turn(), ply: 3, pgn: board.pgn() });
      await store.saveCheckpoint(checkpoint);
      await original.close();
      const restored = make();
      await restored.initialize();
      // Exercise the legal move commit/result boundary, independent of move selection.
      await restored.commit('d8h4', fishColor === 'b' ? 'fish' : 'opponent');
      assert.equal(replay(restored.game).isCheckmate(), true);
      assert.deepEqual(restored.game.result, { outcome: fishColor === 'b' ? 'win' : 'loss', reason: 'Checkmate', winner: 'b' });
      assert.deepEqual(restored.stats, { games: 1, wins: fishColor === 'b' ? 1 : 0, draws: 0, losses: fishColor === 'w' ? 1 : 0 });
      assert.ok(restored.game.pgn.includes('[Result "0-1"]'));
    });
  }
});
