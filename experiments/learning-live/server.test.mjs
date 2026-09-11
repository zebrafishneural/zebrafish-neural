import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {resolve, relative, isAbsolute, join} from 'node:path';
import {createHash} from 'node:crypto';
import {startServer} from './serve.mjs';

const SCRATCH = resolve(import.meta.dirname, '../../../../work/learning-live-server-tests');
const CONFIG = Object.freeze({seed: 2026091101, trainCount: 3, validationCount: 3,
  auditCount: 3, pairs: 1, auditEvery: 10});
const recordName = generation => `generation-${String(generation).padStart(12, '0')}.json`;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deferred = () => {
  let resolvePromise;
  const promise = new Promise(resolve => {resolvePromise = resolve;});
  return {promise, resolve: resolvePromise};
};
async function directory() {
  await mkdir(SCRATCH, {recursive: true});
  return mkdtemp(join(SCRATCH, 'server-'));
}
async function removeDirectory(path) {
  const within = relative(SCRATCH, resolve(path));
  assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Delete only this test workspace');
  await rm(path, {recursive: true, force: true});
}
async function until(predicate, message = 'learning server state') {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${message}`);
}
const baseURL = app => `http://127.0.0.1:${app.port}`;
async function json(app, path) {
  const response = await fetch(baseURL(app) + path);
  assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
  return response.json();
}

test('an initial proposal is not published before durable persistence completes', async () => {
  const dataDir = await directory(), release = deferred();
  let app, persistEntered = false;
  try {
    app = await startServer({port: 0, dataDir, config: CONFIG, autoStart: false,
      beforePersist: async ({learner}) => {
        assert.equal(learner.generation, 0);
        persistEntered = true; await release.promise;
      }});
    await until(() => persistEntered, 'the initial persistence hook');
    const pending = await json(app, '/api/status');
    assert.equal(pending.learner, null);
    assert.equal(pending.persistedAt, null);
    assert.equal((await fetch(baseURL(app) + '/api/checkpoint')).status, 503);
    assert.deepEqual((await json(app, '/api/records')).records, []);
    release.resolve();
    await until(() => app.getState().status === 'paused' && app.getState().learner?.generation === 0);
    const checkpoint = await json(app, '/api/checkpoint');
    assert.equal(checkpoint.generation, 0);
    assert.equal(checkpoint.learnerHash, hash(checkpoint.learner));
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'checkpoint.json'), 'utf8')), checkpoint);
    const records = await json(app, '/api/records');
    assert.equal(records.records.length, 1);
    assert.equal(records.records[0].previousHash, null);
    assert.equal(records.records[0].hash, checkpoint.recordHash);
  } finally {
    release.resolve();
    if (app) await app.close();
    await removeDirectory(dataDir);
  }
});

test('observer endpoints reject mutations and do not serve arbitrary local files', async () => {
  const dataDir = await directory();
  let app;
  try {
    await writeFile(join(dataDir, 'private-canary.txt'), 'THIS MUST NOT BE SERVED');
    app = await startServer({port: 0, dataDir, config: CONFIG, autoStart: false});
    await until(() => app.getState().status === 'paused');
    for (const path of ['/api/status', '/api/checkpoint', '/api/records']) {
      const response = await fetch(baseURL(app) + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.headers.get('content-type'), /application\/json/);
      const head = await fetch(baseURL(app) + path, {method: 'HEAD'});
      assert.equal(head.status, 200); assert.equal(await head.text(), '');
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal((await fetch(baseURL(app) + path, {method,
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({seed: 7})})).status, 405);
      }
    }
    for (const path of ['/data/checkpoint.json', '/checkpoint.json', '/checkpoint.previous.json',
      '/data/private-canary.txt', '/private-canary.txt', '/records/' + recordName(0),
      '/worker.mjs', '/serve.mjs', '/.git/config', '/api/train', '/api/reset', '/api/missing']) {
      const response = await fetch(baseURL(app) + path);
      assert.equal(response.status, 404, path);
      assert.ok(!(await response.text()).includes('THIS MUST NOT BE SERVED'));
    }
    assert.equal((await fetch(baseURL(app) + '/dist/..%5c..%5cpackage.json')).status, 403);
    assert.equal((await fetch(baseURL(app) + '/api/status', {headers: {Origin: 'https://example.com'}})).status, 403);
    const allowed = await fetch(baseURL(app) + '/api/status', {headers: {Origin: 'https://zebraneural.com'}});
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://zebraneural.com');
    assert.equal((await fetch(baseURL(app) + '/api/records?date=not-a-date')).status, 400);
    const future = await json(app, '/api/records?date=2099-01-01');
    assert.deepEqual(future.records, []);
  } finally {
    if (app) await app.close();
    await removeDirectory(dataDir);
  }
});

