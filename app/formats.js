// Import and export of EQ files.
//
// Recognised inputs:
//   - AutoEQ / Equalizer APO GraphicEQ   "GraphicEQ: 20 -8.3; 21 -8.2; ..."
//   - Equalizer APO / AutoEQ ParametricEQ "Preamp: -6 dB" + "Filter 1: ON PK Fc 105 Hz Gain 2 dB Q 0.7"
//   - AutoEQ results CSV                  header with an "equalization" column
//   - Any two-column text or CSV          frequency, dB (REW, squig.link, etc.)
//   - This app's own JSON preset          {"format":"eqbtr15-preset", ...}
//
// Results are either { kind: 'curve', points: [[f, dB], ...] } or
// { kind: 'peq', filters: [...], preamp }. Every result carries `warnings`.

import { bandwidthToQ, shelfSlopeToQ } from './dsp.js';

export function parseEqText(text, filename = '') {
  const src = String(text ?? '').replace(/^﻿/, '');
  const trimmed = src.trim();
  if (!trimmed) throw new Error('The file is empty.');

  if (trimmed.startsWith('{')) return parsePresetJson(trimmed);
  if (/^\s*GraphicEQ\s*:/im.test(src)) return parseGraphicEq(src);
  if (/^\s*(Filter\s*\d*\s*:|Preamp\s*:)/im.test(src)) return parseParametric(src);
  return parseCurveTable(src, filename);
}

// ── GraphicEQ ───────────────────────────────────────────────────────────────
export function parseGraphicEq(text) {
  const m = /GraphicEQ\s*:\s*([^\r\n]*)/i.exec(text);
  if (!m) throw new Error('No "GraphicEQ:" line found.');
  const points = [];
  const warnings = [];
  for (const part of m[1].split(';')) {
    const s = part.trim();
    if (!s) continue;
    const nums = s.split(/[\s,]+/).map(Number);
    if (nums.length < 2 || !nums.slice(0, 2).every(Number.isFinite)) {
      warnings.push(`Skipped unreadable GraphicEQ entry "${s}".`);
      continue;
    }
    points.push([nums[0], nums[1]]);
  }
  return { kind: 'curve', source: 'GraphicEQ', points: cleanPoints(points, warnings), warnings };
}

// ── Equalizer APO parametric ────────────────────────────────────────────────
const TYPE_MAP = {
  PK: 'PK', PEQ: 'PK', PEAK: 'PK', MODAL: 'PK',
  LSC: 'LS', LSQ: 'LS', LS: 'LS', LOWSHELF: 'LS',
  HSC: 'HS', HSQ: 'HS', HS: 'HS', HIGHSHELF: 'HS',
};

export function parseParametric(text) {
  const filters = [];
  const warnings = [];
  let preamp = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const pre = /^Preamp\s*:\s*([-+]?\d*\.?\d+)\s*dB/i.exec(line);
    if (pre) { preamp += Number(pre[1]); continue; }
    const fm = /^Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Z]+)(?:\s+(\d+)\s*dB)?\s*(.*)$/i.exec(line);
    if (!fm) {
      if (/^(Device|Channel|Include|Stage|Copy|Delay|Convolution|Eval|If|ElseIf|Else|EndIf)\s*:/i.test(line)) {
        warnings.push(`Ignored Equalizer APO command: "${line}".`);
      }
      continue;
    }
    const on = fm[1].toUpperCase() === 'ON';
    const rawType = fm[2].toUpperCase();
    const type = TYPE_MAP[rawType];
    const rest = fm[4];
    const fc = num(/Fc\s+([-+]?\d*\.?\d+)\s*Hz/i, rest);
    const gain = num(/Gain\s+([-+]?\d*\.?\d+)\s*dB/i, rest) ?? 0;
    let q = num(/\bQ\s+([-+]?\d*\.?\d+)/i, rest);
    const bw = num(/BW\s+Oct\s+([-+]?\d*\.?\d+)/i, rest);
    const slope = num(/\bS\s+([-+]?\d*\.?\d+)/i, rest);
    if (!type) {
      warnings.push(`Skipped unsupported filter type ${rawType} (the BTR15 only has peak, low shelf and high shelf): "${line}".`);
      continue;
    }
    if (fc == null) { warnings.push(`Skipped filter without a frequency: "${line}".`); continue; }
    if (q == null && bw != null && type === 'PK') q = bandwidthToQ(bw);
    if (q == null && slope != null && type !== 'PK') q = shelfSlopeToQ(slope, gain);
    if (q == null) {
      if (fm[3]) warnings.push(`"${line}" uses a fixed-slope shelf; approximated with Q 0.707.`);
      else if (type !== 'PK') warnings.push(`"${line}" has no Q; assumed 0.707.`);
      else warnings.push(`"${line}" has no Q; assumed 1.0.`);
      q = type === 'PK' ? 1 : 0.707;
    }
    if (rawType === 'LS' || rawType === 'HS') {
      warnings.push(`"${rawType}" in Equalizer APO is defined by its corner frequency; this app treats Fc as the shelf midpoint (as LSC/HSC do). Check the shelf position.`);
    }
    filters.push({ type, freq: fc, gain, q, enabled: on });
  }
  if (!filters.length) throw new Error('No usable filters found in the parametric EQ file.');
  return { kind: 'peq', source: 'ParametricEQ', filters, preamp, warnings: dedupe(warnings) };
}

