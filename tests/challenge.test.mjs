import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULT_CONFIG, PRESETS, BASE_WEIGHTS, DT, validateConfig, createChallenge, stepChallenge, runChallenge, exportChallenge, encodeChallenge, decodeChallenge} from '../dist/lib/challenge.js';
import {makeRollout, tickRollout} from '../dist/lib/learning-core.js';
const config = changes => ({...structuredClone(DEFAULT_CONFIG), ...changes});
const advance = (exp, seconds) => {for (let index = 0; index < Math.round(seconds / DT); index++) stepChallenge(exp); return exp;};

test('identical gains yield identical arms and deterministic complete records', () => {
  const first = runChallenge(), second = runChallenge();
  assert.deepEqual(first, second);
  assert.deepEqual(first.arms.baseline, first.arms.learned);
  assert.equal(first.finished, true);
  assert.equal(first.arms.baseline.result.reached, true);
  assert.ok(first.arms.baseline.result.finalDistance <= DEFAULT_CONFIG.radius);
  assert.ok(first.arms.baseline.result.pathLength > 0);
  assert.ok(first.arms.baseline.result.timeToTarget > 0);
});

test('stationary challenge follows the authoritative frozen-gain equations exactly', () => {
  const exp = createChallenge();
  const reference = makeRollout({protocol: 'reach', target: {...DEFAULT_CONFIG.target}, initial: {x: .5, y: .8, heading: -Math.PI / 2}, intensity: .85}, BASE_WEIGHTS);
  for (let index = 0; index < 150; index++) {stepChallenge(exp); tickRollout(reference); assert.deepEqual(exp.arms.baseline.state, reference.state);}
  assert.equal(exp.arms.baseline.pathLength, reference.pathLength);
});

test('moving and switching stimuli are common to both arms and contacts use the configured radius', () => {
  for (const motion of ['sweep', 'switch']) {
    const exp = createChallenge(config({motion}), [1, .7, 1.5, .2, .15, 1]);
    assert.deepEqual(exp.target, DEFAULT_CONFIG.target);
    while (!exp.finished) {
      stepChallenge(exp);
      assert.deepEqual(exp.arms.baseline.state.target, exp.arms.learned.state.target);
      assert.ok(exp.target.x >= .1 - 1e-12 && exp.target.x <= .9 + 1e-12);
      for (const arm of Object.values(exp.arms)) if (arm.result?.reached) assert.ok(arm.result.finalDistance <= exp.config.radius + 1e-12);
    }
    if (motion === 'switch') {
      assert.equal(exp.target.x, 1 - DEFAULT_CONFIG.target.x);
      assert.ok(Object.values(exp.arms).every(arm => !arm.reached || arm.result.timeToTarget > 4));
    }
  }
});

test('occlusion and restoration apply to both retinal inputs at the declared times', () => {
  const exp = createChallenge(config({occlusion: {enabled: true, at: 2, duration: 2}}));
  advance(exp, 2); assert.equal(exp.arms.baseline.hidden, false);
  stepChallenge(exp);
  for (const arm of Object.values(exp.arms)) {assert.equal(arm.hidden, true); assert.equal(arm.state.features.left + arm.state.features.right, 0);}
  advance(exp, 2);
  for (const arm of Object.values(exp.arms)) assert.equal(arm.hidden, false);
  assert.deepEqual(exp.events.filter(event => event.kind === 'stimulus').map(event => [event.action, event.modelTime]), [['hide', 2], ['restore', 4]]);
});

test('no contact is awarded before switching even with a nearby target', () => {
  const exp = createChallenge(config({motion: 'switch', target: {x: .5, y: .69}}));
  advance(exp, 4);
  assert.equal(exp.arms.baseline.reached, false);
  assert.equal(exp.finished, false);
});

test('configuration is strict and experiment config/gains are frozen independent copies', () => {
  for (const invalid of [config({contrast: NaN}), config({radius: .1}), config({speed: 0}), config({target: {x: .5, y: .8}}), config({motion: 'teleport'}), config({duration: 60}), {...config({}), html: '<script>'}]) assert.throws(() => validateConfig(invalid));
  assert.throws(() => createChallenge(DEFAULT_CONFIG, [0, 0, 0, 0, 0, 0]));
  const original = config({}), weights = [...BASE_WEIGHTS], exp = createChallenge(original, weights);
  original.target.x = .2; weights[0] = 1;
  assert.equal(exp.config.target.x, .68); assert.equal(exp.weights[0], BASE_WEIGHTS[0]);
  assert.equal(Object.isFrozen(exp.config.target), true); assert.equal(Object.isFrozen(exp.weights), true);
  for (const preset of PRESETS) assert.doesNotThrow(() => validateConfig(preset.config));
});

test('sharing preserves exact gains/config/provenance and yields the same result', () => {
  const input = {config: config({motion: 'sweep'}), weights: [1.1, .65, 1.3, .25, .12, .8], provenance: {generation: 148, championGeneration: 140, source: 'https://learning.zebraneural.com/api/checkpoint', label: 'Saved parameters', learnerHash: 'a'.repeat(64)}};
  const encoded = encodeChallenge(input), decoded = decodeChallenge(encoded);
  assert.ok(encoded.length <= 5000);
  assert.deepEqual(decoded, {version: 1, ...input});
  assert.deepEqual(runChallenge(decoded.config, decoded.weights), runChallenge(input.config, input.weights));
  assert.deepEqual(decodeChallenge(encodeChallenge({config: DEFAULT_CONFIG, weights: BASE_WEIGHTS})).weights, BASE_WEIGHTS);
});

test('malformed or oversized share links and executable metadata are rejected', () => {
  for (const value of ['', '!', 'A', 'a'.repeat(5001)]) assert.throws(() => decodeChallenge(value));
  const raw = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  for (const value of [{version: 2, config: DEFAULT_CONFIG, weights: BASE_WEIGHTS}, {version: 1, config: DEFAULT_CONFIG, weights: BASE_WEIGHTS, extra: true}, {version: 1, config: DEFAULT_CONFIG, weights: BASE_WEIGHTS, provenance: {label: '<img onerror=alert(1)>'}}, {version: 1, config: DEFAULT_CONFIG, weights: BASE_WEIGHTS, provenance: {source: 'javascript:alert(1)'}}]) assert.throws(() => decodeChallenge(raw(value)));
  assert.throws(() => encodeChallenge({config: DEFAULT_CONFIG, weights: BASE_WEIGHTS, provenance: {callback: 'anything'}}));
});
