import test from 'node:test';
import assert from 'node:assert/strict';
import { crc8, encodeFrame, decodeFrame, encodeBand, decodeBand, CMD, describe } from '../app/protocol.js';

test('CRC-8 table matches the one in FiiO\'s web app', () => {
  // First entries of FiiO's table are 0, 94, 188, 226, 97, 63, 221, 131.
  const firsts = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => crc8([i]));
  assert.deepEqual(firsts, [0, 94, 188, 226, 97, 63, 221, 131]);
});

test('GET frame layout', () => {
  const f = encodeFrame('get', CMD.PEQ_COUNT, [], 0x0102);
  assert.deepEqual(Array.from(f.slice(0, 6)), [0xBB, 0x0B, 0x01, 0x02, 0x18, 0x00]);
  assert.equal(f[6], crc8(f.slice(0, 6)));
  assert.equal(f[7], 0xEE);
});

test('band encoding matches devicePEQ layout (gain, freq, Q big-endian)', () => {
  const p = encodeBand({ index: 3, type: 'PK', freq: 1000, gain: -3.5, q: 1.41 });
  // index, gain*10 as int16 BE (-35 = 0xFFDD), freq BE, Q*100 BE, type
  assert.deepEqual(p, [3, 0xFF, 0xDD, 0x03, 0xE8, 0x00, 0x8D, 0]);
  const b = decodeBand(p);
  assert.equal(b.gain, -3.5); assert.equal(b.freq, 1000); assert.equal(b.q, 1.41); assert.equal(b.type, 'PK');
});

test('round trip through a frame', () => {
  const bytes = encodeFrame('set', CMD.PEQ_PARAMS, encodeBand({ index: 0, type: 'HS', freq: 10000, gain: 6, q: 0.7 }), 7);
  const f = decodeFrame(bytes);
  assert.ok(f.valid && f.crcOk);
  assert.equal(f.kind, 'set');
  assert.match(describe(f), /SET PEQ_PARAMS band 0: HS 10000 Hz \+6\.0 dB Q 0\.70/);
});

test('dangerous or unknown commands cannot be encoded', () => {
  for (const cmd of [0x1B, 0x1C, 0x21, 0x30, 0x18, 0x0B]) {
    assert.throws(() => encodeFrame('set', cmd, [0]), /Refusing/);
  }
  assert.throws(() => encodeFrame('get', 0x21, []), /Refusing/);
});

test('decoding tolerates zero padding and flags a bad CRC', () => {
  const bytes = new Uint8Array(64);
  bytes.set(encodeFrame('get', CMD.PEQ_SWITCH, [1], 5));
  bytes[0] = 0xBB;
  const ok = decodeFrame(bytes);
  assert.ok(ok.valid && ok.crcOk);
  bytes[7] ^= 0xFF;
  const bad = decodeFrame(bytes);
  assert.ok(bad.valid && !bad.crcOk);
});
