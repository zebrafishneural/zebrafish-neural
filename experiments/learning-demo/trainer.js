import {
  BASE_WEIGHTS, PARAMS, MODEL_VERSION, TASK_VERSION, REWARD_VERSION,
  scenarioSet, runTrial,
} from './core.js';

export const TRAINER_VERSION = 'bounded-antithetic-es-adam-v1';
export const DEFAULT_CONFIG = Object.freeze({
  seed: 20260911, generations: 12, pairs: 4,
  trainCount: 6, validationCount: 6, testCount: 8,
  sigma: 0.08, learningRate: 0.025,
});

const KIND = 'zebrafish-learning-checkpoint';
const VERSION = 1;
const METRIC_KEYS = ['episodes', 'successes', 'successRate', 'meanReward', 'meanTimeCost', 'meanPathLength', 'meanDuration'];
const COUNTER_KEYS = ['trainRollouts', 'validationRollouts', 'testRollouts', 'candidateEvaluations', 'testEvaluations', 'totalEpisodes'];
const STATE_KEYS = ['kind', 'version', 'trainerVersion', 'modelVersion', 'taskVersion', 'rewardVersion',
  'config', 'generation', 'weights', 'bestWeights', 'bestGeneration', 'bestValidation',
  'baselineTrain', 'baselineValidation', 'lastTrain', 'lastValidation', 'history',
  'optimizer', 'rngState', 'counters', 'evaluated', 'lastTest'];
const ROW_KEYS = ['generation', 'train', 'validation', 'bestValidationScore', 'improved', 'weights', 'candidateMeanReward', 'gradientNorm'];
const clone = value => JSON.parse(JSON.stringify(value));
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function fail(message) { throw new TypeError(`Invalid learning state: ${message}`); }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(`${label} has missing or unknown fields`);
}
function finite(value, low, high, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) fail(`${label} is outside its numeric bounds`);
}
function integer(value, low, high, label) {
  finite(value, low, high, label);
  if (!Number.isSafeInteger(value)) fail(`${label} must be an integer`);
}
function weightsValid(weights, label = 'weights') {
  if (!Array.isArray(weights) || weights.length !== PARAMS.length) fail(`${label} must have ${PARAMS.length} entries`);
  weights.forEach((value, i) => finite(value, PARAMS[i].min, PARAMS[i].max, `${label}[${i}]`));
}
function configValid(config) {
  exactKeys(config, Object.keys(DEFAULT_CONFIG), 'config');
  integer(config.seed, 0, 0xffffffff, 'seed');
  integer(config.generations, 1, 200, 'generations');
  integer(config.pairs, 1, 32, 'pairs');
  for (const key of ['trainCount', 'validationCount', 'testCount']) integer(config[key], 1, 64, key);
  finite(config.sigma, 0.001, 0.5, 'sigma');
  finite(config.learningRate, 0.0001, 0.25, 'learningRate');
}
function metricsValid(metrics, episodes, label) {
  exactKeys(metrics, METRIC_KEYS, label);
  integer(metrics.episodes, episodes, episodes, `${label}.episodes`);
  integer(metrics.successes, 0, episodes, `${label}.successes`);
  finite(metrics.successRate, 0, 1, `${label}.successRate`);
  if (metrics.successRate !== metrics.successes / episodes) fail(`${label}.successRate does not match successes`);
  finite(metrics.meanReward, -100, 100, `${label}.meanReward`);
  for (const key of ['meanTimeCost', 'meanPathLength', 'meanDuration']) finite(metrics[key], 0, 1e6, `${label}.${key}`);
}
function sameArray(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }
function sameMetrics(a, b) { return METRIC_KEYS.every(key => a[key] === b[key]); }

