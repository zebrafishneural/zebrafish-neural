import test from 'node:test';
import assert from 'node:assert/strict';
import {Chess, DEFAULT_POSITION} from '../public/lib/chess.js';
import {makeState, step} from '../public/lib/model.js';
import {BASE_WEIGHTS, PARAMS, FEATURES, DT, PHASE_STEPS, TIE_EPSILON, SELECTOR_VERSION,
  decisionSteps, parameterStepExternal} from '../lib/selector.mjs';

const TACTICAL = '4k3/8/8/3q4/4P3/8/8/4K3 w - - 0 1';
function collect(fen = DEFAULT_POSITION, options) {
  const iterator = decisionSteps(fen, options), samples = [];
  let next = iterator.next();
  while (!next.done) {samples.push(next.value); next = iterator.next();}
  return {samples, record: next.value};
}
const uci = move => move.from + move.to + (move.promotion ?? '');
function assertFinite(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value));
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFinite);
}

test('external six-gain step is exactly the original external-input model at default weights', () => {
  const original = makeState({inputSource: 'browser'}), external = makeState({inputSource: 'browser'});
  // Alternating, asymmetric inputs exercise integrators, center gating, threat,
  // saturation, position integration and wall reflection; no target renderer.
  for (let tick = 0; tick < 2000; tick++) {
    const input = {left: (tick % 41) / 40, right: ((tick * 7) % 53) / 52,
      center: (tick % 17) / 16, threat: (tick % 19) / 18};
    original.features = {...input}; external.features = {...input};
    step(original); parameterStepExternal(external);
    assert.deepEqual(Array.from(external.rates), Array.from(original.rates));
    assert.deepEqual(external.fish, original.fish);
    assert.equal(external.time, original.time); assert.equal(external.distance, original.distance);
  }
});

test('every legal move is retained, including castling, en passant and all promotions', () => {
  const positions = [DEFAULT_POSITION, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1',
    '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', '4k3/P7/8/8/8/8/8/4K3 w - - 0 1'];
  for (const fen of positions) {
    const board = new Chess(fen), expected = board.moves({verbose: true}).map(uci).sort();
    const {record} = collect(fen, {seed: 17});
    assert.deepEqual(record.candidates.map(candidate => candidate.uci), expected);
    assert.ok(expected.includes(record.selectedUci));
    const selected = record.candidates.find(candidate => candidate.uci === record.selectedUci);
    assert.equal(selected.san, record.selectedSan);
    board.move(record.selectedSan); // The selected move also executes legally.
    assert.equal(record.comparisons.length, expected.length - 1);
    assert.equal(record.comparisonCount, expected.length - 1);
    assert.equal(record.modelSteps, (expected.length - 1) * 2 * FEATURES.length * PHASE_STEPS);
    assert.equal(record.selectorVersion, SELECTOR_VERSION);
  }
});

test('feature meanings come from the board and remain bounded, with no engine shortlist', () => {
  const {record} = collect(TACTICAL, {seed: 17});
  for (const candidate of record.candidates) {
    assert.equal(candidate.features.length, 4);
    candidate.features.forEach(value => assert.ok(value >= 0 && value <= 1));
  }
  const capture = record.candidates.find(candidate => candidate.uci === 'e4d5');
  assert.deepEqual(capture.features, [1, 1, 0, 0]);
  assert.equal(record.candidates.find(candidate => candidate.uci === 'e4e5').features[0], 0);
  const enPassant = collect('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', {mode: 'heuristic'}).record;
  assert.equal(enPassant.candidates.find(candidate => candidate.uci === 'e5d6').features[0], 1 / 9);
});

test('the same seed, position and frozen weights reproduce every sample and decision', () => {
  const options = {seed: 20260912, weights: [.7, .4, 1.3, .2, .12, .7]};
  const first = collect(TACTICAL, options), second = collect(TACTICAL, options);
  assert.deepEqual(second, first);
  assert.deepEqual(first.record.weights, options.weights);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
  assertFinite(first);
  const last = first.samples.at(-1);
  assert.equal(last.modelTime, first.record.modelDuration);
  assert.equal(last.comparisonIndex, first.record.comparisonCount);
});

test('swapped presentations mirror neural rates and reverse the integrated motor margin', () => {
  const {samples, record} = collect(TACTICAL, {seed: 17});
  const mirror = [1, 0, 3, 2, 4, 6, 5, 7];
  for (const comparison of record.comparisons) {
    const forward = samples.filter(sample => sample.comparisonIndex === comparison.index && sample.orientation === 'forward');
    const swapped = samples.filter(sample => sample.comparisonIndex === comparison.index && sample.orientation === 'swapped');
    assert.equal(forward.length, 12); assert.equal(swapped.length, 12);
    for (let index = 0; index < forward.length; index++) {
      const a = forward[index], b = swapped[index];
      assert.equal(a.left.uci, b.right.uci); assert.equal(a.right.uci, b.left.uci);
      for (let channel = 0; channel < 8; channel++) assert.ok(Math.abs(a.rates[channel] - b.rates[mirror[channel]]) < 1e-14);
      assert.ok(Math.abs(a.margin + b.margin) < 1e-14);
      assert.equal(a.inputFeatures.left, b.inputFeatures.right);
      assert.equal(a.inputFeatures.center, 0); assert.equal(a.inputFeatures.threat, 0);
      assert.equal(a.retina.length, 512);
      for (let pixel = 0; pixel < a.retina.length; pixel++) assert.ok(Math.abs(a.retina[pixel] - (pixel % 32 < 16 ? a.inputFeatures.left : a.inputFeatures.right)) < 1e-7);
    }
    assert.ok(Math.abs(comparison.forwardMargin + comparison.reverseMargin) < 1e-14);
    assert.equal(comparison.margin, (comparison.forwardMargin - comparison.reverseMargin) / 2);
    if (Math.abs(comparison.margin) > TIE_EPSILON) {
      assert.equal(comparison.tieBreak, null);
      assert.equal(comparison.winnerUci, comparison.margin > 0 ? comparison.leftUci : comparison.rightUci);
    }
  }
});

