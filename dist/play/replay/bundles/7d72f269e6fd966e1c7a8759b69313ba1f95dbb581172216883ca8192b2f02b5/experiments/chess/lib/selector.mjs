import {Chess} from '../public/lib/chess.js';
import {makeState, REGIONS, DT, clamp, wrap, MODEL_VERSION} from '../public/lib/model.js';

export {DT, MODEL_VERSION};
export const SELECTOR_VERSION = 'bilateral-chess-selector-1';
export const BASE_WEIGHTS = Object.freeze([.5, .45, 1, .12, .08, .55]);
export const PARAMS = Object.freeze([
  {id: 'visualIntegrator', min: .1, max: 1.5},
  {id: 'visualDrive', min: .1, max: 1.35},
  {id: 'visualMotor', min: .25, max: 2.5},
  {id: 'integratorMotor', min: 0, max: .5},
  {id: 'sharedMotor', min: 0, max: .35},
  {id: 'motorSpinal', min: .15, max: 1.65}
].map(Object.freeze));
export const FEATURES = Object.freeze([
  {id: 'captureValue', label: 'Capture value', description: 'Captured piece value divided by 9: pawn 1, knight/bishop 3, rook 5, queen 9. No promotion bonus or search.'},
  {id: 'destinationSafety', label: 'Destination safety', description: '1 if the destination is not attacked by the opponent after this move; 0 otherwise. An attack-map heuristic, not a tactical safety guarantee.'},
  {id: 'centralControl', label: 'Central control', description: 'Fraction of d4, e4, d5 and e5 attacked by the moving side after this move.'},
  {id: 'givesCheck', label: 'Gives check', description: '1 if this move checks the opponent; 0 otherwise. No lookahead or engine evaluation.'}
].map(Object.freeze));
export const MODES = Object.freeze(['neural', 'no-input', 'clamped-motor', 'random', 'heuristic']);
export const PHASE_STEPS = 6;
export const TIE_EPSILON = 1e-12;
const PIECE_VALUE = Object.freeze({p: 1, n: 3, b: 3, r: 5, q: 9, k: 0});
const CENTER = Object.freeze(['d4', 'e4', 'd5', 'e5']);
const uint32 = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;

function checkedWeights(weights) {
  if (!Array.isArray(weights) || weights.length !== 6) throw new TypeError('Exactly six controller gains are required.');
  return weights.map((value, index) => {
    const {id, min, max} = PARAMS[index];
    if (!Number.isFinite(value) || value < min || value > max) throw new RangeError(`${id} must be finite and in [${min}, ${max}].`);
    return value;
  });
}

