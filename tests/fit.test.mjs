import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEqText } from '../app/formats.js';
import { fitPeq, BTR15_LIMITS, equalizationCurve } from '../app/fit.js';

const ft1 = parseEqText(readFileSync(new URL('../examples/FiiO_FT1_GraphicEq.txt', import.meta.url), 'utf8')).points;

for (const model of ['standard', 'gainWidening']) {
  test(`fits the FT1 curve closely (${model})`, () => {
    const r = fitPeq(ft1, { model });
    assert.ok(r.sent.length <= 10);
    assert.ok(r.stats.all.rms < 0.35, `rms ${r.stats.all.rms}`);
    assert.ok(r.stats.all.max < 1.2, `max ${r.stats.all.max}`);
    assert.ok(r.stats.peak <= 0.001, `peak ${r.stats.peak}`);
    assert.ok(r.stats.chainPeak < 0.3, `chain peak ${r.stats.chainPeak}`);
    for (const f of r.sent) {
      assert.ok(['PK', 'LS', 'HS'].includes(f.type));
      assert.ok(f.freq >= 20 && f.freq <= 20000 && Number.isInteger(f.freq));
      assert.ok(f.gain >= -12 && f.gain <= 12);
      assert.ok(f.q >= BTR15_LIMITS.q[0] && f.q <= BTR15_LIMITS.q[1]);
      assert.equal(Math.round(f.gain * 10) / 10, f.gain);
      assert.equal(Math.round(f.q * 100) / 100, f.q);
    }
  });
}

test('peaking-only fit still works', () => {
  const r = fitPeq(ft1, { types: ['PK'], restarts: 2 });
  assert.ok(r.sent.every((f) => f.type === 'PK'));
  assert.ok(r.stats.all.rms < 0.6, `rms ${r.stats.all.rms}`);
});

test('recovers a known filter set', () => {
  const pts = [];
  // target generated from 3 filters
  const { responseAt } = awaitImport();
  for (let f = 20; f <= 20000; f *= 1.05) pts.push(f);
  const tf = [{ type: 'LS', freq: 100, gain: 4, q: 0.7 }, { type: 'PK', freq: 2500, gain: -5, q: 3 }, { type: 'HS', freq: 9000, gain: -3, q: 0.7 }];
  const db = responseAt(tf, pts, -4);
  const r = fitPeq(pts.map((f, i) => [f, db[i]]), { bands: 5, chainHeadroom: false, preventClipping: false });
  assert.ok(r.stats.all.rms < 0.1, `rms ${r.stats.all.rms}`);
});

test('measurement + target gives a bounded curve', () => {
  const meas = [[20, 5], [100, 3], [1000, 0], [3000, 6], [10000, -4], [20000, -10]];
  const target = [[20, 6], [100, 4], [1000, 0], [3000, 8], [10000, 0], [20000, -5]];
  const eq = equalizationCurve(meas, target, { maxBoost: 6 });
  assert.ok(eq.every(([, g]) => g <= 1e-9 && g >= -12));
});

import * as dsp from '../app/dsp.js';
function awaitImport() { return dsp; }