// xorshift32 and Box-Muller have no hidden spare sample: rngState is sufficient
// to resume the next generation exactly, including seed zero.
function uniform(trainer) {
  let x = trainer.rngState >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  trainer.rngState = x >>> 0;
  return (trainer.rngState + 0.5) / 4294967296;
}
function normal(trainer) {
  return Math.sqrt(-2 * Math.log(uniform(trainer))) * Math.cos(2 * Math.PI * uniform(trainer));
}
function normalized(weights) {
  return weights.map((value, i) => (value - PARAMS[i].min) / (PARAMS[i].max - PARAMS[i].min));
}
function physical(weights) {
  return weights.map((value, i) => PARAMS[i].min + clamp(value, 0, 1) * (PARAMS[i].max - PARAMS[i].min));
}
function scenarios(trainer, split) {
  const count = trainer.config[`${split}Count`];
  return scenarioSet(split, trainer.config.seed, count);
}

/** Pure evaluation. Every runTrial call begins a fresh rollout in core.js. */
export function evaluateWeights(weights, cases) {
  weightsValid(weights);
  if (!Array.isArray(cases) || !cases.length || cases.length > 10000) fail('evaluation requires a nonempty scenario array');
  let successes = 0, reward = 0, timeCost = 0, pathLength = 0, duration = 0;
  for (const scenario of cases) {
    const result = runTrial(scenario, weights, { record: false });
    if (typeof result.reached !== 'boolean') fail('trial reached must be boolean');
    finite(result.reward, -100, 100, 'trial reward');
    for (const key of ['timeCost', 'pathLength', 'duration']) finite(result[key], 0, 1e6, `trial ${key}`);
    successes += Number(result.reached);
    reward += result.reward; timeCost += result.timeCost;
    pathLength += result.pathLength; duration += result.duration;
  }
  const episodes = cases.length;
  return { episodes, successes, successRate: successes / episodes,
    meanReward: reward / episodes, meanTimeCost: timeCost / episodes,
    meanPathLength: pathLength / episodes, meanDuration: duration / episodes };
}
function countedEvaluation(trainer, weights, split, cases = scenarios(trainer, split)) {
  const metrics = evaluateWeights(weights, cases);
  trainer.counters[`${split}Rollouts`] += metrics.episodes;
  trainer.counters.totalEpisodes += metrics.episodes;
  return metrics;
}

export function createTrainer(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options must be an object');
  for (const key of Object.keys(options)) if (!(key in DEFAULT_CONFIG)) fail(`unknown option ${key}`);
  const config = { ...DEFAULT_CONFIG, ...options };
  configValid(config);
  weightsValid(BASE_WEIGHTS, 'BASE_WEIGHTS');
  const trainer = {
    kind: KIND, version: VERSION, trainerVersion: TRAINER_VERSION,
    modelVersion: MODEL_VERSION, taskVersion: TASK_VERSION, rewardVersion: REWARD_VERSION,
    config, generation: 0, weights: [...BASE_WEIGHTS], bestWeights: [...BASE_WEIGHTS],
    bestGeneration: 0, bestValidation: null, baselineTrain: null, baselineValidation: null,
    lastTrain: null, lastValidation: null, history: [],
    optimizer: { step: 0, m: PARAMS.map(() => 0), v: PARAMS.map(() => 0) },
    rngState: ((config.seed ^ 0x9e3779b9) >>> 0) || 0x6d2b79f5,
    counters: { trainRollouts: 0, validationRollouts: 0, testRollouts: 0,
      candidateEvaluations: 0, testEvaluations: 0, totalEpisodes: 0 },
    evaluated: false, lastTest: null,
  };
  trainer.baselineTrain = countedEvaluation(trainer, BASE_WEIGHTS, 'train');
  trainer.baselineValidation = countedEvaluation(trainer, BASE_WEIGHTS, 'validation');
  trainer.lastTrain = clone(trainer.baselineTrain);
  trainer.lastValidation = clone(trainer.baselineValidation);
  trainer.bestValidation = clone(trainer.baselineValidation);
  return trainer;
}

