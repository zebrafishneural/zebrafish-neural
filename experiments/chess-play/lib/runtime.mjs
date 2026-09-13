import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {Chess} from '../../chess/public/lib/chess.js';
import {BASE_WEIGHTS, FEATURES, MODEL_VERSION, SELECTOR_VERSION, decisionSteps} from '../../chess/lib/selector.mjs';
import {ID, PlayError} from './store.mjs';

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const seedFor = (game, ply) => (game.seed ^ Math.imul(ply + 1, 0x9e3779b1)) >>> 0;
const moveObject = uci => ({from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? {promotion: uci[4]} : {})});
const error = (status, code, message) => { throw new PlayError(status, code, message); };
function tag(board, game) {
  board.header('Event', 'You vs the Fish', 'Site', 'Zebrafish Neural', 'Round', game.id,
    'White', game.fishColor === 'w' ? 'Zebrafish Neural' : 'Human player',
    'Black', game.fishColor === 'b' ? 'Zebrafish Neural' : 'Human player',
    'Result', game.result ? game.result.winner === 'w' ? '1-0' : game.result.winner === 'b' ? '0-1' : '1/2-1/2' : '*');
}
function boardFor(game) {
  const board = new Chess();
  for (const move of game.moves) {
    const played = board.move(moveObject(move.uci));
    if (!played || played.san !== move.san) throw Error('Saved move history failed validation.');
  }
  if (board.fen() !== game.fen || board.turn() !== game.turn || game.ply !== game.moves.length) throw Error('Saved position failed validation.');
  tag(board, game); return board;
}
function validateDecision(record, game, move, fenBefore, fenAfter) {
  if (!record || record.gameId !== game.id || record.ply !== move.ply || record.actor !== 'fish' ||
    record.fenBefore !== fenBefore || record.fen !== fenBefore || record.fenAfter !== fenAfter ||
    record.selectedUci !== move.uci || record.selectedSan !== move.san || record.seed !== seedFor(game, move.ply) ||
    record.modelVersion !== MODEL_VERSION || record.selectorVersion !== SELECTOR_VERSION ||
    record.weightsHash !== game.weightsHash || JSON.stringify(record.weights) !== JSON.stringify(BASE_WEIGHTS)) {
    throw Error('Committed fish decision is missing or inconsistent with its game.');
  }
  return record;
}
function resultFor(board, fishColor, ply, maxPlies) {
  if (board.isCheckmate()) return {outcome: board.turn() === fishColor ? 'loss' : 'win', reason: 'Checkmate', winner: board.turn() === 'w' ? 'b' : 'w'};
  for (const [test, reason] of [['isStalemate', 'Stalemate'], ['isInsufficientMaterial', 'Insufficient material'], ['isThreefoldRepetition', 'Threefold repetition'], ['isDrawByFiftyMoves', 'Fifty-move rule']]) {
    if (board[test]()) return {outcome: 'draw', reason, winner: null};
  }
  return ply >= maxPlies ? {outcome: 'draw', reason: `Session move limit (${maxPlies} plies)`, winner: null} : null;
}

