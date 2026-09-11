import {makeState, step, snapshot, DT} from './model.js';

export const SAMPLE_EVERY_STEPS = 5;
export const RECORDING_WINDOW_SECONDS = 60;
export const MAX_SAMPLES = Math.round(RECORDING_WINDOW_SECONDS / (DT * SAMPLE_EVERY_STEPS));

/** A browser session clock. Visibility suspension never changes user pause intent. */
export class ModelSession {
  constructor(config) {
    this.paused = false;
    this.hidden = false;
    this.restart(config);
  }

  get running() {
    return !this.paused && !this.hidden;
  }

  setPaused(value) {
    this.paused = Boolean(value);
    this.accumulator = 0;
  }

  setHidden(value) {
    this.hidden = Boolean(value);
    this.accumulator = 0;
  }

  restart(config = this.state?.config) {
    this.state = makeState(config);
    this.samples = [];
    this.steps = 0;
    this.accumulator = 0;
  }

  advance(elapsedSeconds) {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError('Elapsed time must be finite and non-negative');
    }
    if (!this.running) return;
    // Slow frames slow model time; never jump the state to match wall time.
    this.accumulator += Math.min(0.1, elapsedSeconds);
    while (this.accumulator + 1e-12 >= DT) {
      step(this.state);
      this.steps++;
      this.accumulator = Math.max(0, this.accumulator - DT);
      if (this.steps % SAMPLE_EVERY_STEPS === 0) {
        this.samples.push(snapshot(this.state));
        if (this.samples.length > MAX_SAMPLES) this.samples.shift();
      }
    }
  }

  recordingWindow() {
    return {
      mode: 'rolling',
      windowSeconds: RECORDING_WINDOW_SECONDS,
      capacitySamples: MAX_SAMPLES,
      retainedSamples: this.samples.length,
      startTimeSeconds: this.samples[0]?.t ?? null,
      endTimeSeconds: this.samples.at(-1)?.t ?? null,
    };
  }
}
