// Auto-EQ: fit a handful of parametric filters to a target curve.
//
// The fit works in the device's own units: it searches over the values that
// will be SENT (frequency, gain, Q, type) inside the device's limits, and
// scores the response the device is modelled to REALISE from them. With the
// "standard" model these are the same thing; with the gain-widening model the
// fit chooses sent Q values the device will widen into the shape you asked for,
// and it can never pick a Q the device cannot store.
//
// Method: greedy placement on the residual (peak/dip or shelf candidates),
// then bounded Levenberg-Marquardt on all bands plus the global gain, a few
// perturbed restarts, and finally rounding to the device's step sizes.

import { FreqGrid, biquad, biquadDb, bandwidthToQ, getModel } from './dsp.js';
import { sampleCurve } from './formats.js';

export const BTR15_LIMITS = {
  bands: 10,
  freq: [20, 20000],
  gain: [-12, 12],
  q: [0.25, 8],
  globalGain: [-12, 12],
  types: ['PK', 'LS', 'HS'],
  freqStep: 1, gainStep: 0.1, qStep: 0.01, globalGainStep: 0.1,
};

const DEFAULTS = {
  bands: 10,
  types: ['PK', 'LS', 'HS'],
  model: 'standard',
  fmin: 20,
  fmax: 20000,
  trebleFrom: 10000,
  trebleWeight: 0.5,
  preventClipping: true,
  // Keep the filters' own sum at or below 0 dB, so nothing can clip even if
  // the device applies the global gain after the filters rather than before.
  chainHeadroom: true,
  restarts: 6,
  seed: 1,
  fs: 48000,
  pointsPerOctave: 32,
  limits: BTR15_LIMITS,
};

