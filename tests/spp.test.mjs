import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedBtr15Spp } from '../app/sim.js';
import { SppLink } from '../app/ble.js';
import { Btr15Bt } from '../app/btr15bt.js';
import { toDeviceBands } from '../app/btr15.js';
import { TrafficLog } from '../app/log.js';
import { BTR15_BT, BT, encodeGaiaSpp, decodeGaiaSpp, GaiaStreamParser } from '../app/gaia.js';

const fast = { ...BTR15_BT, presetSwitchDelayMs: 5 };

test('GAIA serial framing as FiiO Control builds it for the BTR15', () => {
  // FF 03 00 LEN 00 1D CC HH LL data, LEN = data length + 1
  assert.deepEqual(Array.from(encodeGaiaSpp(BT.BAND, [0, 3])), [0xFF, 0x03, 0x00, 0x03, 0x00, 0x1D, 0xCC, 0x03, 0x02, 0, 3]);
  assert.deepEqual(Array.from(encodeGaiaSpp(BT.VERSION)), [0xFF, 0x03, 0x00, 0x01, 0x00, 0x1D, 0xCC, 0x00, 0x02]);
  assert.throws(() => encodeGaiaSpp(0x1309, [1]), /Refusing/);
  const r = decodeGaiaSpp(Uint8Array.from([0xFF, 0x03, 0x00, 0x03, 0x00, 0x1D, 0xCD, 0x03, 0x00, 0x04, 0x08]));
  assert.equal(r.kind, 'reply'); assert.equal(r.cmd, 0x0304); assert.equal(r.status, 0); assert.deepEqual(Array.from(r.data), [8]);
});

test('stream parser reassembles split packets and reports stray bytes', () => {
  const p = new GaiaStreamParser();
  let out = p.push([0x00, 0xFF, 0x03, 0x00]);
  assert.equal(out.packets.length, 0); assert.deepEqual(Array.from(out.junk), [0x00]);
  out = p.push([0x03, 0x00, 0x1D, 0xCD, 0x03, 0x00, 0x04, 0x08, 0xFF, 0x03]);
  assert.equal(out.packets.length, 1);
  assert.equal(out.packets[0].length, 11);
  assert.deepEqual(p.buf, [0xFF, 0x03]);
});

async function connect(opts = {}) {
  const port = new SimulatedBtr15Spp(opts);
  const log = new TrafficLog();
  const link = new SppLink(port, { log, timeoutMs: 150, profile: fast });
  await link.open();
  return { port, log, link, btr: new Btr15Bt(link, { profile: fast, log }) };
}

test('identify and read user presets over the serial link', async () => {
  const { btr, link, port } = await connect({ emitNoise: true });
  const info = await btr.identify();
  assert.deepEqual(info.firmware, [4, 4]);
  assert.equal(info.preset, 4);
  assert.equal(info.bands.length, 10);
  const s = await btr.readSlot(8);
  assert.equal(s.bands.length, 10);
  assert.ok(port.received.every((f) => (f.cmd & 0xF000) === 0), 'only read commands');
  await link.close();
});

test('checked write over the serial link', async () => {
  const { btr, link, port } = await connect();
  await btr.identify();
  const bands = toDeviceBands([{ type: 'LS', freq: 80, gain: -3, q: 0.7 }, { type: 'PK', freq: 2500, gain: 2.5, q: 3 }], 10, BTR15_BT);
  const r = await btr.writeSlot(9, { globalGain: -2.5, bands });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(port.custom[2].bands[0].type, 'LS');
  assert.equal(port.custom[2].globalGain, -2.5);
  await link.close();
});

test('retries lost serial replies', async () => {
  const { btr, link } = await connect({ dropReplyEvery: 5 });
  const info = await btr.identify();
  assert.equal(info.bands.length, 10);
  assert.ok(link.stats.timeouts > 0);
  await link.close();
});

test('incoming packets are replies even if their command byte looks like a request', () => {
  const pkt = Uint8Array.from([0xFF, 0x03, 0x00, 0x03, 0x00, 0x1D, 0xCC, 0x03, 0x00, 0x04, 0x09]);
  const r = decodeGaiaSpp(pkt, { incoming: true });
  assert.equal(r.kind, 'reply'); assert.equal(r.cmd, 0x0304); assert.deepEqual(Array.from(r.data), [9]);
});
