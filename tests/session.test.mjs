import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelSession, MAX_SAMPLES} from '../dist/lib/session.js';
import {experiment, snapshot} from '../dist/lib/model.js';

const config = {mode:'moving-dot', intensity:0.7};

test('A new session advances without a start action', () => {
  const session = new ModelSession(config);
  assert.equal(session.running, true);
  session.advance(0.1);
  assert.equal(session.steps, 5);
  assert.equal(session.samples.length, 1);
  assert.ok(session.state.rates.some(rate => rate > 0));
});

test('Ten minutes continue without a reset and retain only the recent recording', () => {
  const session = new ModelSession(config);
  for (let i = 0; i < 6000; i++) session.advance(0.1);
  assert.equal(session.running, true);
  assert.equal(session.steps, 30000);
  assert.ok(Math.abs(session.state.time - 600) < 1e-6);
  assert.equal(session.samples.length, MAX_SAMPLES);
  assert.equal(session.samples[0].t, 540.1);
  assert.equal(session.samples.at(-1).t, 600);
  assert.ok(session.samples.every((s, i, all) => i === 0 || Math.abs(s.t - all[i-1].t - 0.1) < 1e-9));
  assert.ok(session.state.rates.every(rate => Number.isFinite(rate) && rate >= 0 && rate <= 1));
  assert.deepEqual(session.recordingWindow(), {
    mode:'rolling', windowSeconds:60, capacitySamples:600, retainedSamples:600,
    startTimeSeconds:540.1, endTimeSeconds:600,
  });
});

test('Visibility suspension resumes automatically but preserves a manual pause', () => {
  const session = new ModelSession(config);
  session.setHidden(true);
  session.advance(30);
  assert.equal(session.steps, 0);
  session.setHidden(false);
  session.advance(0.1);
  assert.equal(session.steps, 5);
  session.setPaused(true);
  session.setHidden(true);
  session.setHidden(false);
  session.advance(30);
  assert.equal(session.running, false);
  assert.equal(session.steps, 5);
  session.setPaused(false);
  session.advance(0.1);
  assert.deepEqual(snapshot(session.state), snapshot(experiment(config,0.2)));
});

test('Restart clears history while preserving run intent and the chosen protocol', () => {
  const session = new ModelSession(config);
  session.advance(0.1);
  session.restart();
  assert.equal(session.running, true);
  assert.equal(session.steps, 0);
  assert.equal(session.samples.length, 0);
  session.setPaused(true);
  session.restart({mode:'dark', intensity:1});
  assert.equal(session.paused, true);
  assert.equal(session.recordingWindow().startTimeSeconds, null);
  session.setPaused(false);
  for (let i = 0; i < 100; i++) session.advance(0.1);
  assert.equal(session.state.distance, 0);
  assert.equal(session.state.config.mode, 'dark');
});

test('Slow frames preserve small fixed steps instead of catching up wall time', () => {
  const session = new ModelSession(config);
  session.advance(10);
  assert.equal(session.steps, 5);
  assert.deepEqual(snapshot(session.state), snapshot(experiment(config,0.1)));
  for (const invalid of [-1, NaN, Infinity]) assert.throws(() => session.advance(invalid), RangeError);
});