function num(re, s) {
  const m = re.exec(s);
  return m ? Number(m[1]) : null;
}

// ── Tables: AutoEQ CSV or two-column frequency/dB ───────────────────────────
export function parseCurveTable(text, filename = '') {
  const warnings = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[#*;]/.test(l));
  let header = null;
  let col = 1;
  const points = [];
  for (const line of lines) {
    const cells = line.split(/\s*[,;\t]\s*|\s+/).filter((c) => c !== '');
    const nums = cells.map(Number);
    if (!nums.every(Number.isFinite)) {
      if (!header && !points.length) {
        header = cells.map((c) => c.toLowerCase());
        const eq = header.indexOf('equalization');
        if (eq > 0) col = eq;
        else if (header.length > 1) col = 1;
      }
      continue;
    }
    if (nums.length < 2) continue;
    points.push([nums[0], nums[col] ?? nums[1]]);
  }
  if (points.length < 2) {
    throw new Error(`Could not read ${filename || 'this file'}: expected GraphicEQ, ParametricEQ, or columns of frequency and dB.`);
  }
  const source = header && header.includes('equalization') ? 'AutoEQ CSV (equalization column)'
    : header ? `Table (column "${header[col] ?? col + 1}")` : 'Frequency/dB table';
  return { kind: 'curve', source, points: cleanPoints(points, warnings), warnings };
}

function cleanPoints(points, warnings) {
  const ok = points.filter(([f, g]) => f > 0 && Number.isFinite(g));
  if (ok.length !== points.length) warnings.push('Dropped points with non-positive frequency.');
  ok.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const p of ok) {
    if (out.length && Math.abs(out[out.length - 1][0] - p[0]) < 1e-9) out[out.length - 1] = p;
    else out.push(p);
  }
  if (out.length < 2) throw new Error('A curve needs at least two points.');
  return out;
}

// ── Preset JSON ─────────────────────────────────────────────────────────────
export function parsePresetJson(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { throw new Error(`Not valid JSON: ${e.message}`); }
  if (obj?.format === 'eqbtr15-preset') {
    return {
      kind: 'peq', source: 'EQBTR15 preset', name: obj.name,
      filters: (obj.filters ?? []).map(normFilter), preamp: Number(obj.globalGain) || 0,
      warnings: [],
    };
  }
  if (obj?.format === 'eqbtr15-backup') {
    return { kind: 'backup', source: 'EQBTR15 device backup', backup: obj, warnings: [] };
  }
  throw new Error('Unrecognised JSON (expected an EQBTR15 preset or backup).');
}

function normFilter(f) {
  return {
    type: TYPE_MAP[String(f.type).toUpperCase()] ?? 'PK',
    freq: Number(f.freq), gain: Number(f.gain), q: Number(f.q),
    enabled: f.enabled !== false,
  };
}

function dedupe(a) { return [...new Set(a)]; }

// ── Curve helpers ───────────────────────────────────────────────────────────
// Linear interpolation in log-frequency; holds the end values outside the data.
export function curveAt(points, f) {
  const n = points.length;
  if (f <= points[0][0]) return points[0][1];
  if (f >= points[n - 1][0]) return points[n - 1][1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= f) lo = mid; else hi = mid;
  }
  const [f0, g0] = points[lo];
  const [f1, g1] = points[hi];
  const t = Math.log(f / f0) / Math.log(f1 / f0);
  return g0 + t * (g1 - g0);
}

export function sampleCurve(points, freqs) {
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) out[i] = curveAt(points, freqs[i]);
  return out;
}

// ── Exports ─────────────────────────────────────────────────────────────────
const APO_TYPE = { PK: 'PK', LS: 'LSC', HS: 'HSC' };

export function toApoParametric(filters, globalGain = 0) {
  const lines = [`Preamp: ${fmt(globalGain, 1)} dB`];
  filters.forEach((f, i) => {
    lines.push(`Filter ${i + 1}: ${f.enabled === false ? 'OFF' : 'ON'} ${APO_TYPE[f.type]} Fc ${Math.round(f.freq)} Hz Gain ${fmt(f.gain, 1)} dB Q ${fmt(f.q, 2)}`);
  });
  return lines.join('\n') + '\n';
}

export function toPresetJson({ name = 'EQ preset', filters, globalGain = 0, model, source } = {}) {
  return JSON.stringify({
    format: 'eqbtr15-preset', version: 1, name, globalGain, model, source,
    filters: filters.map((f) => ({ type: f.type, freq: f.freq, gain: f.gain, q: f.q, enabled: f.enabled !== false })),
  }, null, 2);
}

export function toGraphicEq(points) {
  return 'GraphicEQ: ' + points.map(([f, g]) => `${Math.round(f)} ${fmt(g, 1)}`).join('; ') + '\n';
}

function fmt(x, d) {
  const v = Number(x.toFixed(d));
  return Object.is(v, -0) ? (0).toFixed(d) : v.toFixed(d);
}