export function fitPeq(targetPoints, opts = {}) {
  const o = { ...DEFAULTS, ...opts, limits: { ...BTR15_LIMITS, ...(opts.limits ?? {}) } };
  const model = getModel(o.model);
  const L = o.limits;
  const grid = new FreqGrid({ fmin: o.fmin, fmax: o.fmax, pointsPerOctave: o.pointsPerOctave, fs: o.fs });
  const target = sampleCurve(targetPoints, grid.f);
  const w = new Float64Array(grid.n);
  for (let i = 0; i < grid.n; i++) w[i] = grid.f[i] > o.trebleFrom ? o.trebleWeight : 1;
  const sw = Float64Array.from(w, Math.sqrt);
  const wsum = w.reduce((a, b) => a + b, 0);

  const lo = { lf: Math.log(L.freq[0]), g: L.gain[0], lq: Math.log(L.q[0]) };
  const hi = { lf: Math.log(L.freq[1]), g: L.gain[1], lq: Math.log(L.q[1]) };

  // Band response for SENT parameters, as the model says the device realises it.
  const bandDb = (b, out) => {
    const f = Math.exp(b.lf);
    const q = Math.exp(b.lq);
    if (Math.abs(b.g) < 1e-9) return (out ?? new Float64Array(grid.n)).fill(0);
    const real = model.toRealised({ type: b.type, freq: f, gain: b.g, q });
    return biquadDb(biquad(b.type, f, b.g, real.q, grid.fs), grid, out);
  };

  const clampBand = (b) => {
    b.lf = Math.min(hi.lf, Math.max(lo.lf, b.lf));
    b.g = Math.min(hi.g, Math.max(lo.g, b.g));
    b.lq = Math.min(hi.lq, Math.max(lo.lq, b.lq));
    return b;
  };
  const clampG = (g) => Math.min(L.globalGain[1], Math.max(L.globalGain[0], g));

  const sumResp = (bands, G, cache) => {
    const r = new Float64Array(grid.n).fill(G);
    bands.forEach((b, i) => {
      const h = cache?.[i] ?? bandDb(b);
      for (let k = 0; k < grid.n; k++) r[k] += h[k];
    });
    return r;
  };
  const costOf = (resp) => {
    let s = 0;
    for (let k = 0; k < grid.n; k++) { const e = resp[k] - target[k]; s += w[k] * e * e; }
    return s / wsum;
  };

  // ── Levenberg-Marquardt over a subset of bands (+ global gain) ────────────
  const REG_GAIN = 1e-4; // tiny pull towards 0 dB so unused bands don't fight
  const MU = o.chainHeadroom ? 10 : 0;
  const chainPenalty = (rs, g) => {
    if (!MU) return 0;
    let s = 0;
    for (let k = 0; k < grid.n; k++) { const over = rs[k] - g; if (over > 0) s += over * over; }
    return MU * s / wsum;
  };
  function lm(bands, G, { active = bands.map((_, i) => i), iters = 60 } = {}) {
    let cache = bands.map((b) => bandDb(b));
    let resp = sumResp(bands, G, cache);
    const totalCost = (rs, bs, g) => costOf(rs) + REG_GAIN * bs.reduce((a, b) => a + b.g * b.g, 0) + chainPenalty(rs, g);
    let cost = totalCost(resp, bands, G);
    let lambda = 1e-2;
    const P = active.length * 3 + 1;
    const m = grid.n;
    const J = new Float64Array(m * P);
    const D = new Float64Array(m * P);
    let stall = 0;
    for (let it = 0; it < iters; it++) {
      // Jacobian of sqrt(w)*(resp - target) with respect to each parameter.
      let col = 0;
      for (const bi of active) {
        const b = bands[bi];
        for (const key of ['lf', 'g', 'lq']) {
          const h = key === 'g' ? 0.01 : 1e-3;
          const save = b[key];
          let step = h;
          if (b[key] + step > hi[key]) step = -h;
          b[key] = save + step;
          const hb = bandDb(b);
          b[key] = save;
          const base = cache[bi];
          for (let k = 0; k < m; k++) {
            const d = (hb[k] - base[k]) / step;
            D[k * P + col] = d;
            J[k * P + col] = sw[k] * d;
          }
          col++;
        }
      }
      for (let k = 0; k < m; k++) J[k * P + col] = sw[k];
      // Normal equations.
      const A = new Float64Array(P * P);
      const gvec = new Float64Array(P);
      for (let k = 0; k < m; k++) {
        const e = sw[k] * (resp[k] - target[k]);
        const row = k * P;
        for (let a = 0; a < P; a++) {
          const ja = J[row + a];
          if (ja === 0) continue;
          gvec[a] += ja * e;
          for (let c = a; c < P; c++) A[a * P + c] += ja * J[row + c];
        }
      }
      if (MU > 0) {
        // Chain-headroom penalty: residual sqrt(MU) * max(0, filterSum).
        for (let k = 0; k < m; k++) {
          const over = resp[k] - G;
          if (over <= 0) continue;
          const row = k * P;
          for (let a = 0; a < P - 1; a++) {
            const da = D[row + a];
            if (da === 0) continue;
            gvec[a] += MU * da * over;
            for (let c = a; c < P - 1; c++) A[a * P + c] += MU * da * D[row + c];
          }
        }
      }
      for (let a = 0; a < P; a++) for (let c = 0; c < a; c++) A[a * P + c] = A[c * P + a];
      // Scale to match cost normalisation and add the gain regulariser.
      for (let a = 0; a < P * P; a++) A[a] /= wsum;
      for (let a = 0; a < P; a++) gvec[a] /= wsum;
      active.forEach((bi, j) => { A[(j * 3 + 1) * P + j * 3 + 1] += REG_GAIN; gvec[j * 3 + 1] += REG_GAIN * bands[bi].g; });

      let improved = false;
      for (let tries = 0; tries < 8; tries++) {
        const M = A.slice();
        for (let a = 0; a < P; a++) M[a * P + a] += lambda * (A[a * P + a] + 1e-9);
        const delta = solve(M, gvec.map((x) => -x), P);
        if (!delta) { lambda *= 10; continue; }
        const nb = bands.map((b) => ({ ...b }));
        active.forEach((bi, j) => {
          nb[bi].lf += delta[j * 3]; nb[bi].g += delta[j * 3 + 1]; nb[bi].lq += delta[j * 3 + 2];
          clampBand(nb[bi]);
        });
        const nG = clampG(G + delta[P - 1]);
        const ncache = cache.slice();
        for (const bi of active) ncache[bi] = bandDb(nb[bi]);
        const nresp = sumResp(nb, nG, ncache);
        const ncost = totalCost(nresp, nb, nG);
        if (ncost < cost) {
          const rel = (cost - ncost) / Math.max(cost, 1e-12);
          bands = nb; G = nG; cache = ncache; resp = nresp; cost = ncost;
          lambda = Math.max(lambda / 3, 1e-7);
          improved = true;
          stall = rel < 1e-6 ? stall + 1 : 0;
          break;
        }
        lambda *= 4;
      }
      if (!improved || stall >= 3) break;
    }
    return { bands, G, cost: costOf(resp), resp };
  }

  // ── Greedy initialisation ─────────────────────────────────────────────────
  const smooth = (arr, halfOct) => {
    const out = new Float64Array(arr.length);
    const span = Math.max(1, Math.round(halfOct * o.pointsPerOctave));
    for (let i = 0; i < arr.length; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - span); j <= Math.min(arr.length - 1, i + span); j++) { s += arr[j]; c++; }
      out[i] = s / c;
    }
    return out;
  };

  const median = (vals) => { const s = [...vals].sort((a, b) => a - b); return s[s.length >> 1]; };
  const mid = [];
  for (let i = 0; i < grid.n; i++) if (grid.f[i] >= 100 && grid.f[i] <= 10000) mid.push(target[i]);
  let G = clampG(median(mid.length ? mid : target));
  let bands = [];

  const candidatesFor = (resid) => {
    const out = [];
    const rs = smooth(resid, 1 / 12);
    let best = -1, bestV = 0;
    for (let i = 0; i < grid.n; i++) { const v = Math.abs(rs[i]) * w[i]; if (v > bestV) { bestV = v; best = i; } }
    if (best >= 0 && o.types.includes('PK')) {
      const g = rs[best];
      const half = g / 2;
      let l = best, r = best;
      while (l > 0 && Math.sign(rs[l]) === Math.sign(g) && Math.abs(rs[l]) > Math.abs(half)) l--;
      while (r < grid.n - 1 && Math.sign(rs[r]) === Math.sign(g) && Math.abs(rs[r]) > Math.abs(half)) r++;
      const bw = Math.max(0.1, Math.log2(grid.f[r] / grid.f[l]));
      out.push({ type: 'PK', lf: Math.log(grid.f[best]), g, lq: Math.log(bandwidthToQ(bw)) });
    }
    const meanWhere = (pred) => { let s = 0, c = 0; for (let i = 0; i < grid.n; i++) if (pred(grid.f[i])) { s += resid[i]; c++; } return c ? s / c : 0; };
    if (o.types.includes('LS')) {
      for (const fc of [40, 80, 150, 300]) if (fc > o.fmin * 1.5) out.push({ type: 'LS', lf: Math.log(fc), g: meanWhere((f) => f < fc), lq: Math.log(0.7) });
    }
    if (o.types.includes('HS')) {
      for (const fc of [3000, 6000, 10000, 15000]) if (fc < o.fmax / 1.3) out.push({ type: 'HS', lf: Math.log(fc), g: meanWhere((f) => f > fc), lq: Math.log(0.7) });
    }
    return out.map(clampBand);
  };

  const addBand = (bands, G) => {
    const resp = sumResp(bands, G);
    const resid = Float64Array.from(target, (t, k) => t - resp[k]);
    let best = null;
    for (const c of candidatesFor(resid)) {
      const trial = [...bands, c];
      const r = lm(trial, G, { active: [trial.length - 1], iters: 25 });
      if (!best || r.cost < best.cost) best = r;
    }
    return best;
  };

  for (let n = 0; n < o.bands; n++) {
    const r = addBand(bands, G);
    if (!r) break;
    ({ bands, G } = lm(r.bands, r.G, { iters: 40 }));
  }
  let best = lm(bands, G, { iters: 150 });

  // Reallocate bands that contribute nothing, then perturbed restarts.
  const rand = mulberry32(o.seed);
  for (let pass = 0; pass < 2; pass++) {
    const weak = best.bands.map((b, i) => [i, Math.abs(b.g)]).filter(([, g]) => g < 0.15).map(([i]) => i);
    if (!weak.length) break;
    let bs = best.bands.filter((_, i) => !weak.includes(i));
    let g = best.G;
    for (let k = 0; k < weak.length; k++) { const r = addBand(bs, g); if (!r) break; ({ bands: bs, G: g } = r); }
    const r = lm(bs, g, { iters: 150 });
    if (r.cost < best.cost) best = r; else break;
  }
  for (let s = 0; s < o.restarts; s++) {
    const bs = best.bands.map((b) => clampBand({
      ...b,
      lf: b.lf + (rand() - 0.5) * 0.3,
      lq: b.lq + (rand() - 0.5) * 0.6,
      g: b.g + (rand() - 0.5) * 1.0,
    }));
    const r = lm(bs, best.G, { iters: 150 });
    if (r.cost < best.cost) best = r;
  }

  // ── Round to the device's steps ───────────────────────────────────────────
  const sent = best.bands.map((b) => quantizeSent({ type: b.type, freq: Math.exp(b.lf), gain: b.g, q: Math.exp(b.lq), enabled: true }, L));
  sent.sort((a, b) => a.freq - b.freq);
  const realised = sent.map((f) => model.toRealised(f));
  let respQ = new Float64Array(grid.n);
  for (const f of realised) biquadDb(biquad(f.type, f.freq, f.gain, f.q, grid.fs), grid, respQ, true);
  // Global gain: weighted least squares on the rounded filters, then headroom.
  let gg = 0;
  for (let k = 0; k < grid.n; k++) gg += w[k] * (target[k] - respQ[k]);
  gg /= wsum;
  if (o.preventClipping) {
    const peak = Math.max(...respQ) + gg;
    if (peak > 0) gg -= peak;
  }
  const globalGain = Math.max(L.globalGain[0], Math.min(L.globalGain[1], Math.floor(gg * 10 + 1e-6) / 10));
  const fitDb = Float64Array.from(respQ, (v) => v + globalGain);

  return {
    sent,
    filters: realised,
    globalGain,
    grid,
    targetDb: target,
    fitDb,
    stats: { ...fitStats(grid, target, fitDb), chainPeak: Math.max(...respQ) },
    model: model.id,
  };
}

