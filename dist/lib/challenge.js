import {makeState, renderRetina, snapshot} from './model.js';
import {parameterStep, BASE_WEIGHTS, PARAMS, MODEL_VERSION, DT} from './learning-core.js';

export {BASE_WEIGHTS, MODEL_VERSION, DT};
export const TASK_VERSION = 'challenge-task-1';
const INITIAL = Object.freeze({x: .5, y: .8, heading: -Math.PI / 2});
const clone = value => JSON.parse(JSON.stringify(value));
const rounded = value => Number(value.toFixed(6));
function freeze(value) {if (value && typeof value === 'object') {Object.values(value).forEach(freeze); Object.freeze(value);} return value;}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new TypeError('Missing or unsupported configuration fields.');
}
function bounded(value, minimum, maximum, name) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}
function weightsChecked(weights) {
  if (!Array.isArray(weights) || weights.length !== 6) throw new TypeError('Exactly six gains are required.');
  return weights.map((value, index) => bounded(value, PARAMS[index].min, PARAMS[index].max, PARAMS[index].id));
}

export const DEFAULT_CONFIG = freeze({version: 1, target: {x: .68, y: .25}, motion: 'still', speed: .6,
  contrast: .85, radius: .065, occlusion: {enabled: false, at: 4, duration: 3}, duration: 30});

export function validateConfig(config = DEFAULT_CONFIG) {
  keys(config, ['version', 'target', 'motion', 'speed', 'contrast', 'radius', 'occlusion', 'duration']);
  keys(config.target, ['x', 'y']); keys(config.occlusion, ['enabled', 'at', 'duration']);
  if (config.version !== 1 || config.duration !== 30) throw new RangeError('This task requires version 1 and a 30-second limit.');
  if (!['still', 'sweep', 'switch'].includes(config.motion)) throw new RangeError('Unsupported target motion.');
  if (typeof config.occlusion.enabled !== 'boolean') throw new TypeError('Occlusion enabled must be boolean.');
  const result = {version: 1, target: {x: bounded(config.target.x, .1, .9, 'Target x'), y: bounded(config.target.y, .1, .85, 'Target y')},
    motion: config.motion, speed: bounded(config.speed, .2, 1.5, 'Motion speed'), contrast: bounded(config.contrast, .15, 1, 'Contrast'),
    radius: bounded(config.radius, .035, .09, 'Contact radius'),
    occlusion: {enabled: config.occlusion.enabled, at: bounded(config.occlusion.at, 2, 12, 'Occlusion start'), duration: bounded(config.occlusion.duration, 1, 8, 'Occlusion duration')}, duration: 30};
  if (Math.hypot(result.target.x - INITIAL.x, result.target.y - INITIAL.y) <= result.radius) throw new RangeError('The target must start outside the contact radius.');
  return result;
}

export const PRESETS = freeze([
  {id: 'still', label: 'First contact', description: 'A visible stationary target.', config: clone(DEFAULT_CONFIG)},
  {id: 'sweep', label: 'Moving target', description: 'A target sweeping horizontally with reflected boundaries.', config: {...clone(DEFAULT_CONFIG), motion: 'sweep', speed: 1}},
  {id: 'switch', label: 'Switch sides', description: 'The target mirrors horizontally at 4 seconds; only later contact counts.', config: {...clone(DEFAULT_CONFIG), motion: 'switch'}},
  {id: 'occlusion', label: 'Lights out', description: 'Input disappears at 4 seconds for 3 seconds.', config: {...clone(DEFAULT_CONFIG), occlusion: {enabled: true, at: 4, duration: 3}}}
]);

function makeArm(target, contrast) {
  const state = makeState({mode: 'light-left', intensity: contrast});
  Object.assign(state.fish, INITIAL); state.target = {...target}; renderRetina(state);
  return {state, path: [{x: INITIAL.x, y: INITIAL.y}], pathLength: 0,
    closestDistance: Math.hypot(INITIAL.x - target.x, INITIAL.y - target.y), reached: false, finished: false, result: null, hidden: false};
}

export function createChallenge(config = DEFAULT_CONFIG, weights = BASE_WEIGHTS) {
  const checked = freeze(validateConfig(config)), gains = freeze(weightsChecked(weights));
  return {config: checked, weights: gains, time: 0, steps: 0, target: {...checked.target}, finished: false, switched: false,
    arms: {baseline: makeArm(checked.target, checked.contrast), learned: makeArm(checked.target, checked.contrast)},
    events: [{modelTime: 0, kind: 'start', text: 'Both controllers receive the same task. All gains remain frozen.'}]};
}

function targetAt(config, time) {
  if (config.motion === 'switch' && time >= 4 - 1e-9) return {x: 1 - config.target.x, y: config.target.y};
  if (config.motion !== 'sweep') return {...config.target};
  // speed is a multiplier of 0.06 arena units/s, not a neural or angular rate.
  const width = .8, phase = (config.target.x - .1 + config.speed * .06 * time) % (2 * width);
  return {x: .1 + (phase <= width ? phase : 2 * width - phase), y: config.target.y};
}

function finish(exp, name, reached) {
  const arm = exp.arms[name]; arm.reached = reached; arm.finished = true;
  arm.result = {reached, success: reached, duration: rounded(arm.state.time), timeToTarget: reached ? rounded(arm.state.time) : null,
    timeCost: reached ? rounded(arm.state.time) : exp.config.duration, closestDistance: arm.closestDistance, pathLength: arm.pathLength,
    finalDistance: Math.hypot(arm.state.fish.x - arm.state.target.x, arm.state.fish.y - arm.state.target.y)};
  exp.events.push({modelTime: exp.time, kind: 'result', arm: name, reached, text: reached ? 'Target reached.' : 'Time limit reached.'});
}

