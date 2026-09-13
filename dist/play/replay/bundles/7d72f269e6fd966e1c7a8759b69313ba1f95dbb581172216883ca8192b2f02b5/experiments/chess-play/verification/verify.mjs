import {Chess} from '../../chess/public/lib/chess.js';
import {BASE_WEIGHTS, MODEL_VERSION, SELECTOR_VERSION, decisionSteps} from '../../chess/lib/selector.mjs';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_SAMPLES = 6000;
export const NUMERIC_TOLERANCE = 1e-12;
export const VERIFICATION_SCOPE = 'Deterministic record consistency, not server or hardware attestation. Game identity, move number and seed provenance are not authenticated.';
const TOP_KEYS = ['fen', 'selectedUci', 'selectedSan', 'seed', 'weights', 'mode', 'modelVersion', 'selectorVersion',
  'featureDefinitions', 'candidates', 'comparisons', 'comparisonCount', 'modelSteps', 'modelDuration', 'control', 'protocol',
  'gameId', 'ply', 'actor', 'fenBefore', 'fenAfter', 'samples', 'weightsHash'];
const encoder = new TextEncoder();
const uint32 = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysEqual = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const brief = value => typeof value === 'string' ? value.slice(0, 120) : Array.isArray(value) ? `[array(${value.length})]` : isObject(value) ? '[object]' : value === undefined ? '[missing]' : value;
const sha256 = async text => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(text))), byte => byte.toString(16).padStart(2, '0')).join('');
const moveObject = uci => ({from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? {promotion: uci[4]} : {})});

// Only JSON data is accepted. Reject accessors, exotic objects, dangerous keys,
// non-finite numbers and excessive nesting before serializing or replaying.
function assertJSON(value) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > 400000 || depth > 20) throw Error('Record exceeds the structural limits.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'string') { if (item.length > MAX_INPUT_BYTES) throw Error('Record string is too long.'); return; }
    if (typeof item === 'number') { if (!Number.isFinite(item)) throw Error('Record contains a non-finite number.'); return; }
    if (typeof item !== 'object') throw Error('Record must contain JSON values only.');
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw Error('Record contains an unsupported object.');
    if (array && (prototype !== Array.prototype || item.length > MAX_SAMPLES)) throw Error('Record array exceeds the supported limits.');
    if (ancestors.has(item)) throw Error('Record contains a cycle.');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('Record contains an unsupported key.');
      if (array && key === 'length') continue;
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) throw Error('Record array has unexpected properties.');
      const descriptor = descriptors[key];
      if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw Error('Record must contain ordinary JSON properties.');
      visit(descriptor.value, depth + 1);
    }
    if (array && Object.keys(item).length !== item.length) throw Error('Record contains a sparse array.');
    ancestors.delete(item);
  }
  visit(value, 0);
}

/**
 * Replay an unmodified full decision JSON (or its explicit hashed store wrapper).
 * Every selector field and every stored sample field is compared. Retina is not
 * stored by PlayRuntime and is reconstructed, then excluded from sample comparison.
 * gameId/ply are shape-checked only; no timestamp, identity or server provenance is
 * inferred. There are no silently ignored extension fields. Floating-point replay
 * fields use absolute tolerance 1e-12; frozen weights and version strings are exact.
 */