/** One deterministic generation. Test cases are never created in this path. */
export function trainGeneration(trainer) {
  if (trainer.evaluated) throw new Error('This run has accessed its held-out test set. Start a new run to train again.');
  if (trainer.generation >= trainer.config.generations) throw new Error('The configured generation budget is complete.');
  const { pairs, sigma, learningRate } = trainer.config;
  const cases = scenarios(trainer, 'train');
  const x = normalized(trainer.weights);
  const gradient = PARAMS.map(() => 0);
  let candidateReward = 0;
  for (let pair = 0; pair < pairs; pair++) {
    const epsilon = PARAMS.map(() => normal(trainer));
    const plus = physical(x.map((value, i) => value + sigma * epsilon[i]));
    const minus = physical(x.map((value, i) => value - sigma * epsilon[i]));
    const positive = countedEvaluation(trainer, plus, 'train', cases);
    const negative = countedEvaluation(trainer, minus, 'train', cases);
    const difference = positive.meanReward - negative.meanReward;
    epsilon.forEach((value, i) => { gradient[i] += difference * value / (2 * pairs * sigma); });
    candidateReward += positive.meanReward + negative.meanReward;
    trainer.counters.candidateEvaluations += 2;
  }
  const optimizer = trainer.optimizer;
  optimizer.step += 1;
  const proposed = x.map((value, i) => {
    optimizer.m[i] = 0.9 * optimizer.m[i] + 0.1 * gradient[i];
    optimizer.v[i] = 0.999 * optimizer.v[i] + 0.001 * gradient[i] ** 2;
    const mHat = optimizer.m[i] / (1 - 0.9 ** optimizer.step);
    const vHat = optimizer.v[i] / (1 - 0.999 ** optimizer.step);
    return clamp(value + learningRate * mHat / (Math.sqrt(vHat) + 1e-8), 0, 1);
  });
  trainer.weights = physical(proposed);
  trainer.generation += 1;
  trainer.lastTrain = countedEvaluation(trainer, trainer.weights, 'train', cases);
  trainer.lastValidation = countedEvaluation(trainer, trainer.weights, 'validation');
  const improved = trainer.lastValidation.meanReward > trainer.bestValidation.meanReward;
  if (improved) {
    trainer.bestWeights = [...trainer.weights];
    trainer.bestGeneration = trainer.generation;
    trainer.bestValidation = clone(trainer.lastValidation);
  }
  const row = { generation: trainer.generation,
    train: clone(trainer.lastTrain), validation: clone(trainer.lastValidation),
    bestValidationScore: trainer.bestValidation.meanReward, improved,
    weights: [...trainer.weights], candidateMeanReward: candidateReward / (2 * pairs),
    gradientNorm: Math.hypot(...gradient) };
  trainer.history.push(row);
  return clone(row);
}

/** Explicit final holdout access seals the run, even when requested early. */
export function evaluateFinal(trainer) {
  if (trainer.evaluated) return clone(trainer.lastTest);
  const cases = scenarios(trainer, 'test');
  trainer.lastTest = {
    generation: trainer.generation,
    baseline: countedEvaluation(trainer, BASE_WEIGHTS, 'test', cases),
    best: countedEvaluation(trainer, trainer.bestWeights, 'test', cases),
    current: countedEvaluation(trainer, trainer.weights, 'test', cases),
  };
  trainer.counters.testEvaluations += 1;
  trainer.evaluated = true;
  return clone(trainer.lastTest);
}

