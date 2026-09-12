import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const MAX_PLY = 10000;

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Payload must contain finite, acyclic JSON values.');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Payload must contain plain JSON objects.');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbol keys cannot be persisted.');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? `[${Array.from(value, item => canonical(item, ancestors)).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`).join(',')}}`;
  ancestors.delete(value);
  return result;
}

function objectPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Payload must be a JSON object.');
  return canonical(value);
}

const hash = value => createHash('sha256').update(value).digest('hex');
function gameId(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Invalid game ID.');
  return value;
}
function plyNumber(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PLY) throw new TypeError(`Ply must be an integer between 1 and ${MAX_PLY}.`);
  return value;
}

/** One process owns this directory. Hashes detect damage; they are not signatures. */
export async function createStore(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) throw new TypeError('A data directory is required.');
  const requestedRoot = resolve(dataDir);
  await mkdir(requestedRoot, { recursive: true });
  if ((await lstat(requestedRoot)).isSymbolicLink()) throw new Error('The data directory must not be a symbolic link.');
  const root = await realpath(requestedRoot);

  async function checkedPath(...parts) {
    const path = resolve(root, ...parts);
    const rel = relative(root, path);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Storage path leaves the data directory.');
    let cursor = root;
    for (const part of rel.split(sep)) {
      cursor = join(cursor, part);
      try {
        if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symbolic links are not allowed in storage: ${rel}`);
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
    }
    return path;
  }

  async function read(parts) {
    const path = await checkedPath(...parts);
    let text;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const wrapper = JSON.parse(text);
      if (!wrapper || Object.keys(wrapper).sort().join(',') !== 'payload,schemaVersion,sha256' || wrapper.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(wrapper.sha256)) throw new Error('Invalid wrapper.');
      const serialized = objectPayload(wrapper.payload);
      if (hash(serialized) !== wrapper.sha256) throw new Error('SHA-256 mismatch.');
      return { payload: wrapper.payload, serialized };
    } catch (error) {
      throw new Error(`Corrupt storage file ${parts.join('/')}: ${error.message}`, { cause: error });
    }
  }

  async function write(parts, serialized) {
    const path = await checkedPath(...parts);
    await mkdir(dirname(path), { recursive: true });
    await checkedPath(...parts);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const wrapper = `{"schemaVersion":1,"sha256":"${hash(serialized)}","payload":${serialized}}\n`;
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(wrapper, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, path);
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function immutable(parts, payload) {
    const serialized = objectPayload(payload);
    const existing = await read(parts);
    if (existing) {
      if (existing.serialized !== serialized) throw new Error(`Conflicting immutable record: ${parts.join('/')}`);
      return;
    }
    await write(parts, serialized);
  }

  function archiveId(game) {
    const id = gameId(game?.id ?? game?.gameId);
    if (game.id !== undefined && game.gameId !== undefined && game.id !== game.gameId) throw new TypeError('Game ID fields disagree.');
    return id;
  }

  async function getGame(id) {
    gameId(id);
    const game = (await read(['games', `${id}.json`]))?.payload ?? null;
    if (game && archiveId(game) !== id) throw new Error(`Archive game ID does not match its filename: ${id}`);
    return game;
  }

  return {
    async loadCheckpoint() {
      const current = await read(['checkpoint.json']);
      if (current) return current.payload;
      if (await read(['checkpoint.previous.json'])) throw new Error('Current checkpoint is missing but a previous checkpoint exists; explicit recovery is required.');
      return null;
    },
    async saveCheckpoint(payload) {
      const serialized = objectPayload(payload);
      const current = await read(['checkpoint.json']);
      if (current?.serialized === serialized) return;
      // A bad backup is an error too: do not conceal damaged state on the next save.
      const previous = await read(['checkpoint.previous.json']);
      if (!current && previous) throw new Error('Current checkpoint is missing; restore explicitly before saving.');
      if (current) await write(['checkpoint.previous.json'], current.serialized);
      await write(['checkpoint.json'], serialized);
    },
    async saveDecision(id, ply, record) {
      await immutable(['decisions', gameId(id), `${String(plyNumber(ply)).padStart(12, '0')}.json`], record);
    },
    async getDecision(id, ply) {
      return (await read(['decisions', gameId(id), `${String(plyNumber(ply)).padStart(12, '0')}.json`]))?.payload ?? null;
    },
    async saveGame(game) {
      await immutable(['games', `${archiveId(game)}.json`], game);
    },
    getGame,
    async listGames() {
      const directory = await checkedPath('games');
      let names;
      try { names = await readdir(directory); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const summaries = [];
      for (const name of names.filter(name => name.endsWith('.json'))) {
        const id = gameId(name.slice(0, -5));
        const game = await getGame(id);
        if (!game) throw new Error(`Archive disappeared while listing: ${id}`);
        summaries.push({ id, startedAt: game.startedAt ?? null, finishedAt: game.finishedAt ?? null, result: game.result ?? null, ply: game.ply ?? game.history?.length ?? 0, fishColor: game.fishColor ?? null, opponent: game.opponent ?? null });
      }
      return summaries.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) || b.id.localeCompare(a.id));
    },
  };
}
