import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_WEIGHTS, PARAMS, scenarioSet } from './core.js';
import {
  createTrainer, trainGeneration, evaluateWeights, evaluateFinal,
  exportCheckpoint, importCheckpoint,
} from './trainer.js';

const SMALL = Object.freeze({ seed: 20260911, generations: 3, pairs: 2,
  trainCount: 4, validationCount: 3, testCount: 3 });
const copy = value => JSON.parse(JSON.stringify(value));

test('a real antithetic generation updates bounded coefficients and counts every episode', () => {
  const trainer = createTrainer(SMALL);
  const progress = trainGeneration(trainer);
  assert.equal(progress.generation, 1);
  assert.ok(progress.gradientNorm > 0);
  assert.notDeepEqual(trainer.weights, BASE_WEIGHTS);
  trainer.weights.forEach((value, i) => assert.ok(value >= PARAMS[i].min && value <= PARAMS[i].max));
  assert.deepEqual(trainer.counters, {
    trainRollouts: 24, validationRollouts: 6, testRollouts: 0,
    candidateEvaluations: 4, testEvaluations: 0, totalEpisodes: 30,
  });
  // Selection may retain baseline or improve. An ES update is not a promise
  // of monotonic improvement, and the test intentionally makes no such claim.
  assert.ok(trainer.bestValidation.meanReward >= trainer.baselineValidation.meanReward);
  assert.deepEqual(trainer.lastTrain, evaluateWeights(trainer.weights, scenarioSet('train', SMALL.seed, 4)));
});

test('a JSON checkpoint resumes weights, optimizer, random stream, history and budgets exactly', () => {
  const uninterrupted = createTrainer(SMALL);
  trainGeneration(uninterrupted);
  const restored = importCheckpoint(JSON.parse(JSON.stringify(exportCheckpoint(uninterrupted))));
  assert.notEqual(restored.weights, uninterrupted.weights);
  while (uninterrupted.generation < SMALL.generations) trainGeneration(uninterrupted);
  while (restored.generation < SMALL.generations) trainGeneration(restored);
  assert.deepEqual(exportCheckpoint(restored), exportCheckpoint(uninterrupted));
  assert.throws(() => trainGeneration(restored), /budget is complete/);
});

test('test partition configuration has no effect on training or checkpoint selection', () => {
  const first = createTrainer({ ...SMALL, generations: 1, testCount: 1 });
  const second = createTrainer({ ...SMALL, generations: 1, testCount: 64 });
  trainGeneration(first); trainGeneration(second);
  for (const key of ['weights', 'bestWeights', 'history', 'bestGeneration', 'counters', 'rngState']) assert.deepEqual(first[key], second[key]);
  assert.equal(first.counters.testRollouts, 0);
  assert.equal(second.counters.testRollouts, 0);
  assert.equal(first.lastTest, null);
  assert.equal(first.evaluated, false);
});

test('explicit holdout evaluation compares fixed baseline, selected and current weights, then seals the run', () => {
  const trainer = createTrainer(SMALL);
  trainGeneration(trainer);
  const selected = [...trainer.bestWeights];
  const result = evaluateFinal(trainer);
  assert.equal(trainer.evaluated, true);
  assert.deepEqual(result.baseline, evaluateWeights(BASE_WEIGHTS, scenarioSet('test', SMALL.seed, 3)));
  assert.deepEqual(result.best, evaluateWeights(selected, scenarioSet('test', SMALL.seed, 3)));
  assert.deepEqual(trainer.bestWeights, selected);
  assert.equal(trainer.counters.testRollouts, 9);
  assert.equal(trainer.counters.testEvaluations, 1);
  const counters = copy(trainer.counters);
  assert.deepEqual(evaluateFinal(trainer), result);
  assert.deepEqual(trainer.counters, counters);
  assert.throws(() => trainGeneration(trainer), /held-out test set/);
  const restored = importCheckpoint(exportCheckpoint(trainer));
  assert.throws(() => trainGeneration(restored), /held-out test set/);
});

test('strict import rejects malformed versions, options, optimizer, random state, metrics and selection', () => {
  const trainer = createTrainer(SMALL);
  trainGeneration(trainer);
  const checkpoint = exportCheckpoint(trainer);
  const corruptions = [
    s => { s.version = 9; },
    s => { s.trainerVersion = 'unknown'; },
    s => { s.modelVersion = 'unknown'; },
    s => { s.taskVersion = 'unknown'; },
    s => { s.rewardVersion = 'unknown'; },
    s => { s.config.unknown = true; },
    s => { s.config.seed = -1; },
    s => { s.config.seed += 1; },
    s => { s.config.pairs = 2.5; },
    s => { s.config.sigma = Infinity; },
    s => { s.weights[0] = NaN; },
    s => { s.weights[0] = PARAMS[0].max + 1; },
    s => { s.weights.pop(); },
    s => { s.rngState = 0; },
    s => { s.rngState = 42; },
    s => { s.optimizer.step += 1; },
    s => { s.optimizer.v[0] = -0.1; },
    s => { s.optimizer.m[0] = Infinity; },
    s => { s.optimizer.m.pop(); },
    s => { s.optimizer.beta1 = 0.9; },
    s => { s.counters.totalEpisodes += 1; },
    s => { s.counters.testRollouts = 1; },
    s => { s.lastValidation.successRate = -0.1; },
    s => { s.lastValidation.meanReward += 0.1; },
    s => { s.bestGeneration = 99; },
    s => { s.bestWeights[0] = PARAMS[0].min; },
    s => { s.history[0].improved = !s.history[0].improved; },
    s => { s.history[0].bestValidationScore += 0.1; },
    s => { s.history.pop(); },
    s => { s.lastTest = {}; },
    s => { s.evaluated = 'false'; },
    s => { s.extra = 1; },
  ];
  for (const corrupt of corruptions) {
    const modified = copy(checkpoint);
    corrupt(modified);
    assert.throws(() => importCheckpoint(modified), /Invalid learning state/, corrupt.toString());
  }
});

test('config is explicit, reproducible including seed zero, and does not accept unknown options', () => {
  for (const options of [null, [], { pairs: 0 }, { generations: 0 }, { seed: 0x100000000 }, { trainCount: 65 }, { mystery: 1 }, { learningRate: -1 }]) {
    assert.throws(() => createTrainer(options), /Invalid learning state/);
  }
  const zero = createTrainer({ ...SMALL, seed: 0, generations: 1, pairs: 1, trainCount: 1, validationCount: 1 });
  const again = createTrainer({ ...SMALL, seed: 0, generations: 1, pairs: 1, trainCount: 1, validationCount: 1 });
  trainGeneration(zero); trainGeneration(again);
  assert.deepEqual(exportCheckpoint(zero), exportCheckpoint(again));
  const pristine = createTrainer({ ...SMALL, generations: 1, trainCount: 1, validationCount: 1 });
  assert.deepEqual(importCheckpoint(exportCheckpoint(pristine)), pristine);
});