function validateState(state) {
  exactKeys(state, STATE_KEYS, 'checkpoint');
  if (state.kind !== KIND || state.version !== VERSION || state.trainerVersion !== TRAINER_VERSION ||
      state.modelVersion !== MODEL_VERSION || state.taskVersion !== TASK_VERSION || state.rewardVersion !== REWARD_VERSION) fail('checkpoint versions do not match this experiment');
  configValid(state.config);
  const c = state.config;
  integer(state.generation, 0, c.generations, 'generation');
  integer(state.bestGeneration, 0, state.generation, 'bestGeneration');
  weightsValid(state.weights); weightsValid(state.bestWeights, 'bestWeights');
  integer(state.rngState, 1, 0xffffffff, 'rngState');
  const expectedRng = { rngState: ((c.seed ^ 0x9e3779b9) >>> 0) || 0x6d2b79f5 };
  const draws = state.generation * c.pairs * PARAMS.length * 2;
  for (let i = 0; i < draws; i++) uniform(expectedRng);
  if (state.rngState !== expectedRng.rngState) fail('rngState does not match the seed and generation budget');
  for (const key of ['baselineTrain', 'lastTrain']) metricsValid(state[key], c.trainCount, key);
  for (const key of ['baselineValidation', 'lastValidation', 'bestValidation']) metricsValid(state[key], c.validationCount, key);
  exactKeys(state.optimizer, ['step', 'm', 'v'], 'optimizer');
  integer(state.optimizer.step, state.generation, state.generation, 'optimizer.step');
  for (const key of ['m', 'v']) {
    if (!Array.isArray(state.optimizer[key]) || state.optimizer[key].length !== PARAMS.length) fail(`optimizer.${key} shape`);
    state.optimizer[key].forEach((value, i) => finite(value, key === 'v' ? 0 : -1e8, 1e8, `optimizer.${key}[${i}]`));
  }
  if (typeof state.evaluated !== 'boolean') fail('evaluated must be boolean');
  if (state.evaluated) {
    exactKeys(state.lastTest, ['generation', 'baseline', 'best', 'current'], 'lastTest');
    integer(state.lastTest.generation, state.generation, state.generation, 'lastTest.generation');
    for (const key of ['baseline', 'best', 'current']) metricsValid(state.lastTest[key], c.testCount, `lastTest.${key}`);
  } else if (state.lastTest !== null) fail('unevaluated runs cannot contain test results');
  exactKeys(state.counters, COUNTER_KEYS, 'counters');
  const expectedCounters = {
    trainRollouts: c.trainCount * (1 + state.generation * (2 * c.pairs + 1)),
    validationRollouts: c.validationCount * (1 + state.generation),
    testRollouts: state.evaluated ? 3 * c.testCount : 0,
    candidateEvaluations: 2 * c.pairs * state.generation,
    testEvaluations: Number(state.evaluated),
  };
  expectedCounters.totalEpisodes = expectedCounters.trainRollouts + expectedCounters.validationRollouts + expectedCounters.testRollouts;
  for (const key of COUNTER_KEYS) integer(state.counters[key], expectedCounters[key], expectedCounters[key], `counters.${key}`);
  if (!Array.isArray(state.history) || state.history.length !== state.generation) fail('history must contain every generation');
  let best = state.baselineValidation, bestWeights = BASE_WEIGHTS, bestGeneration = 0;
  state.history.forEach((row, i) => {
    exactKeys(row, ROW_KEYS, `history[${i}]`);
    integer(row.generation, i + 1, i + 1, 'history generation');
    weightsValid(row.weights, 'history weights');
    metricsValid(row.train, c.trainCount, 'history train');
    metricsValid(row.validation, c.validationCount, 'history validation');
    finite(row.candidateMeanReward, -100, 100, 'candidateMeanReward');
    finite(row.gradientNorm, 0, 1e8, 'gradientNorm');
    const improved = row.validation.meanReward > best.meanReward;
    if (row.improved !== improved) fail('history selection flag is inconsistent');
    if (improved) { best = row.validation; bestWeights = row.weights; bestGeneration = i + 1; }
    if (row.bestValidationScore !== best.meanReward) fail('history best score is inconsistent');
  });
  if (state.bestGeneration !== bestGeneration || !sameMetrics(state.bestValidation, best) || !sameArray(state.bestWeights, bestWeights)) fail('best checkpoint must be selected only by validation reward');
  const latest = state.history.at(-1);
  if (!sameArray(state.weights, latest ? latest.weights : BASE_WEIGHTS) ||
      !sameMetrics(state.lastTrain, latest ? latest.train : state.baselineTrain) ||
      !sameMetrics(state.lastValidation, latest ? latest.validation : state.baselineValidation)) fail('current state does not match history');
  if (state.generation === 0 && (state.optimizer.m.some(value => value !== 0) || state.optimizer.v.some(value => value !== 0))) fail('initial optimizer state must be zero');
}

export function exportCheckpoint(trainer) {
  validateState(trainer);
  return clone(trainer);
}

/** Import never evaluates scenarios or accesses held-out data. */
export function importCheckpoint(checkpoint) {
  validateState(checkpoint);
  return clone(checkpoint);
}