function rngFromSeed(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(values, random) {
  for (let index = values.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values;
}

function candidatesFor(board) {
  const candidates = [];
  for (const move of board.moves({verbose: true})) {
    board.move({from: move.from, to: move.to, ...(move.promotion ? {promotion: move.promotion} : {})});
    const features = [
      (PIECE_VALUE[move.captured] ?? 0) / 9,
      board.isAttacked(move.to, board.turn()) ? 0 : 1,
      CENTER.filter(square => board.isAttacked(square, move.color)).length / CENTER.length,
      board.isCheck() ? 1 : 0
    ];
    board.undo();
    candidates.push({uci: move.from + move.to + (move.promotion ?? ''), san: move.san, features});
  }
  return candidates.sort((left, right) => left.uci < right.uci ? -1 : left.uci > right.uci ? 1 : 0);
}

// The original external-input equations, with only the six declared tied gains
// parameterized. No synthetic target renderer runs here and no chess value enters
// the dynamics outside the published left/right feature cue.
function advanceExternal(state, weights, clampMotor = false) {
  const r = state.rates, f = state.features;
  const go = 1 - .7 * f.center * (1 - f.threat);
  const drive = [f.left, f.right, weights[0] * r[0], weights[0] * r[1], weights[1] * (r[0] + r[1]),
    go * weights[2] * r[0] + weights[3] * r[2] + weights[4] * r[4],
    go * weights[2] * r[1] + weights[3] * r[3] + weights[4] * r[4],
    weights[5] * (r[5] + r[6]) + .25 * f.threat];
  for (let index = 0; index < 8; index++) {
    r[index] = clamp(r[index] + DT / REGIONS[index].tau * (clamp(drive[index] + .10 * r[index]) - r[index]));
  }
  // Explicit output-lesion control. Visual/integrator activity remains real;
  // motor outputs cannot decide a tournament winner in this diagnostic mode.
  if (clampMotor) r[5] = r[6] = 0;
  const fish = state.fish;
  fish.turn = 3.2 * (r[6] - r[5]);
  fish.heading = wrap(fish.heading + fish.turn * DT);
  fish.speed = .15 * r[7];
  const nextX = fish.x + Math.cos(fish.heading) * fish.speed * DT;
  const nextY = fish.y + Math.sin(fish.heading) * fish.speed * DT;
  if (nextX < .045 || nextX > .955) fish.heading = wrap(Math.PI - fish.heading);
  if (nextY < .055 || nextY > .945) fish.heading = wrap(-fish.heading);
  fish.x = clamp(nextX, .045, .955); fish.y = clamp(nextY, .055, .945);
  state.distance += fish.speed * DT; state.time += DT;
  return state;
}

/** One 20 ms external-input step, with the original non-aversive equations. */
export function parameterStepExternal(state, weights = BASE_WEIGHTS) {
  const checked = checkedWeights(weights);
  if (!state || state.config?.inputSource !== 'browser' || !state.rates || state.rates.length !== 8 ||
      !Array.from(state.rates).every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      !['left', 'right', 'center', 'threat'].every(key => Number.isFinite(state.features?.[key]) && state.features[key] >= 0 && state.features[key] <= 1) ||
      !['x', 'y', 'heading', 'speed', 'turn'].every(key => Number.isFinite(state.fish?.[key])) ||
      !Number.isFinite(state.time) || !Number.isFinite(state.distance)) throw new TypeError('A finite external-input model state is required.');
  return advanceExternal(state, checked);
}

function cue(state, left, right) {
  state.features = {left, right, center: 0, threat: 0};
  // This is a synthetic two-channel cue, not an image of the chessboard. Each
  // hemifield represents its corresponding input feature (Float32 display).
  for (let row = 0; row < 16; row++) {
    state.retina.fill(left, row * 32, row * 32 + 16);
    state.retina.fill(right, row * 32 + 16, (row + 1) * 32);
  }
}

const identity = candidate => ({uci: candidate.uci, san: candidate.san});

/** All randomness is seed-derived; no engine evaluation or hidden move filter. */
export function* decisionSteps(fen, {seed = 20260912, weights = BASE_WEIGHTS, mode = 'neural'} = {}) {
  if (typeof fen !== 'string' || !fen.length || fen.length > 200) throw new TypeError('A chess FEN string is required.');
  if (!uint32(seed)) throw new RangeError('seed must be an unsigned 32-bit integer.');
  if (!MODES.includes(mode)) throw new RangeError('Unsupported selector mode.');
  const gains = checkedWeights(weights), board = new Chess(fen), candidates = candidatesFor(board), random = rngFromSeed(seed);
  const record = {fen: board.fen(), selectedUci: null, selectedSan: null, seed, weights: gains, mode,
    modelVersion: MODEL_VERSION, selectorVersion: SELECTOR_VERSION, featureDefinitions: FEATURES.map(feature => ({...feature})),
    candidates, comparisons: [], comparisonCount: Math.max(0, candidates.length - 1),
    modelSteps: 0, modelDuration: 0, control: null,
    protocol: {dt: DT, phaseSteps: PHASE_STEPS, featureOrder: FEATURES.map(feature => feature.id),
      sampleEverySteps: 2, resetEachOrientation: true, margin: '(forwardMotorIntegral - swappedMotorIntegral) / 2',
      tieEpsilon: TIE_EPSILON, cue: 'Synthetic bilateral feature levels; no board screenshot',
      weightsFrozen: true, rng: 'mulberry32', tournament: 'Seeded Fisher-Yates order; knockout pairs with byes'}};
  const finish = selected => {
    record.selectedUci = selected?.uci ?? null; record.selectedSan = selected?.san ?? null;
    record.modelDuration = record.modelSteps * DT;
    return record;
  };
  if (!candidates.length) return finish(null);
  if (candidates.length === 1) return finish(candidates[0]);
  if (mode === 'random') {
    const draw = random(), index = Math.floor(draw * candidates.length);
    record.control = {kind: 'Uniform random legal move', draw, index};
    record.comparisonCount = 0;
    return finish(candidates[index]);
  }
  if (mode === 'heuristic') {
    const scores = candidates.map(candidate => candidate.features.reduce((sum, value) => sum + value, 0) / FEATURES.length);
    const maximum = Math.max(...scores), tied = candidates.filter((_, index) => Math.abs(scores[index] - maximum) <= TIE_EPSILON);
    const draw = tied.length > 1 ? random() : null, selected = tied[draw === null ? 0 : Math.floor(draw * tied.length)];
    record.control = {kind: 'Equal-weight mean of the same four features', scores, maximum, tiedUci: tied.map(candidate => candidate.uci), draw};
    record.comparisonCount = 0;
    return finish(selected);
  }
  let round = shuffle([...candidates], random);
  while (round.length > 1) {
    const nextRound = [];
    for (let index = 0; index < round.length; index += 2) {
      if (index + 1 === round.length) {nextRound.push(round[index]); continue;}
      const originalLeft = round[index], originalRight = round[index + 1], comparisonIndex = record.comparisons.length + 1;
      const margins = [];
      for (const orientation of ['forward', 'swapped']) {
        const left = orientation === 'forward' ? originalLeft : originalRight;
        const right = orientation === 'forward' ? originalRight : originalLeft;
        const state = makeState({inputSource: 'browser', mode: 'dark'});
        let integral = 0;
        for (let featureIndex = 0; featureIndex < FEATURES.length; featureIndex++) {
          const feature = FEATURES[featureIndex];
          cue(state, mode === 'no-input' ? 0 : left.features[featureIndex], mode === 'no-input' ? 0 : right.features[featureIndex]);
          for (let tick = 0; tick < PHASE_STEPS; tick++) {
            advanceExternal(state, gains, mode === 'clamped-motor');
            integral += (state.rates[5] - state.rates[6]) * DT;
            record.modelSteps++;
            if ((tick + 1) % 2 === 0) yield {rates: Array.from(state.rates), retina: Array.from(state.retina),
              inputFeatures: {...state.features}, modelTime: record.modelSteps * DT, orientationTime: state.time,
              comparisonIndex, comparisonCount: record.comparisonCount, featureId: feature.id, featureLabel: feature.label,
              left: identity(left), right: identity(right), orientation, margin: integral};
          }
        }
        margins.push(integral);
      }
      const margin = (margins[0] - margins[1]) / 2;
      let winner, tieBreak = null;
      if (Math.abs(margin) <= TIE_EPSILON) {
        const draw = random(); winner = draw < .5 ? originalLeft : originalRight;
        tieBreak = {reason: 'Motor margin within the declared tolerance', draw, selectedUci: winner.uci};
      } else winner = margin > 0 ? originalLeft : originalRight;
      record.comparisons.push({index: comparisonIndex, leftUci: originalLeft.uci, rightUci: originalRight.uci,
        forwardMargin: margins[0], reverseMargin: margins[1], margin, winnerUci: winner.uci, tieBreak});
      nextRound.push(winner);
    }
    round = nextRound;
  }
  return finish(round[0]);
}
