import test from 'node:test';
import assert from 'node:assert/strict';
import { responseAt, getModel, shelfQToSlope, shelfSlopeToQ, rbjA } from '../app/dsp.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('peaking filter hits its gain at the centre', () => {
  const [g] = responseAt([{ type: 'PK', freq: 1000, gain: -6, q: 2 }], [1000]);
  near(g, -6, 1e-6, 'centre gain');
});

test('shelves reach their gain on the far side and half of it at fc', () => {
  const ls = responseAt([{ type: 'LS', freq: 200, gain: 6, q: 0.707 }], [20, 200, 5000]);
  near(ls[0], 6, 0.1, 'LS far'); near(ls[1], 3, 1e-6, 'LS mid'); near(ls[2], 0, 0.05, 'LS other side');
  const hs = responseAt([{ type: 'HS', freq: 5000, gain: -4, q: 0.707 }], [100, 5000, 20000]);
  near(hs[0], 0, 0.05, 'HS other side'); near(hs[1], -2, 1e-6, 'HS mid'); near(hs[2], -4, 0.2, 'HS far');
});

test('slope/Q conversion round trips', () => {
  const q = shelfSlopeToQ(1, 6);
  near(shelfQToSlope(q, 6), 1, 1e-9, 'S');
  near(shelfSlopeToQ(1, 0), Math.SQRT1_2, 1e-9, 'S=1 at 0 dB is Q 0.707');
});

test('gain-widening model inverts exactly', () => {
  const m = getModel('gainWidening');
  const f = { type: 'PK', freq: 1000, gain: -9, q: 2 };
  const sent = m.toSent(f);
  near(sent.q, 2 * rbjA(9), 1e-12, 'sent Q');
  near(m.toRealised(sent).q, 2, 1e-12, 'realised Q');
  assert.equal(m.toSent({ type: 'LS', freq: 100, gain: 5, q: 0.7 }).q, 0.7);
});