export function stepChallenge(exp) {
  if (exp.finished) return exp;
  const stimulusTime = exp.steps * DT, config = exp.config;
  exp.target = targetAt(config, stimulusTime);
  if (config.motion === 'switch' && !exp.switched && stimulusTime >= 4 - 1e-9) {
    exp.switched = true;
    for (const arm of Object.values(exp.arms)) arm.closestDistance = Math.hypot(arm.state.fish.x - exp.target.x, arm.state.fish.y - exp.target.y);
    exp.events.push({modelTime: rounded(stimulusTime), kind: 'stimulus', action: 'switch', text: 'The target switched sides.'});
  }
  const hidden = config.occlusion.enabled && stimulusTime >= config.occlusion.at - 1e-9 && stimulusTime < config.occlusion.at + config.occlusion.duration - 1e-9;
  if (hidden !== exp.arms.baseline.hidden) exp.events.push({modelTime: rounded(stimulusTime), kind: 'stimulus', action: hidden ? 'hide' : 'restore', text: hidden ? 'Both visual inputs were removed.' : 'Both visual inputs were restored.'});
  exp.steps++; exp.time = rounded(exp.steps * DT);
  for (const [name, arm] of Object.entries(exp.arms)) {
    arm.state.target = {...exp.target}; arm.hidden = hidden; arm.state.config.mode = hidden ? 'dark' : 'light-left';
    if (arm.finished) {renderRetina(arm.state); continue;}
    const previous = {x: arm.state.fish.x, y: arm.state.fish.y};
    parameterStep(arm.state, name === 'baseline' ? BASE_WEIGHTS : exp.weights);
    arm.pathLength += Math.hypot(arm.state.fish.x - previous.x, arm.state.fish.y - previous.y);
    arm.path.push({x: arm.state.fish.x, y: arm.state.fish.y});
    const distance = Math.hypot(arm.state.fish.x - exp.target.x, arm.state.fish.y - exp.target.y);
    const scoring = config.motion !== 'switch' || exp.switched;
    if (scoring) arm.closestDistance = Math.min(arm.closestDistance, distance);
    if (scoring && distance <= config.radius + 1e-12) finish(exp, name, true);
    else if (exp.steps >= Math.round(config.duration / DT)) finish(exp, name, false);
  }
  exp.finished = Object.values(exp.arms).every(arm => arm.finished);
  return exp;
}

export function exportChallenge(exp) {
  return clone({schemaVersion: 1, kind: 'zebrafish-frozen-controller-challenge', modelVersion: MODEL_VERSION, taskVersion: TASK_VERSION,
    config: exp.config, weights: exp.weights, baselineWeights: BASE_WEIGHTS, initial: INITIAL, dt: DT,
    time: exp.time, steps: exp.steps, finished: exp.finished, target: exp.target,
    arms: Object.fromEntries(Object.entries(exp.arms).map(([name, arm]) => [name, {reached: arm.reached, finished: arm.finished,
      result: arm.result, path: arm.path, pathLength: arm.pathLength, hidden: arm.hidden, state: snapshot(arm.state)}])), events: exp.events});
}

export function runChallenge(config = DEFAULT_CONFIG, weights = BASE_WEIGHTS) {
  const exp = createChallenge(config, weights);
  while (!exp.finished) stepChallenge(exp);
  return exportChallenge(exp);
}

function provenanceChecked(value) {
  const integerKeys = ['generation', 'championGeneration'];
  const dates = ['persistedAt', 'capturedAt'];
  const hashes = ['learnerHash', 'recordHash', 'checkpointHash'];
  const text = ['label', 'modelVersion', 'learnerVersion'];
  keys(value, [], [...integerKeys, ...dates, ...hashes, ...text, 'source']);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (integerKeys.includes(key)) {
      if (!Number.isSafeInteger(entry) || entry < 0) throw new RangeError('Invalid provenance generation.');
    } else {
      if (typeof entry !== 'string' || entry.length > 300 || /[<>\u0000-\u001f]/.test(entry)) throw new TypeError('Provenance must contain short plain text.');
      if (dates.includes(key) && !Number.isFinite(Date.parse(entry))) throw new RangeError('Invalid provenance timestamp.');
      if (hashes.includes(key) && !/^[a-f0-9]{64}$/i.test(entry)) throw new RangeError('Invalid provenance hash.');
      if (key === 'source') {let url; try {url = new URL(entry);} catch {throw new TypeError('Invalid provenance source.');} if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Provenance source must be an HTTPS URL.');}
    }
    result[key] = entry;
  }
  if (result.championGeneration !== undefined && result.generation !== undefined && result.championGeneration > result.generation) throw new RangeError('Champion generation exceeds checkpoint generation.');
  return result;
}

function envelopeChecked(value) {
  keys(value, ['version', 'config', 'weights'], ['provenance']);
  if (value.version !== 1) throw new RangeError('Unsupported challenge-link version.');
  const result = {version: 1, config: validateConfig(value.config), weights: weightsChecked(value.weights)};
  if (value.provenance !== undefined) result.provenance = provenanceChecked(value.provenance);
  return result;
}

export function encodeChallenge(value) {
  keys(value, ['config', 'weights'], ['provenance']);
  const checked = envelopeChecked({version: 1, ...value});
  const bytes = new TextEncoder().encode(JSON.stringify(checked));
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (encoded.length > 5000) throw new RangeError('Challenge link exceeds 5000 characters.');
  return encoded;
}

export function decodeChallenge(encoded) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > 5000 || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) throw new TypeError('Invalid encoded challenge link.');
  let parsed;
  try {
    const base64 = encoded.replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), char => char.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {throw new TypeError('Challenge link is not valid UTF-8 JSON.');}
  return envelopeChecked(parsed);
}