export class PlayRuntime {
  constructor({store, onState = () => {}, now = Date.now, maxGames = 128, maxJobs = 2, maxPlies = 160, lifetimeMs = 24 * 60 * 60 * 1000, stepsPerTick = 3, tickMs = 40} = {}) {
    for (const [name, value, max] of [['maxGames', maxGames, 2048], ['maxJobs', maxJobs, 4], ['maxPlies', maxPlies, 300], ['lifetimeMs', lifetimeMs, 7 * 86400000], ['stepsPerTick', stepsPerTick, 512], ['tickMs', tickMs, 1000]]) {
      if (!Number.isInteger(value) || value < 1 || value > max) throw Error(`Invalid ${name}.`);
    }
    Object.assign(this, {store, onState, now, maxGames, maxJobs, maxPlies, lifetimeMs, stepsPerTick, tickMs});
    this.sessions = new Map(); this.jobs = new Map(); this.streamId = randomBytes(8).toString('hex');
    this.sequences = new Map(); this.serial = Promise.resolve(); this.closed = false; this.error = null;
  }
  ordered(operation) { const next = this.serial.then(operation); this.serial = next.catch(() => {}); return next; }
  async initialize() {
    for (const session of await this.store.sessions()) {
      if (session.schemaVersion !== 1 || !ID.test(session.game?.id) || !/^[a-f0-9]{64}$/.test(session.tokenHash) ||
        !Number.isFinite(session.expiresAt) || !['w', 'b'].includes(session.humanColor) || session.game.fishColor === session.humanColor ||
        !Number.isInteger(session.game.seed) || session.game.seed < 0 || session.game.seed > 0xffffffff ||
        JSON.stringify(session.game.weights) !== JSON.stringify(BASE_WEIGHTS) || session.game.selectorVersion !== SELECTOR_VERSION) throw Error('Invalid session checkpoint.');
      boardFor(session.game);
      const recordBoard = new Chess();
      for (const move of session.game.moves) {
        const before = recordBoard.fen(); recordBoard.move(moveObject(move.uci));
        if (move.actor === 'fish') validateDecision(await this.store.getDecision(session.game.id, move.ply), session.game, move, before, recordBoard.fen());
      }
      if (session.pending && (session.pending.fen !== session.game.fen || session.pending.ply !== session.game.ply + 1 || session.pending.seed !== seedFor(session.game, session.pending.ply))) throw Error('Pending decision is inconsistent.');
      if (!session.game.result && session.game.turn === session.game.fishColor && !session.pending) throw Error('Fish turn has no durable pending decision.');
      if (session.pending && (session.game.result || session.game.turn !== session.game.fishColor)) throw Error('Unexpected pending decision.');
      this.sessions.set(session.game.id, session);
    }
    await this.prune();
    if (this.sessions.size > this.maxGames) throw Error('Saved sessions exceed configured game limit.');
    return this;
  }
  async prune() {
    const before = this.store.bytes();
    for (const [id, session] of this.sessions) if (this.now() >= session.expiresAt) {
      this.jobs.delete(id); await this.store.removeSession(id); this.sessions.delete(id); this.sequences.delete(id);
      this.onState(id, {type: 'expired', error: 'This game session has expired.'});
    }
    if (this.error?.code === 'STORAGE_FULL' && this.store.bytes() < before) this.error = null;
  }
  authorize(id, token) {
    if (!ID.test(id) || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) error(401, 'UNAUTHORIZED', 'A valid game token is required.');
    const session = this.sessions.get(id), provided = Buffer.from(hash(token), 'hex');
    const stored = Buffer.from(session?.tokenHash || '0'.repeat(64), 'hex');
    if (!timingSafeEqual(provided, stored) || !session) error(401, 'UNAUTHORIZED', 'A valid game token is required.');
    if (this.now() >= session.expiresAt) error(410, 'EXPIRED', 'This game session has expired.');
    return session;
  }
  async decision(id, token, ply) {
    const session = this.authorize(id, token), move = session.game.moves[ply - 1];
    if (!Number.isInteger(ply) || ply < 1 || ply > session.game.ply || move?.actor !== 'fish') error(404, 'NO_DECISION', 'No committed fish decision exists for this move.');
    const board = new Chess();
    for (const earlier of session.game.moves.slice(0, ply - 1)) board.move(moveObject(earlier.uci));
    const before = board.fen(); board.move(moveObject(move.uci));
    return validateDecision(await this.store.getDecision(id, ply), session.game, move, before, board.fen());
  }
  snapshot(session) {
    const id = session.game.id, job = this.jobs.get(id);
    return {schemaVersion: 1, streamId: this.streamId, seq: this.sequences.get(id) || 0, sentAt: new Date(this.now()).toISOString(),
      status: this.error ? 'error' : session.game.result ? 'gameover' : job ? 'comparing' : session.pending ? 'queued' : 'waiting-player',
      game: clone(session.game), humanColor: session.humanColor, expiresAt: new Date(session.expiresAt).toISOString(),
      selection: clone(job?.selection || null), legalMoves: !session.game.result && session.game.turn === session.humanColor ? boardFor(session.game).moves({verbose: true}).map(move => ({from: move.from, to: move.to, ...(move.promotion ? {promotion: move.promotion} : {})})) : [],
      ...(this.error ? {error: 'The service is paused while a storage error is investigated.'} : {}),
      scope: {training: false, privateSession: true, controller: 'Eight-state controller with a handcrafted chess input adapter',
        weightsFrozen: true, modelVersion: MODEL_VERSION, selectorVersion: SELECTOR_VERSION, rules: 'chess.js 1.4.0', maxPlies: this.maxPlies}};
  }
  publish(session) { const id = session.game.id; this.sequences.set(id, (this.sequences.get(id) || 0) + 1); this.onState(id, this.snapshot(session)); }
  async create(color = 'random') {
    return this.ordered(async () => {
      if (!['w', 'b', 'random'].includes(color)) error(400, 'INVALID_COLOR', 'Choose w, b or random.');
      await this.prune();
      if (this.error) error(503, 'UNAVAILABLE', 'The service is temporarily paused.');
      if (this.sessions.size >= this.maxGames) error(503, 'CAPACITY', 'All game slots are occupied. Please try again later.');
      const humanColor = color === 'random' ? randomBytes(1)[0] % 2 ? 'w' : 'b' : color;
      const id = `play_${randomBytes(16).toString('hex')}`, token = randomBytes(32).toString('hex'), board = new Chess();
      const game = {id, seed: randomBytes(4).readUInt32LE(), startedAt: new Date(this.now()).toISOString(), finishedAt: null,
        fishColor: humanColor === 'w' ? 'b' : 'w', humanColor, fen: board.fen(), turn: 'w', inCheck: false, ply: 0, moves: [], result: null,
        opponent: 'Human player', weightsLabel: 'Original controller · frozen gains', weights: [...BASE_WEIGHTS],
        weightsHash: hash(JSON.stringify(BASE_WEIGHTS)), selectorVersion: SELECTOR_VERSION};
      tag(board, game); game.pgn = board.pgn();
      const session = {schemaVersion: 1, game, humanColor, tokenHash: hash(token), expiresAt: this.now() + this.lifetimeMs, requests: {},
        pending: humanColor === 'b' ? {ply: 1, fen: game.fen, seed: seedFor(game, 1), queuedAt: this.now()} : null};
      await this.store.saveSession(session); this.sessions.set(id, session); this.publish(session);
      return {gameId: id, token, state: this.snapshot(session)};
    });
  }
  async mutate(id, token, kind, input) {
    return this.ordered(async () => {
      const session = this.authorize(id, token);
      if (this.error) error(503, 'UNAVAILABLE', 'The service is temporarily paused.');
      if (!input || !Number.isInteger(input.expectedPly) || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId)) error(400, 'INVALID_REQUEST', 'expectedPly and a unique requestId are required.');
      const signature = hash(JSON.stringify([kind, input.expectedPly, input.from, input.to, input.promotion]));
      const prior = Object.hasOwn(session.requests, input.requestId) ? session.requests[input.requestId] : null;
      if (prior) {
        if (prior.signature !== signature) error(409, 'IDEMPOTENCY_CONFLICT', 'requestId was already used for a different request.');
        return {state: this.snapshot(session), duplicate: true, committedPly: prior.ply};
      }
      if (session.game.ply !== input.expectedPly) error(409, 'STALE_POSITION', 'The board changed. Refresh the position and try again.');
      if (session.game.result) error(409, 'GAME_OVER', 'This game has finished.');
      const draft = clone(session), board = boardFor(session.game);
      if (kind === 'move') {
        if (session.game.turn !== session.humanColor || session.pending) error(409, 'NOT_YOUR_TURN', 'Wait for the fish to finish its move.');
        if (!/^[a-h][1-8]$/.test(input.from || '') || !/^[a-h][1-8]$/.test(input.to || '') || (input.promotion !== undefined && !/^[qrbn]$/.test(input.promotion))) error(400, 'INVALID_MOVE', 'Use board squares and an optional q, r, b or n promotion.');
        let move;
        try { move = board.move({from: input.from, to: input.to, ...(input.promotion ? {promotion: input.promotion} : {})}); } catch { error(400, 'ILLEGAL_MOVE', 'That move is not legal in this position.'); }
        if (!move) error(400, 'ILLEGAL_MOVE', 'That move is not legal in this position.');
        this.applyMove(draft.game, board, move, 'human');
        draft.pending = draft.game.result ? null : {ply: draft.game.ply + 1, fen: draft.game.fen, seed: seedFor(draft.game, draft.game.ply + 1), queuedAt: this.now()};
      } else if (kind === 'resign') {
        draft.game.result = {outcome: 'win', winner: draft.game.fishColor, reason: 'Player resigned'};
        draft.game.finishedAt = new Date(this.now()).toISOString(); draft.pending = null;
        tag(board, draft.game); draft.game.pgn = board.pgn();
      } else error(400, 'INVALID_ACTION', 'Unknown game action.');
      Object.defineProperty(draft.requests, input.requestId, {value: {signature, ply: draft.game.ply}, enumerable: true, writable: true, configurable: true});
      await this.store.saveSession(draft); this.sessions.set(id, draft); this.jobs.delete(id); this.publish(draft);
      return {state: this.snapshot(draft), duplicate: false, committedPly: draft.game.ply};
    });
  }
  applyMove(game, board, move, actor) {
    const ply = game.ply + 1, at = new Date(this.now()).toISOString();
    game.moves.push({ply, san: move.san, uci: move.from + move.to + (move.promotion || ''), from: move.from, to: move.to,
      actor, at, ...(actor === 'fish' ? {decisionId: `${game.id}:${ply}`} : {})});
    game.ply = ply; game.fen = board.fen(); game.turn = board.turn(); game.inCheck = board.isCheck(); game.result = resultFor(board, game.fishColor, ply, this.maxPlies);
    if (game.result) game.finishedAt = at;
    tag(board, game); game.pgn = board.pgn({maxWidth: 80, newline: '\n'});
  }
  async tick() {
    if (this.closed || this.ticking || this.error) return;
    this.ticking = true;
    try { await this.ordered(async () => {
      const waiting = [...this.sessions.values()].filter(session => session.pending).sort((a, b) => (a.pending.queuedAt || 0) - (b.pending.queuedAt || 0));
      for (const session of waiting) {
        if (this.jobs.size >= this.maxJobs) break;
        if (session.pending && this.now() < session.expiresAt && !this.jobs.has(session.game.id)) {
          this.jobs.set(session.game.id, {generator: decisionSteps(session.game.fen, {seed: session.pending.seed, weights: BASE_WEIGHTS}), trace: [], selection: null});
        }
      }
      for (const [id, job] of this.jobs) {
        const session = this.sessions.get(id);
        if (this.now() >= session.expiresAt) { this.jobs.delete(id); continue; }
        for (let step = 0; step < this.stepsPerTick; step++) {
          const next = job.generator.next();
          if (next.done) {
            if (!next.value?.selectedUci) throw Error('The selector returned no move.');
            const draft = clone(session), board = boardFor(session.game), move = board.move(moveObject(next.value.selectedUci));
            this.applyMove(draft.game, board, move, 'fish'); draft.pending = null;
            const record = {...next.value, gameId: id, ply: draft.game.ply, actor: 'fish', fenBefore: session.game.fen, fenAfter: draft.game.fen,
              featureDefinitions: FEATURES, samples: job.trace, weightsHash: session.game.weightsHash};
            // Save the complete decision first. If interrupted, replay the durable seed
            // against the old position; the checkpoint is the sole commit authority.
            await this.store.saveDecision(id, draft.game.ply, record); await this.store.saveSession(draft);
            this.sessions.set(id, draft); this.jobs.delete(id); this.publish(draft); break;
          }
          job.selection = next.value;
          const {retina, ...sample} = next.value; job.trace.push(sample);
          if (job.trace.length > 6000) throw Error('Selector trace exceeded the session bound.');
        }
        if (this.jobs.has(id)) this.publish(session);
      }
    }); } catch (failure) {
      // A failed commit may have consumed the generator's final return value.
      // Recover through the persisted pending seed, never reuse that generator.
      this.error = failure; this.jobs.clear(); for (const session of this.sessions.values()) this.publish(session);
    } finally { this.ticking = false; }
  }
  health() { return {ok: !this.error, service: 'chess-play', sessions: this.sessions.size, queued: [...this.sessions.values()].filter(s => s.pending && !this.jobs.has(s.game.id) && this.now() < s.expiresAt).length, comparing: this.jobs.size, modelVersion: MODEL_VERSION, selectorVersion: SELECTOR_VERSION}; }
  start() {
    if (!this.timer) this.timer = setInterval(() => void this.tick(), this.tickMs);
    if (!this.cleanupTimer) this.cleanupTimer = setInterval(() => {
      void this.ordered(() => this.prune()).catch(failure => { this.error = failure; });
    }, 60000);
  }
  async close() { this.closed = true; clearInterval(this.timer); clearInterval(this.cleanupTimer); await this.serial; }
}
