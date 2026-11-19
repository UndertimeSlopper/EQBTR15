import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEqText, curveAt, toApoParametric } from '../app/formats.js';

test('parses the FT1 GraphicEQ example', () => {
  const r = parseEqText(readFileSync(new URL('../examples/FiiO_FT1_GraphicEq.txt', import.meta.url), 'utf8'));
  assert.equal(r.kind, 'curve');
  assert.equal(r.points.length, 127);
  assert.deepEqual(r.points[0], [20, -8.3]);
  assert.deepEqual(r.points.at(-1), [19871, -13.6]);
  assert.equal(curveAt(r.points, 1000), r.points.find(([f]) => f > 977 && f < 1033) ? curveAt(r.points, 1000) : NaN);
});

test('parses AutoEQ ParametricEQ', () => {
  const txt = `Preamp: -6.4 dB
Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70
Filter 2: ON PK Fc 2000 Hz Gain -3.2 dB Q 1.41
Filter 3: OFF PK Fc 5000 Hz Gain 2 dB Q 3
Filter 4: ON HSC Fc 10000 Hz Gain -2.0 dB Q 0.70
Filter 5: ON LP Fc 18000 Hz`;
  const r = parseEqText(txt);
  assert.equal(r.kind, 'peq');
  assert.equal(r.preamp, -6.4);
  assert.equal(r.filters.length, 4);
  assert.deepEqual(r.filters[0], { type: 'LS', freq: 105, gain: 5.5, q: 0.7, enabled: true });
  assert.equal(r.filters[2].enabled, false);
  assert.ok(r.warnings.some((w) => /LP/.test(w)));
  assert.match(toApoParametric(r.filters, r.preamp), /Filter 1: ON LSC Fc 105 Hz Gain 5\.5 dB Q 0\.70/);
});

test('parses AutoEQ CSV using the equalization column', () => {
  const csv = 'frequency,raw,error,smoothed,error_smoothed,equalization\n20,1,2,3,4,-5\n1000,0,0,0,0,-1\n20000,1,1,1,1,-7\n';
  const r = parseEqText(csv);
  assert.equal(r.kind, 'curve');
  assert.deepEqual(r.points, [[20, -5], [1000, -1], [20000, -7]]);
});

test('parses a plain two-column measurement', () => {
  const r = parseEqText('* REW export\nFreq(Hz) SPL(dB)\n20\t80.1\n100\t82\n1000\t85\n');
  assert.deepEqual(r.points, [[20, 80.1], [100, 82], [1000, 85]]);
});
