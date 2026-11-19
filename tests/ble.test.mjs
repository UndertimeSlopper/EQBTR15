import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedBtr15Ble } from '../app/sim.js';
import { BleLink } from '../app/ble.js';
import { Btr15Bt } from '../app/btr15bt.js';
import { toDeviceBands } from '../app/btr15.js';
import { TrafficLog } from '../app/log.js';
import { BTR15_BT, encodeGaia, decodeGaia, BT, encodeBandBt, decodeBandBt } from '../app/gaia.js';

const fast = { ...BTR15_BT, presetSwitchDelayMs: 5 };

async function connect(opts = {}) {
  const dev = new SimulatedBtr15Ble(opts);
  const log = new TrafficLog();
  const link = new BleLink(dev, { log, timeoutMs: 100, profile: fast });
  await link.open();
  return { dev, log, link, btr: new Btr15Bt(link, { profile: fast, log }) };
}

test('GAIA framing as FiiO Control sends it', () => {
  assert.deepEqual(Array.from(encodeGaia(BT.BAND, [0, 3])), [0x00, 0x0A, 0x04, 0x03, 0x02, 0, 3]);
  const r = decodeGaia(Uint8Array.from([0x00, 0x0A, 0x84, 0x03, 0x00, 0x04, 0x08]));
  assert.equal(r.kind, 'reply'); assert.equal(r.cmd, 0x0304); assert.equal(r.status, 0); assert.deepEqual(Array.from(r.data), [8]);
  assert.throws(() => encodeGaia(0x1309, [1]), /Refusing/);
  assert.throws(() => encodeGaia(0x130B, [0, 65]), /Refusing/);
  const b = { index: 2, type: 'HS', freq: 10000, gain: -6.5, q: 0.71 };
  assert.deepEqual(decodeBandBt(encodeBandBt(1, b)), { customIndex: 1, index: 2, gain: -6.5, freq: 10000, q: 0.71, typeCode: 2, type: 'HS', hasType: true });
});

test('identify over Bluetooth reads without writing', async () => {
  const { btr, dev, link } = await connect();
  const info = await btr.identify();
  assert.deepEqual(info.firmware, [4, 4]);
  assert.equal(info.preset, 4);
  assert.equal(info.bands.length, 10);
  assert.equal(info.bands[0].type, 'LS');
  assert.equal(info.globalGain, -3);
  assert.ok(dev.received.every((f) => (f.cmd & 0xF000) === 0), 'only read commands');
  await link.close();
});

test('user presets can be read without switching', async () => {
  const { btr, dev, link } = await connect();
  await btr.identify();
  const s = await btr.readSlot(9);
  assert.equal(s.bands.length, 10);
  assert.equal(dev.preset, 4);
  assert.ok(dev.received.every((f) => (f.cmd & 0xF000) === 0));
  await link.close();
});

test('checked write over Bluetooth, with stored check', async () => {
  const { btr, dev, link } = await connect();
  await btr.identify();
  const bands = toDeviceBands([{ type: 'LS', freq: 90, gain: -2.5, q: 0.6 }, { type: 'PK', freq: 1234, gain: 3.1, q: 2.22 }, { type: 'HS', freq: 12000, gain: -6, q: 0.7 }], 10, BTR15_BT);
  const r = await btr.writeSlot(9, { globalGain: -4.2, bands });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(dev.preset, 9);
  assert.equal(dev.custom[2].globalGain, -4.2);
  assert.equal(dev.custom[2].bands[2].type, 'HS');
  assert.equal(dev.custom[0].bands[0].type, 'LS', 'USER1 untouched');
  await link.close();
});

test('detects shelves being stored as peaks', async () => {
  const { btr, link } = await connect({ shelvesRevert: true });
  await btr.identify();
  const r = await btr.writeSlot(8, { globalGain: 0, bands: toDeviceBands([{ type: 'LS', freq: 100, gain: 3, q: 0.7 }], 10, BTR15_BT) });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].got.type, 'PK');
  await link.close();
});

test('old firmware: no type byte, shelves refused', async () => {
  const { btr, dev, link } = await connect({ firmware: [2, 3] });
  await btr.identify();
  await assert.rejects(btr.writeSlot(8, { globalGain: 0, bands: toDeviceBands([{ type: 'HS', freq: 9000, gain: -3, q: 0.7 }], 10, BTR15_BT) }), /cannot store shelf/);
  const r = await btr.writeSlot(8, { globalGain: 0, bands: toDeviceBands([{ type: 'PK', freq: 900, gain: -3, q: 1 }], 10, BTR15_BT) });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const sent = dev.received.filter((f) => f.cmd === BT.SET_BAND);
  assert.ok(sent.every((f) => f.data.length === 8), 'no type byte on old firmware');
  await link.close();
});

test('lost notifications are retried', async () => {
  const { btr, link } = await connect({ dropReplyEvery: 4 });
  const info = await btr.identify();
  assert.equal(info.bands.length, 10);
  assert.ok(link.stats.timeouts > 0);
  await link.close();
});
