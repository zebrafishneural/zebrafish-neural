import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rename, rm} from 'node:fs/promises';
import {resolve, relative, isAbsolute, join} from 'node:path';
import {renameWithRetry, RENAME_RETRY_DELAYS_MS} from './persistence.mjs';

const scratch = resolve(import.meta.dirname, '../../../../work/learning-live-persistence-tests');
const failure = code => Object.assign(new Error(`Injected ${code}`), {code});
async function fixture(run) {
  await mkdir(scratch, {recursive:true});
  const dir = await mkdtemp(join(scratch, 'rename-'));
  const committed = join(dir, 'checkpoint.json');
  const pending = committed + '.pending';
  const before = '{"generation":148}\n', after = '{"generation":149}\n';
  try {
    await writeFile(committed, before); await writeFile(pending, after);
    await run({committed,pending,before,after});
  } finally {
    const within = relative(scratch, resolve(dir));
    assert.ok(within && !within.startsWith('..') && !isAbsolute(within), 'Remove only the isolated test directory');
    await rm(dir, {recursive:true,force:true});
  }
}

test('successful replacement commits the pending bytes without a retry delay', async () => {
  await fixture(async ({committed,pending,after}) => {
    await renameWithRetry(pending, committed, {sleepImpl:async()=>assert.fail('No sleep on success')});
    assert.equal(await readFile(committed, 'utf8'), after);
    await assert.rejects(readFile(pending), {code:'ENOENT'});
  });
});

test('transient Windows lock errors preserve the old commit until a successful atomic rename', async () => {
  await fixture(async ({committed,pending,before,after}) => {
    const errors = ['EPERM','EBUSY','EACCES'];
    const delays = []; let calls = 0;
    await renameWithRetry(pending, committed, {
      renameImpl:async (source,destination) => {
        assert.equal(source,pending); assert.equal(destination,committed);
        assert.equal(await readFile(committed,'utf8'),before);
        assert.equal(await readFile(pending,'utf8'),after);
        if (calls++ < errors.length) throw failure(errors[calls-1]);
        await rename(source,destination);
      },
      sleepImpl:async delay => {delays.push(delay); assert.equal(await readFile(committed,'utf8'),before);}
    });
    assert.equal(calls,4);
    assert.deepEqual(delays,[25,50,100]);
    assert.equal(await readFile(committed,'utf8'),after);
    await assert.rejects(readFile(pending),{code:'ENOENT'});
  });
});

test('permanent lock failure exhausts a bounded retry budget and leaves both files intact', async () => {
  for (const code of ['EPERM','EBUSY','EACCES']) {
    await fixture(async ({committed,pending,before,after}) => {
      const error=failure(code), delays=[]; let calls=0;
      await assert.rejects(renameWithRetry(pending,committed, {
        renameImpl:async()=>{calls++; throw error;},
        sleepImpl:async delay=>{delays.push(delay);}
      }), actual=>actual===error);
      assert.equal(calls,7);
      assert.deepEqual(delays,[25,50,100,200,400,800]);
      assert.equal(delays.reduce((sum,n)=>sum+n,0),1575);
      assert.equal(await readFile(committed,'utf8'),before);
      assert.equal(await readFile(pending,'utf8'),after);
    });
  }
  assert.ok(Object.isFrozen(RENAME_RETRY_DELAYS_MS));
});

test('terminal errors fail immediately without a retry or a destructive fallback', async () => {
  for (const code of ['ENOENT','EIO','EXDEV','ENOSPC',undefined]) {
    await fixture(async ({committed,pending,before,after}) => {
      const error=failure(code); let calls=0;
      await assert.rejects(renameWithRetry(pending,committed, {
        renameImpl:async()=>{calls++; throw error;},
        sleepImpl:async()=>assert.fail('Terminal errors must not retry')
      }),actual=>actual===error);
      assert.equal(calls,1);
      assert.equal(await readFile(committed,'utf8'),before);
      assert.equal(await readFile(pending,'utf8'),after);
    });
  }
});

test('a terminal error after a transient lock stops further retries and preserves the committed checkpoint', async () => {
  await fixture(async ({committed,pending,before,after}) => {
    const terminal=failure('EIO'), delays=[]; let calls=0;
    await assert.rejects(renameWithRetry(pending,committed, {
      renameImpl:async()=>{if(calls++===0)throw failure('EPERM');throw terminal;},
      sleepImpl:async delay=>delays.push(delay)
    }),actual=>actual===terminal);
    assert.equal(calls,2); assert.deepEqual(delays,[25]);
    assert.equal(await readFile(committed,'utf8'),before);
    assert.equal(await readFile(pending,'utf8'),after);
  });
});
