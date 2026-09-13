import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {Chess} from '../../chess/public/lib/chess.js';
import {BASE_WEIGHTS, decisionSteps} from '../../chess/lib/selector.mjs';
import {verifyDecision, MAX_INPUT_BYTES} from '../verification/verify.mjs';
import {PlayRuntime} from '../lib/runtime.mjs';
import {createPlayStore} from '../lib/store.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function decision(fen = new Chess().fen(), seed = 19734) {
  const iterator = decisionSteps(fen, {seed, weights: BASE_WEIGHTS}), samples = [];
  for (;;) {
    const next = iterator.next();
    if (next.done) {
      const board = new Chess(fen), uci = next.value.selectedUci;
      board.move({from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? {promotion: uci[4]} : {})});
      return {...next.value, gameId: 'play_' + 'a'.repeat(32), ply: 1, actor: 'fish', fenBefore: fen,
        fenAfter: board.fen(), samples, weightsHash: digest(BASE_WEIGHTS)};
    }
    const {retina, ...sample} = next.value; samples.push(sample);
  }
}
const original = decision();

test('a complete runtime-style record replays every sample and candidate', async () => {
  const progress = [], result = await verifyDecision(JSON.stringify(original), {onProgress: value => progress.push(value)});
  assert.equal(result.status, 'verified'); assert.equal(result.ok, true);
  assert.ok(result.checks.every(check => check.passed)); assert.equal(result.mismatches.length, 0);
  assert.equal(result.computed.selectedUci, original.selectedUci); assert.equal(result.computed.sampleCount, original.samples.length);
  assert.equal(result.computed.candidateCount, 20); assert.equal(result.computed.forcedMove, false);
  assert.equal(result.numericTolerance, 1e-12); assert.ok(progress.length > 0);
  assert.match(result.scope, /not server or hardware attestation/);
});

test('an actual PlayRuntime committed and stored decision passes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zneuro-verify-runtime-'));
  const store = await createPlayStore(dir), runtime = await new PlayRuntime({store, stepsPerTick: 512}).initialize();
  t.after(async () => { await runtime.close(); await rm(dir, {recursive: true, force: true}); });
  const session = await runtime.create('b');
  for (let attempt = 0; attempt < 20 && runtime.sessions.get(session.gameId).pending; attempt++) await runtime.tick();
  assert.equal(runtime.error, null); assert.equal(runtime.sessions.get(session.gameId).game.ply, 1);
  const record = await runtime.decision(session.gameId, session.token, 1);
  const result = await verifyDecision(record);
  assert.equal(result.status, 'verified'); assert.equal(result.computed.selectedUci, record.selectedUci);
});

test('explicit storage wrapper hash is checked separately from replay', async () => {
  const wrapper = {schemaVersion: 1, sha256: digest(original), payload: original};
  assert.equal((await verifyDecision(wrapper)).status, 'verified');
  wrapper.sha256 = '0'.repeat(64);
  const bad = await verifyDecision(wrapper);
  assert.equal(bad.status, 'mismatch'); assert.equal(bad.checks.find(check => check.id === 'wrapper').passed, false);
});

test('a single legal move is verified as forced with zero neural comparisons', async () => {
  const record = decision('7k/8/8/8/8/8/1r6/K7 w - - 0 1');
  assert.equal(record.candidates.length, 1); assert.equal(record.samples.length, 0);
  const result = await verifyDecision(record);
  assert.equal(result.status, 'verified'); assert.equal(result.computed.forcedMove, true);
  assert.equal(result.computed.sampleCount, 0); assert.equal(result.computed.modelSteps, 0); assert.equal(result.computed.comparisonCount, 0);
});

