// Listening check: settle by ear how the BTR15 shapes a filter, without a
// measurement rig.
//
// The device is given one strong cut. The browser plays pink noise through
// the exact inverse of what each hypothesis says the device realises. If a
// hypothesis is right, its inverse cancels the device's filter and you hear
// plain noise, identical to the reference. If it is wrong, a coloured residual
// is left: about 3.5 dB for the peak test, 2 dB for the shelf test.
//
// The browser filters are exact cookbook biquads (IIRFilterNode) at the
// AudioContext's sample rate.

import { biquad, rbjA, shelfSlopeToQ } from './dsp.js';

export const LISTEN_TESTS = {
  peak: {
    id: 'peak',
    title: 'Peaking filter width',
    law: 'peak',
    device: { type: 'PK', freq: 1000, gain: -12, q: 2 },
    hypotheses: [
      { id: 'standard', value: 'standard', label: 'Standard: the BTR15 builds the filter it is sent', inverse: { type: 'PK', freq: 1000, gain: 12, q: 2 } },
      { id: 'gainWidening', value: 'widen', label: 'Widened: Q comes out divided by A (≈2 at 12 dB)', inverse: { type: 'PK', freq: 1000, gain: 12, q: 2 / rbjA(12) } },
    ],
  },
  shelf: {
    id: 'shelf',
    title: 'Low-shelf convention',
    law: 'shelf',
    device: { type: 'LS', freq: 250, gain: -12, q: 1 },
    hypotheses: [
      { id: 'qForm', value: 'q', label: 'Q form (cookbook Q, as AutoEQ and FiiO\'s app draw it)', inverse: { type: 'LS', freq: 250, gain: 12, q: 1 } },
      { id: 'slopeForm', value: 'slope', label: 'Slope form (the number is treated as shelf slope S)', inverse: { type: 'LS', freq: 250, gain: 12, q: shelfSlopeToQ(1, 12) } },
    ],
  },
};

export class NoiseEngine {
  constructor() {
    this.ctx = null;
    this.src = null;
    this.out = null;
    this.filter = null;
    this.level = 0.5;
  }

  get sampleRate() { return this.ctx?.sampleRate ?? null; }

  // Call synchronously from a click so the browser lets audio start.
  unlock() {
    if (!this.ctx) this._create();
    this.ctx.resume();
  }

  _create() {
    this.ctx = new AudioContext();
    this.out = this.ctx.createGain();
    this.out.gain.value = 0;
    this.out.connect(this.ctx.destination);
    this.buffer = pinkNoise(this.ctx, 8);
  }

  async start() {
    if (!this.ctx) this._create();
    await this.ctx.resume();
    if (!this.src) {
      this.src = this.ctx.createBufferSource();
      this.src.buffer = this.buffer;
      this.src.loop = true;
      this._wire();
      this.src.start();
    }
    this._ramp(this.level);
  }

  setLevel(v) { this.level = v; if (this.src) this._ramp(v); }

  // filter: null for none, or a cookbook filter object. `whileMuted` runs
  // between the fade-out and fade-in (used to change the device's band).
  async setFilter(filter, whileMuted) {
    if (!this.ctx) { this.filterSpec = filter; await whileMuted?.(); return; }
    if (this.src) { this._ramp(0, 0.03); await wait(40); }
    try {
      await whileMuted?.();
    } finally {
      this.filterSpec = filter;
      this._wire();
      if (this.src) this._ramp(this.level, 0.03);
    }
  }

  _wire() {
    const spec = this.filterSpec ?? null;
    this.src?.disconnect();
    this.filter?.disconnect();
    this.filter = null;
    if (spec) {
      const c = biquad(spec.type, spec.freq, spec.gain, spec.q, this.ctx.sampleRate);
      this.filter = this.ctx.createIIRFilter([c.b0, c.b1, c.b2], [c.a0, c.a1, c.a2]);
      this.filter.connect(this.out);
      this.src?.connect(this.filter);
    } else {
      this.src?.connect(this.out);
    }
  }

  _ramp(v, t = 0.05) {
    const g = this.out.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(v, now + t);
  }

  async stop() {
    if (!this.src) return;
    this._ramp(0, 0.05);
    await wait(60);
    try { this.src.stop(); } catch { /* already stopped */ }
    this.src.disconnect();
    this.src = null;
  }
}

// Pink noise (Paul Kellet's filter on white noise), normalised to about
// -26 dBFS RMS so a +12 dB browser boost stays far from clipping.
function pinkNoise(ctx, seconds) {
  const n = Math.round(ctx.sampleRate * seconds);
  const fade = Math.round(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const raw = new Float32Array(n + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    let sum = 0;
    for (let i = 0; i < n + fade; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
      const v = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      raw[i] = v; sum += v * v;
    }
    const k = Math.pow(10, -26 / 20) / Math.sqrt(sum / (n + fade));
    const d = buf.getChannelData(ch);
    // Equal-power crossfade of the tail into the head makes the loop seamless.
    for (let i = 0; i < n; i++) {
      let v = raw[i];
      if (i < fade) {
        const t = (i + 0.5) / fade;
        v = raw[i] * Math.sin(t * Math.PI / 2) + raw[n + i] * Math.cos(t * Math.PI / 2);
      }
      d[i] = v * k;
    }
  }
  return buf;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
