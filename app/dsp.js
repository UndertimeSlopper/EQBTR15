// Biquad maths for parametric EQ.
//
// Filters are RBJ "Audio EQ Cookbook" biquads. Shelves take the cookbook's
// Q form (alpha = sin(w0) / 2Q, with the 2*sqrt(A)*alpha term), which is the
// convention AutoEQ, Equalizer APO's LSC/HSC and FiiO's own web app all use.
//
// A filter is a plain object: { type: 'PK' | 'LS' | 'HS', freq, gain, q, enabled }.

export const DEFAULT_FS = 48000;
export const FILTER_TYPES = ['PK', 'LS', 'HS'];

// RBJ amplitude: A = 10^(gain/40).
export function rbjA(gainDb) {
  return Math.pow(10, gainDb / 40);
}

export function biquad(type, freq, gainDb, q, fs = DEFAULT_FS) {
  const A = rbjA(gainDb);
  const w0 = 2 * Math.PI * freq / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * (q > 0 ? q : 1));
  switch (type) {
    case 'PK':
      return {
        b0: 1 + alpha * A, b1: -2 * cw, b2: 1 - alpha * A,
        a0: 1 + alpha / A, a1: -2 * cw, a2: 1 - alpha / A,
      };
    case 'LS': {
      const k = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * ((A + 1) - (A - 1) * cw + k),
        b1: 2 * A * ((A - 1) - (A + 1) * cw),
        b2: A * ((A + 1) - (A - 1) * cw - k),
        a0: (A + 1) + (A - 1) * cw + k,
        a1: -2 * ((A - 1) + (A + 1) * cw),
        a2: (A + 1) + (A - 1) * cw - k,
      };
    }
    case 'HS': {
      const k = 2 * Math.sqrt(A) * alpha;
      return {
        b0: A * ((A + 1) + (A - 1) * cw + k),
        b1: -2 * A * ((A - 1) + (A + 1) * cw),
        b2: A * ((A + 1) + (A - 1) * cw - k),
        a0: (A + 1) - (A - 1) * cw + k,
        a1: 2 * ((A - 1) - (A + 1) * cw),
        a2: (A + 1) - (A - 1) * cw - k,
      };
    }
    default:
      throw new Error(`Unsupported filter type ${type}`);
  }
}

// Shelf slope S <-> Q (cookbook: 1/Q = sqrt((A + 1/A)(1/S - 1) + 2)).
export function shelfSlopeToQ(S, gainDb) {
  const A = rbjA(gainDb);
  const v = (A + 1 / A) * (1 / S - 1) + 2;
  return v > 0 ? 1 / Math.sqrt(v) : null;
}
export function shelfQToSlope(q, gainDb) {
  const A = rbjA(gainDb);
  const d = 1 + (1 / (q * q) - 2) / (A + 1 / A);
  return d > 0 ? 1 / d : null;
}

// Peaking bandwidth in octaves -> Q.
export function bandwidthToQ(bwOct) {
  const p = Math.pow(2, bwOct);
  return Math.sqrt(p) / (p - 1);
}

// A logarithmic frequency grid with cached cos(w) and cos(2w), so magnitude
// responses can be evaluated without complex arithmetic.
export class FreqGrid {
  constructor({ fmin = 20, fmax = 20000, pointsPerOctave = 48, fs = DEFAULT_FS, freqs = null } = {}) {
    if (freqs) {
      this.f = Float64Array.from(freqs);
    } else {
      const n = Math.max(2, Math.round(Math.log2(fmax / fmin) * pointsPerOctave) + 1);
      this.f = new Float64Array(n);
      const step = Math.log(fmax / fmin) / (n - 1);
      for (let i = 0; i < n; i++) this.f[i] = fmin * Math.exp(step * i);
    }
    this.fs = fs;
    this.n = this.f.length;
    this.c1 = new Float64Array(this.n);
    this.c2 = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const w = 2 * Math.PI * this.f[i] / fs;
      this.c1[i] = Math.cos(w);
      this.c2[i] = Math.cos(2 * w);
    }
  }
}