export async function verifyDecision(input, {onProgress} = {}) {
  const result = {status: 'invalid', ok: false, reason: '', scope: VERIFICATION_SCOPE, numericTolerance: NUMERIC_TOLERANCE,
    checks: [], computed: null, recorded: null, mismatches: [], metadataScope: ['gameId', 'ply', 'seed provenance']};
  let mismatchCount = 0;
  const mismatch = (path, expected, actual) => {
    mismatchCount++;
    if (result.mismatches.length < 20) result.mismatches.push({path, expected: brief(expected), actual: brief(actual)});
  };
  function compare(actual, expected, path) {
    if (typeof expected === 'number') {
      if (typeof actual !== 'number' || Math.abs(actual - expected) > NUMERIC_TOLERANCE) mismatch(path, expected, actual);
      return;
    }
    if (expected === null || typeof expected !== 'object') { if (actual !== expected) mismatch(path, expected, actual); return; }
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) { mismatch(path, expected, actual); return; }
      if (actual.length !== expected.length) mismatch(`${path}.length`, expected.length, actual.length);
      for (let index = 0; index < Math.min(actual.length, expected.length); index++) compare(actual[index], expected[index], `${path}[${index}]`);
      return;
    }
    if (!isObject(actual)) { mismatch(path, expected, actual); return; }
    for (const key of Object.keys(expected)) {
      if (!Object.hasOwn(actual, key)) mismatch(`${path}.${key}`, expected[key], undefined);
      else compare(actual[key], expected[key], `${path}.${key}`);
    }
    for (const key of Object.keys(actual)) if (!Object.hasOwn(expected, key)) mismatch(`${path}.${key}`, '[no extra field]', actual[key]);
  }
  const check = (id, label, operation) => {
    const before = mismatchCount; operation();
    result.checks.push({id, label, passed: mismatchCount === before});
  };
  try {
    if (typeof input === 'string') {
      if (encoder.encode(input).byteLength > MAX_INPUT_BYTES) throw Error('Decision JSON exceeds the 8 MiB limit.');
      try { input = JSON.parse(input); } catch { throw Error('Decision file is not valid JSON.'); }
    }
    assertJSON(input);
    if (encoder.encode(JSON.stringify(input)).byteLength > MAX_INPUT_BYTES) throw Error('Decision JSON exceeds the 8 MiB limit.');
    let record = input;
    if (isObject(input) && Object.hasOwn(input, 'payload')) {
      if (!keysEqual(input, ['schemaVersion', 'sha256', 'payload']) || input.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(input.sha256)) throw Error('Unsupported decision storage wrapper.');
      const wrapperHash = await sha256(JSON.stringify(input.payload));
      check('wrapper', 'Stored payload hash', () => compare(input.sha256, wrapperHash, 'wrapper.sha256'));
      record = input.payload;
    }
    if (!keysEqual(record, TOP_KEYS)) throw Error('Expected a complete private-game decision record with no extra fields.');
    if (record.mode !== 'neural') throw Error('Only the declared neural selector mode is supported.');
    if (record.modelVersion !== MODEL_VERSION || record.selectorVersion !== SELECTOR_VERSION) throw Error('Unsupported model or selector version. Use the source revision matching this record.');
    if (record.actor !== 'fish' || !/^play_[a-f0-9]{32}$/.test(record.gameId) || !Number.isInteger(record.ply) || record.ply < 1 || record.ply > 300) throw Error('Invalid fish-game record identity fields.');
    if (!uint32(record.seed)) throw Error('Decision seed must be an unsigned 32-bit integer.');
    if (!Array.isArray(record.weights) || record.weights.length !== BASE_WEIGHTS.length || !record.weights.every((value, index) => value === BASE_WEIGHTS[index])) throw Error('This verifier requires the exact six original frozen controller gains.');
    if (typeof record.weightsHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.weightsHash)) throw Error('A lowercase SHA-256 weights hash is required.');
    if (!['fen', 'fenBefore', 'fenAfter'].every(key => typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 200)) throw Error('Before and after FEN strings are required.');
    if (typeof record.selectedUci !== 'string' || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(record.selectedUci) || typeof record.selectedSan !== 'string' || record.selectedSan.length > 20) throw Error('A committed selected move is required.');
    if (!Array.isArray(record.samples) || record.samples.length > MAX_SAMPLES || !Array.isArray(record.candidates) || record.candidates.length < 1 || record.candidates.length > 218 || !Array.isArray(record.comparisons)) throw Error('Decision arrays are missing or outside the supported bounds.');
    if (!Number.isInteger(record.comparisonCount) || record.comparisonCount < 0 || record.comparisonCount > 217 || !Number.isInteger(record.modelSteps) || record.modelSteps < 0 || record.modelSteps > 12000 || typeof record.modelDuration !== 'number') throw Error('Invalid model step or comparison counters.');
    let beforeBoard;
    try { beforeBoard = new Chess(record.fenBefore); new Chess(record.fenAfter); } catch { throw Error('Decision contains an invalid chess position.'); }
    result.checks.push({id: 'schema', label: 'Complete record, supported versions and frozen gains', passed: true});
    const weightsHash = await sha256(JSON.stringify(BASE_WEIGHTS));
    check('weights-hash', 'SHA-256 of the exact frozen gains', () => compare(record.weightsHash, weightsHash, 'weightsHash'));
    check('position', 'Canonical starting position', () => {
      compare(record.fenBefore, beforeBoard.fen(), 'fenBefore'); compare(record.fen, beforeBoard.fen(), 'fen');
    });
    const generator = decisionSteps(record.fenBefore, {seed: record.seed, weights: BASE_WEIGHTS, mode: 'neural'});
    const replaySamples = []; let replay;
    for (;;) {
      const next = generator.next();
      if (next.done) { replay = next.value; break; }
      if (replaySamples.length >= MAX_SAMPLES) throw Error('Replayed decision exceeds the 6000-sample limit.');
      const {retina, ...sample} = next.value; replaySamples.push(sample);
      if (typeof onProgress === 'function' && replaySamples.length % 240 === 0) onProgress({samples: replaySamples.length, limit: MAX_SAMPLES});
    }
    if (!replay.selectedUci) throw Error('Starting position has no legal move to verify.');
    const computedBoard = new Chess(record.fenBefore), computedMove = computedBoard.move(moveObject(replay.selectedUci));
    result.computed = {selectedUci: replay.selectedUci, selectedSan: computedMove.san, fenAfter: computedBoard.fen(), modelSteps: replay.modelSteps,
      candidateCount: replay.candidates.length, forcedMove: replay.candidates.length === 1,
      comparisonCount: replay.comparisonCount, sampleCount: replaySamples.length, weightsHash};
    result.recorded = {selectedUci: record.selectedUci, selectedSan: record.selectedSan, fenAfter: record.fenAfter, modelSteps: record.modelSteps,
      comparisonCount: record.comparisonCount, sampleCount: record.samples.length, weightsHash: record.weightsHash};
    check('protocol', 'Model version, seed and complete decision protocol', () => {
      for (const key of ['fen', 'seed', 'weights', 'mode', 'modelVersion', 'selectorVersion', 'featureDefinitions', 'protocol', 'control']) compare(record[key], replay[key], key);
    });
    check('candidates', 'Every legal move and its four recomputed features', () => compare(record.candidates, replay.candidates, 'candidates'));
    check('comparisons', 'Every pair, motor integral and seeded tie-break', () => {
      compare(record.comparisonCount, replay.comparisonCount, 'comparisonCount'); compare(record.comparisons, replay.comparisons, 'comparisons');
    });
    check('samples', 'All eight-state samples, inputs, timings and pair identities', () => {
      compare(record.modelSteps, replay.modelSteps, 'modelSteps'); compare(record.modelDuration, replay.modelDuration, 'modelDuration');
      compare(record.samples, replaySamples, 'samples');
    });
    check('move', 'Chosen move, SAN and exact resulting FEN', () => {
      compare(record.selectedUci, replay.selectedUci, 'selectedUci'); compare(record.selectedSan, replay.selectedSan, 'selectedSan');
      compare(record.fenAfter, computedBoard.fen(), 'fenAfter');
      try {
        const recordedBoard = new Chess(record.fenBefore), move = recordedBoard.move(moveObject(record.selectedUci));
        compare(record.selectedSan, move.san, 'selectedSan.legality'); compare(record.fenAfter, recordedBoard.fen(), 'fenAfter.legality');
      } catch { mismatch('selectedUci.legality', 'A legal move in fenBefore', record.selectedUci); }
    });
    result.status = mismatchCount ? 'mismatch' : 'verified'; result.ok = !mismatchCount;
    result.reason = mismatchCount ? `Replay found ${mismatchCount} mismatch${mismatchCount === 1 ? '' : 'es'}; at most 20 details are shown.` : 'All replayed selector fields and neural samples match within the declared numeric tolerance.';
  } catch (failure) {
    result.status = 'invalid'; result.ok = false;
    result.reason = failure instanceof Error ? failure.message.slice(0, 240) : 'Decision could not be verified.';
  }
  return result;
}