test('removing input or motor output removes neural selection and exposes logged tie-breaks', () => {
  const normal = collect(TACTICAL, {seed: 17});
  const noInput = collect(TACTICAL, {seed: 17, mode: 'no-input'});
  const clamped = collect(TACTICAL, {seed: 17, mode: 'clamped-motor'});
  assert.equal(normal.record.selectedUci, 'e4d5');
  assert.ok(normal.record.comparisons.some(comparison => Math.abs(comparison.margin) > 1e-5 && comparison.tieBreak === null));
  assert.ok(noInput.samples.every(sample => sample.rates.every(rate => rate === 0) && sample.retina.every(pixel => pixel === 0)));
  assert.ok(clamped.samples.some(sample => sample.rates[0] > .1 || sample.rates[1] > .1));
  assert.ok(clamped.samples.every(sample => sample.rates[5] === 0 && sample.rates[6] === 0));
  for (const diagnostic of [noInput, clamped]) {
    assert.ok(diagnostic.record.comparisons.every(comparison => comparison.margin === 0 && comparison.tieBreak?.selectedUci === comparison.winnerUci));
  }
  assert.equal(noInput.record.selectedUci, clamped.record.selectedUci);
  // A random tie-break can coincidentally choose the same move (seed17 does).
  // Check a fixed small seed set rather than falsely requiring every lesion to
  // change the final winner. The neural arm consistently chooses the capture.
  let changedChoices = 0;
  for (let seed = 0; seed < 8; seed++) {
    const intact = collect(TACTICAL, {seed}).record;
    const lesion = collect(TACTICAL, {seed, mode: 'clamped-motor'}).record;
    assert.equal(intact.selectedUci, 'e4d5');
    if (lesion.selectedUci !== intact.selectedUci) changedChoices++;
  }
  assert.ok(changedChoices > 0);
});

test('changing declared gains changes the real neural trace, while controls are explicitly separate', () => {
  const base = collect(TACTICAL, {seed: 17});
  const changed = collect(TACTICAL, {seed: 17, weights: [.8, .9, .4, .4, .3, 1.5]});
  assert.notDeepEqual(changed.samples.map(sample => sample.rates), base.samples.map(sample => sample.rates));
  assert.notDeepEqual(changed.record.comparisons.map(comparison => comparison.margin), base.record.comparisons.map(comparison => comparison.margin));
  for (const mode of ['random', 'heuristic']) {
    const control = collect(TACTICAL, {seed: 17, mode});
    assert.equal(control.samples.length, 0); assert.equal(control.record.modelSteps, 0);
    assert.equal(control.record.comparisons.length, 0); assert.equal(control.record.comparisonCount, 0);
    assert.ok(control.record.control?.kind);
    assert.ok(control.record.candidates.some(candidate => candidate.uci === control.record.selectedUci));
  }
});

test('terminal positions return no invented move; single legal options require no neural comparison', () => {
  for (const fen of ['7k/6Q1/5K2/8/8/8/8/8 b - - 0 1', '7k/5K2/6Q1/8/8/8/8/8 b - - 0 1']) {
    const {record, samples} = collect(fen);
    assert.equal(record.selectedUci, null); assert.equal(record.selectedSan, null);
    assert.equal(record.candidates.length, 0); assert.equal(record.comparisonCount, 0); assert.equal(samples.length, 0);
  }
  const fen = '7k/5K2/5Q2/8/8/8/8/8 b - - 0 1';
  const legal = new Chess(fen).moves({verbose: true});
  assert.equal(legal.length, 1);
  const {record, samples} = collect(fen);
  assert.equal(record.selectedUci, uci(legal[0])); assert.equal(samples.length, 0);
});

test('invalid gains, seeds, modes and positions fail rather than silently falling back', () => {
  const invalidWeights = [[1], [...BASE_WEIGHTS, 1], BASE_WEIGHTS.map(() => NaN), BASE_WEIGHTS.map(() => Infinity), 'defaults'];
  for (let index = 0; index < 6; index++) {
    const below = [...BASE_WEIGHTS], above = [...BASE_WEIGHTS];
    below[index] = PARAMS[index].min - .001; above[index] = PARAMS[index].max + .001;
    invalidWeights.push(below, above);
  }
  for (const weights of invalidWeights) assert.throws(() => collect(DEFAULT_POSITION, {weights}));
  for (const seed of [-1, 1.1, 2 ** 32, NaN, '17']) assert.throws(() => collect(DEFAULT_POSITION, {seed}));
  assert.throws(() => collect(DEFAULT_POSITION, {mode: 'engine'}));
  assert.throws(() => collect('invalid FEN'));
  assert.throws(() => parameterStepExternal(makeState(), BASE_WEIGHTS));
});