export function quantizeSent(f, L = BTR15_LIMITS) {
  const clamp = (x, [a, b]) => Math.min(b, Math.max(a, x));
  const step = (x, s) => Math.round(x / s) * s;
  return {
    type: f.type,
    freq: clamp(Math.round(f.freq), L.freq),
    gain: Number(clamp(step(f.gain, L.gainStep), L.gain).toFixed(1)),
    q: Number(clamp(step(f.q, L.qStep), L.q).toFixed(2)),
    enabled: f.enabled !== false,
  };
}

// Error statistics, unweighted, in dB.
export function fitStats(grid, target, fit) {
  const band = (fa, fb) => {
    let s = 0, c = 0, mx = 0;
    for (let k = 0; k < grid.n; k++) {
      if (grid.f[k] < fa || grid.f[k] > fb) continue;
      const e = fit[k] - target[k];
      s += e * e; c++; mx = Math.max(mx, Math.abs(e));
    }
    return { rms: c ? Math.sqrt(s / c) : 0, max: mx };
  };
  return {
    all: band(0, Infinity),
    bass: band(20, 250),
    mid: band(250, 4000),
    treble: band(4000, 10000),
    air: band(10000, 20000),
    peak: Math.max(...fit),
  };
}

// Small dense solver (Gaussian elimination with partial pivoting).
function solve(A, b, n) {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-14) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) { const t = M[c * n + k]; M[c * n + k] = M[p * n + k]; M[p * n + k] = t; }
      const t = x[c]; x[c] = x[p]; x[p] = t;
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (!f) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Measurement + target -> EQ curve (AutoEQ-style, deliberately simple) ────
// eq = target - measurement, aligned so the two agree on average over
// 200 Hz - 2 kHz, smoothed, with boosts limited. Treble above `trebleFrom` is
// smoothed harder because measurements there are unreliable.
export function equalizationCurve(measurement, target, {
  maxBoost = 6, maxCut = 12, smoothingOct = 1 / 6, trebleFrom = 8000, trebleSmoothingOct = 1, pointsPerOctave = 48,
} = {}) {
  const grid = new FreqGrid({ fmin: 20, fmax: 20000, pointsPerOctave });
  const m = sampleCurve(measurement, grid.f);
  const t = sampleCurve(target, grid.f);
  let off = 0, c = 0;
  for (let k = 0; k < grid.n; k++) if (grid.f[k] >= 200 && grid.f[k] <= 2000) { off += t[k] - m[k]; c++; }
  off /= c || 1;
  const raw = Float64Array.from(m, (v, k) => t[k] - v - off);
  const out = new Float64Array(grid.n);
  for (let k = 0; k < grid.n; k++) {
    const oct = grid.f[k] > trebleFrom ? trebleSmoothingOct : smoothingOct;
    const span = Math.max(0, Math.round(oct * pointsPerOctave / 2));
    let s = 0, cnt = 0;
    for (let j = Math.max(0, k - span); j <= Math.min(grid.n - 1, k + span); j++) { s += raw[j]; cnt++; }
    out[k] = Math.max(-maxCut, Math.min(maxBoost, s / cnt));
  }
  const mx = Math.max(...out);
  return Array.from(grid.f, (f, k) => [f, out[k] - Math.max(0, mx)]);
}