test('failed saves retain committed state; restart resumes it and preserves immutable record history', async () => {
  const dataDir = await directory();
  let app;
  try {
    app = await startServer({port: 0, dataDir, intervalMs: 1, config: CONFIG,
      beforePersist: ({learner}) => {if (learner.generation === 2) throw new Error('Intentional test save failure');}});
    await until(() => app.getState().status === 'error', 'intentional generation-2 save failure');
    assert.equal(app.getState().learner.generation, 1);
    const checkpoint = await json(app, '/api/checkpoint');
    assert.equal(checkpoint.generation, 1);
    assert.deepEqual(app.getState().learner, checkpoint.learner);
    assert.equal(app.getState().nextGenerationAt, null);
    assert.equal(JSON.parse(await readFile(join(dataDir, 'checkpoint.json'), 'utf8')).generation, 1);
    const previous = JSON.parse(await readFile(join(dataDir, 'checkpoint.previous.json'), 'utf8'));
    assert.equal(previous.generation, 0);
    const before = await json(app, '/api/records');
    assert.equal(before.throughGeneration, 1);
    assert.deepEqual(before.records.map(record => record.generation), [0, 1]);
    assert.equal(before.records[1].previousHash, before.records[0].hash);
    for (const record of before.records) {
      assert.equal(Object.hasOwn(record, 'learner'), false, 'Do not repeat full checkpoint history in every record');
      const {hash: digest, ...payload} = record;
      assert.equal(hash(payload), digest);
    }
    const generationOneBytes = await readFile(join(dataDir, 'records', recordName(1)), 'utf8');
    // A record left by an interrupted commit must remain invisible until the
    // checkpoint pointer advances, even when it has a valid-looking filename.
    await writeFile(join(dataDir, 'records', recordName(2)), JSON.stringify({generation: 2, orphan: true}));
    await writeFile(join(dataDir, 'records', recordName(999)), JSON.stringify({generation: 999, orphan: true}));
    assert.deepEqual((await json(app, '/api/records')).records.map(record => record.generation), [0, 1]);
    await app.close(); app = null;

    app = await startServer({port: 0, dataDir, config: CONFIG, autoStart: false});
    await until(() => app.getState().status === 'paused');
    assert.deepEqual(await json(app, '/api/checkpoint'), checkpoint);
    assert.deepEqual(app.getState().learner, checkpoint.learner);
    assert.equal(await readFile(join(dataDir, 'records', recordName(1)), 'utf8'), generationOneBytes);
    await app.close(); app = null;

    app = await startServer({port: 0, dataDir, intervalMs: 1, config: CONFIG,
      beforePersist: ({learner}) => {if (learner.generation === 3) throw new Error('Intentional next-save test failure');}});
    await until(() => app.getState().status === 'error', 'resumed generation-3 save failure');
    assert.equal(app.getState().learner.generation, 2);
    const resumed = await json(app, '/api/checkpoint');
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.learner.config.seed, CONFIG.seed);
    const after = await json(app, '/api/records');
    assert.deepEqual(after.records.map(record => record.generation), [0, 1, 2]);
    assert.equal(after.records[2].previousHash, before.records[1].hash);
    assert.equal(Object.hasOwn(after.records[2], 'orphan'), false);
    assert.equal(after.records[2].hash, resumed.recordHash);
    assert.equal(await readFile(join(dataDir, 'records', recordName(1)), 'utf8'), generationOneBytes);
  } finally {
    if (app) await app.close();
    await removeDirectory(dataDir);
  }
});

test('a corrupted persisted checkpoint is rejected instead of silently creating a new learner', async () => {
  const dataDir = await directory();
  let app;
  try {
    app = await startServer({port: 0, dataDir, config: CONFIG, autoStart: false});
    await until(() => app.getState().status === 'paused');
    await app.close(); app = null;
    const path = join(dataDir, 'checkpoint.json');
    const checkpoint = JSON.parse(await readFile(path, 'utf8'));
    checkpoint.learner.generation += 1;
    await writeFile(path, JSON.stringify(checkpoint));
    await assert.rejects(startServer({port: 0, dataDir, config: CONFIG, autoStart: false}), /integrity check failed/);
  } finally {
    if (app) await app.close();
    await removeDirectory(dataDir);
  }
});
