import {createHash, randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, readdir, realpath, rename, unlink} from 'node:fs/promises';
import {join, resolve} from 'node:path';

export const ID = /^play_[a-f0-9]{32}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
export class PlayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** Private, bounded, single-owner storage. SHA-256 detects damage, not tampering. */
export async function createPlayStore(directory, {maxBytes = 512 * 1024 * 1024} = {}) {
  const requested = resolve(directory);
  await mkdir(requested, {recursive: true});
  if ((await lstat(requested)).isSymbolicLink()) throw Error('Play data directory must not be a symbolic link.');
  const root = await realpath(requested), sizes = new Map();
  let serial = Promise.resolve();
  const ordered = operation => {
    const next = serial.then(operation); serial = next.catch(() => {}); return next;
  };
  async function path(name) {
    if (!/^play_[a-f0-9]{32}(?:-\d{1,3})?\.json$/.test(name)) throw Error('Invalid storage name.');
    const file = join(root, name);
    try { if ((await lstat(file)).isSymbolicLink()) throw Error('Storage links are forbidden.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return file;
  }
  for (const entry of await readdir(root, {withFileTypes: true})) {
    if (/^play_[a-f0-9]{32}(?:-\d{1,3})?\.json\.[a-f0-9-]{36}\.tmp$/.test(entry.name)) {
      const temporary = join(root, entry.name), info = await lstat(temporary);
      if (!info.isFile() || info.isSymbolicLink()) throw Error('Invalid interrupted storage temporary.');
      await unlink(temporary); continue;
    }
    if (!entry.name.endsWith('.json')) continue;
    const file = await path(entry.name), info = await lstat(file);
    if (!info.isFile()) throw Error('Unexpected entry in play storage.');
    sizes.set(entry.name, info.size);
  }
  const bytes = () => [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (bytes() > maxBytes) throw Error('Existing play storage exceeds the configured byte limit.');
  async function read(name) {
    let data;
    try { data = await readFile(await path(name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const wrapped = JSON.parse(data);
    if (wrapped.schemaVersion !== 1 || digest(JSON.stringify(wrapped.payload)) !== wrapped.sha256) throw Error('Play storage integrity check failed.');
    return wrapped.payload;
  }
  async function write(name, value) {
    return ordered(async () => {
      const payload = JSON.stringify(value), data = JSON.stringify({schemaVersion: 1, sha256: digest(payload), payload: value});
      const length = Buffer.byteLength(data);
      if (length > 8 * 1024 * 1024 || bytes() - (sizes.get(name) || 0) + length > maxBytes) {
        throw new PlayError(503, 'STORAGE_FULL', 'Session storage is full. Please try again later.');
      }
      const file = await path(name), temp = join(root, `${name}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await open(temp, 'wx', 0o600); await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
        await rename(temp, file); sizes.set(name, length);
      } finally { await handle?.close(); await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    });
  }
  const checked = id => { if (!ID.test(id)) throw new PlayError(404, 'NOT_FOUND', 'Game not found.'); return id; };
  return {
    root, bytes,
    async sessions() { return Promise.all([...sizes.keys()].filter(name => /^play_[a-f0-9]{32}\.json$/.test(name)).map(read)); },
    saveSession(session) { return write(`${checked(session.game.id)}.json`, session); },
    saveDecision(id, ply, record) {
      if (!Number.isInteger(ply) || ply < 1 || ply > 300) throw Error('Invalid decision ply.');
      return write(`${checked(id)}-${ply}.json`, record);
    },
    getDecision(id, ply) { return read(`${checked(id)}-${ply}.json`); },
    async removeSession(id) {
      checked(id);
      await ordered(async () => {
        for (const name of [...sizes.keys()].filter(name => name === `${id}.json` || name.startsWith(`${id}-`))) {
          await unlink(await path(name)); sizes.delete(name);
        }
      });
    }
  };
}