// Magnitude response in dB of one biquad over a grid. Writes into `out` if given.
export function biquadDb(c, grid, out = new Float64Array(grid.n), add = false) {
  const nb0 = c.b0 * c.b0 + c.b1 * c.b1 + c.b2 * c.b2;
  const nb1 = 2 * (c.b0 * c.b1 + c.b1 * c.b2);
  const nb2 = 2 * c.b0 * c.b2;
  const na0 = c.a0 * c.a0 + c.a1 * c.a1 + c.a2 * c.a2;
  const na1 = 2 * (c.a0 * c.a1 + c.a1 * c.a2);
  const na2 = 2 * c.a0 * c.a2;
  const { c1, c2, n } = grid;
  for (let i = 0; i < n; i++) {
    const num = nb0 + nb1 * c1[i] + nb2 * c2[i];
    const den = na0 + na1 * c1[i] + na2 * c2[i];
    const db = 10 * Math.log10(Math.max(num, 1e-30) / Math.max(den, 1e-30));
    out[i] = add ? out[i] + db : db;
  }
  return out;
}

export function filterDb(filter, grid, out, add = false) {
  if (filter.enabled === false || !filter.gain) {
    if (!add) (out ??= new Float64Array(grid.n)).fill(0);
    return out ?? new Float64Array(grid.n);
  }
  return biquadDb(biquad(filter.type, filter.freq, filter.gain, filter.q, grid.fs), grid, out, add);
}

// Sum of filters plus a flat gain, in dB.
export function responseDb(filters, grid, globalGain = 0) {
  const out = new Float64Array(grid.n).fill(globalGain);
  for (const f of filters) filterDb(f, grid, out, true);
  return out;
}

// Evaluate the summed response at arbitrary frequencies.
export function responseAt(filters, freqs, globalGain = 0, fs = DEFAULT_FS) {
  return responseDb(filters, new FreqGrid({ freqs, fs }), globalGain);
}

// ── Device models ───────────────────────────────────────────────────────────
// What the device realises for the numbers it is sent. A model maps an
// INTENDED filter (what you want to hear, cookbook definitions) to the values
// to SEND, and sent values back to what is realised. Two independent laws:
//
//  peak  'standard'  the device builds the peaking filter it is sent.
//        'widen'     FiiO/Fosi behaviour measured by devicePEQ on QX13, KA17
//                    and DS3: Q_realised = Q_sent / A, A = 10^(|gain|/40).
//  shelf 'q'         the number sent is the cookbook shelf Q (FiiO's own app
//                    draws shelves this way, and devicePEQ's shelf data fit it).
//        'slope'     the number sent is treated as shelf slope S.
//
// Model ids: 'standard', 'gainWidening' (= widen + q), or 'peak+shelf' such as
// 'widen+slope'. None of this is verified on the BTR15; the listening check
// exists to settle it.

const PEAK_LAWS = {
  standard: { toSent: (q) => q, toRealised: (q) => q },
  widen: { toSent: (q, g) => q * rbjA(Math.abs(g)), toRealised: (q, g) => q / rbjA(Math.abs(g)) },
};
const SHELF_LAWS = {
  q: { toSent: (q) => q, toRealised: (q) => q },
  slope: {
    toSent: (q, g) => shelfQToSlope(q, g) ?? 8,
    toRealised: (s, g) => shelfSlopeToQ(s, g) ?? 0.2,
  },
};

export function parseModelId(id = 'standard') {
  if (id === 'standard') return { peak: 'standard', shelf: 'q' };
  if (id === 'gainWidening') return { peak: 'widen', shelf: 'q' };
  const [peak, shelf] = String(id).split('+');
  return { peak: PEAK_LAWS[peak] ? peak : 'standard', shelf: SHELF_LAWS[shelf] ? shelf : 'q' };
}

export function modelId({ peak, shelf }) {
  if (shelf === 'q') return peak === 'widen' ? 'gainWidening' : 'standard';
  return `${peak}+${shelf}`;
}

export function getModel(id) {
  const { peak, shelf } = parseModelId(id);
  const P = PEAK_LAWS[peak];
  const S = SHELF_LAWS[shelf];
  const map = (fn) => (f) => {
    if (f.type === 'PK') return { ...f, q: P[fn](f.q, f.gain) };
    if (f.type === 'LS' || f.type === 'HS') return { ...f, q: S[fn](f.q, f.gain) };
    return { ...f };
  };
  return {
    id: modelId({ peak, shelf }), peak, shelf,
    isIdentity: peak === 'standard' && shelf === 'q',
    toSent: map('toSent'),
    toRealised: map('toRealised'),
  };
}