const mutations = [
  ['same chosen move with changed neural rate', r => { r.samples[0].rates[0] += 0.001; }],
  ['candidate feature changed', r => { r.candidates[0].features[0] += 0.05; }],
  ['candidate removed despite an unchanged chosen move', r => { r.candidates.pop(); }],
  ['declared weights hash changed', r => { r.weightsHash = '0'.repeat(64); }],
  ['valid uint32 seed changed', r => { r.seed = (r.seed + 1) >>> 0; }],
  ['resulting FEN changed', r => { r.fenAfter = new Chess().fen(); }],
  ['starting FEN alias changed', r => { const board = new Chess(); board.move('e4'); r.fen = board.fen(); }],
  ['trace truncated', r => { r.samples.pop(); }],
  ['trace reordered', r => { [r.samples[0], r.samples[1]] = [r.samples[1], r.samples[0]]; }],
  ['trace sample added', r => { r.samples.push(structuredClone(r.samples[0])); }],
  ['sample rate missing', r => { r.samples[0].rates.pop(); }],
  ['sample input changed', r => { r.samples[0].inputFeatures.left += 0.01; }],
  ['sample pair identity changed', r => { r.samples[0].left.uci = 'a2a4'; }],
  ['sample orientation changed', r => { r.samples[0].orientation = 'swapped'; }],
  ['sample rate null', r => { r.samples[0].rates[0] = null; }],
  ['pair margin changed', r => { r.comparisons[0].margin += 0.01; }],
  ['seeded tie-break changed', r => { const pair = r.comparisons.find(pair => pair.tieBreak); assert.ok(pair); pair.tieBreak.draw += 0.01; }],
  ['protocol extra field', r => { r.protocol.hiddenEngine = false; }],
  ['protocol sample cadence changed', r => { r.protocol.sampleEverySteps = 4; }],
  ['feature definition changed', r => { r.featureDefinitions[0].description = 'Another input'; }],
  ['counter changed', r => { r.modelSteps++; }],
  ['selected move changed', r => { r.selectedUci = original.selectedUci === 'a2a3' ? 'a2a4' : 'a2a3'; }],
  ['unsupported model', r => { r.modelVersion += '-modified'; }],
  ['unsupported selector', r => { r.selectorVersion += '-modified'; }],
  ['non-neural control mode', r => { r.mode = 'random'; }],
  ['non-baseline frozen gain', r => { r.weights[0] += 0.001; r.weightsHash = digest(r.weights); }],
  ['negative seed', r => { r.seed = -1; }],
  ['fractional seed', r => { r.seed = 1.5; }],
  ['invalid FEN', r => { r.fenBefore = 'not a chess position'; }],
  ['missing entire trace', r => { delete r.samples; }],
  ['undeclared top-level data', r => { r.secretEvaluation = 12; }],
  ['non-finite value', r => { r.samples[0].rates[0] = NaN; }],
];
for (const [name, mutate] of mutations) test(`rejects tampering: ${name}`, async () => {
  const altered = structuredClone(original); mutate(altered);
  const result = await verifyDecision(altered);
  assert.equal(result.ok, false, name); assert.notEqual(result.status, 'verified', name);
});

test('malformed structures and prototype keys are rejected without crashes', async () => {
  const malicious = JSON.parse(JSON.stringify(original)); Object.defineProperty(malicious.samples[0], '__proto__', {value: {}, enumerable: true});
  const accessor = structuredClone(original); Object.defineProperty(accessor, 'seed', {get() { throw Error('Getter must never execute'); }, enumerable: true});
  const cycle = {}; cycle.self = cycle;
  for (const input of [null, [], {}, '{', malicious, accessor, cycle, ' '.repeat(MAX_INPUT_BYTES + 1)]) {
    const result = await verifyDecision(input); assert.equal(result.status, 'invalid'); assert.equal(result.ok, false);
  }
});

test('mismatch details are bounded and the explicit floating point tolerance is honored', async () => {
  const slightly = structuredClone(original); slightly.samples[0].rates[0] += 1e-13;
  assert.equal((await verifyDecision(slightly)).status, 'verified');
  const many = structuredClone(original);
  for (const sample of many.samples) sample.rates.fill(999);
  const result = await verifyDecision(many);
  assert.equal(result.status, 'mismatch'); assert.equal(result.mismatches.length, 20);
  assert.equal(result.checks.find(check => check.id === 'samples').passed, false);
});

test('CLI verifies ordinary decision JSON and returns failure for mismatches and oversized input', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'zneuro-verify-cli-')); t.after(() => rm(dir, {recursive: true, force: true}));
  const filename = join(dir, 'decision.json'), cli = fileURLToPath(new URL('../verification/cli.mjs', import.meta.url));
  await writeFile(filename, JSON.stringify(original));
  let run = spawnSync(process.execPath, [cli, filename], {encoding: 'utf8'});
  assert.equal(run.status, 0); assert.equal(JSON.parse(run.stdout).status, 'verified');
  const bad = structuredClone(original); bad.samples.pop(); await writeFile(filename, JSON.stringify(bad));
  run = spawnSync(process.execPath, [cli, filename], {encoding: 'utf8'});
  assert.equal(run.status, 1); assert.equal(JSON.parse(run.stdout).status, 'mismatch');
  await writeFile(filename, Buffer.alloc(MAX_INPUT_BYTES + 1, 32));
  run = spawnSync(process.execPath, [cli, filename], {encoding: 'utf8'});
  assert.equal(run.status, 1); assert.match(JSON.parse(run.stdout).reason, /8 MiB/);
});
