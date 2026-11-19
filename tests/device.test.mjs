import test from 'node:test';
import assert from 'node:assert/strict';
import { SimulatedBtr15 } from '../app/sim.js';
import { FiioLink, pickControlInterface } from '../app/device.js';
import { Btr15, toDeviceBands } from '../app/btr15.js';
import { TrafficLog } from '../app/log.js';
import { BTR15 } from '../app/protocol.js';

const fast = { ...BTR15, presetSwitchDelayMs: 5 };

async function connect(opts = {}) {
  const dev = new SimulatedBtr15(opts);
  const log = new TrafficLog();
  const link = new FiioLink(dev, { reportId: 7, log, timeoutMs: 100, profile: fast });
  await link.open();
  return { dev, log, link, btr: new Btr15(link, { profile: fast, log }) };
}

test('picks the vendor interface with output report 7', () => {
  const dev = new SimulatedBtr15();
  assert.equal(pickControlInterface([{ collections: [dev.collections[0]] }, dev], 7), dev);
});

test('identify reads everything without writing', async () => {
  const { btr, dev, link } = await connect();
  const info = await btr.identify();
  assert.deepEqual(info.firmware, [1, 0, 2]);
  assert.equal(info.preset, 7);
  assert.equal(info.bandCount, 10);
  assert.equal(info.globalGain, -3);
  assert.equal(info.bands[0].type, 'LS');
  assert.ok(dev.received.every((f) => f.kind === 'get'), 'only GET frames were sent');
  assert.equal(link.seqEcho, true);
  await link.close();
});

test('checked write to a user slot, then stored verification', async () => {
  const { btr, dev, link } = await connect();
  await btr.readBandCount();
  const bands = toDeviceBands([
    { type: 'LS', freq: 90, gain: -2.5, q: 0.6 },
    { type: 'PK', freq: 1234, gain: 3.1, q: 2.22 },
    { type: 'HS', freq: 12000, gain: -6, q: 0.7 },
  ], 10);
  let backedUp = null;
  const r = await btr.writeSlot(9, { globalGain: -4.2, bands }, { onBackup: (b) => { backedUp = b; } });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.equal(backedUp.preset, 9);
  assert.equal(dev.active, 9);
  assert.equal(dev.stored[9].globalGain, -4.2);
  assert.equal(dev.stored[9].bands[1].freq, 1234);
  assert.equal(dev.stored[9].bands[2].type, 'HS');
  await link.close();
});

test('detects shelves reverting to peaks after save', async () => {
  const { btr, link } = await connect({ shelvesRevertOnSave: true });
  await btr.readBandCount();
  const bands = toDeviceBands([{ type: 'LS', freq: 100, gain: 3, q: 0.7 }], 10);
  const r = await btr.writeSlot(8, { globalGain: -3, bands });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'stored');
  assert.equal(r.problems[0].got.type, 'PK');
  await link.close();
});

test('retries when replies are lost', async () => {
  const { btr, link } = await connect({ dropReplyEvery: 3 });
  const bands = await btr.readBands(10);
  assert.equal(bands.length, 10);
  assert.ok(link.stats.timeouts > 0);
  await link.close();
});

test('refuses to write a built-in preset or out-of-range values', async () => {
  const { btr, link } = await connect();
  await btr.readBandCount();
  const bands = toDeviceBands([], 10);
  await assert.rejects(btr.writeSlot(0, { globalGain: 0, bands }), /only user slots/);
  const bad = toDeviceBands([{ type: 'PK', freq: 1000, gain: 13, q: 1 }], 10);
  await assert.rejects(btr.writeSlot(7, { globalGain: 0, bands: bad }), /outside/);
  await link.close();
});

test('a stream of all-zero reports is summarised, not logged one by one', async () => {
  const { btr, link, log } = await connect({ emptyEveryMs: 1 });
  const info = await btr.identify();
  assert.equal(info.framing, 'current');
  assert.equal(info.bands.length, 10);
  await link.close();
  const zeroLines = log.toText().split('\n').filter((l) => /00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00/.test(l));
  assert.equal(zeroLines.length, 0, 'no raw zero reports in the log');
  assert.ok(link.stats.empty > 20, `empty reports counted (${link.stats.empty})`);
  assert.match(log.toText(), /Ignored \d+ all-zero reports/);
});

test('falls back to the older frame format when the device wants it', async () => {
  const { btr, dev, link } = await connect({ legacyOnly: true });
  const info = await btr.identify();
  assert.equal(info.framing, 'legacy');
  assert.equal(info.bandCount, 10);
  assert.deepEqual(info.firmware, [1, 0, 2]);
  const sent = dev.received.at(-1);
  assert.equal(sent.seq, 0); assert.equal(sent.crc, 0);
  await link.close();
});

test('reports no answer and stops when the device never replies', async () => {
  const dev = new SimulatedBtr15();
  dev.sendReport = async () => {};
  const log = new TrafficLog();
  const link = new FiioLink(dev, { reportId: 7, log, timeoutMs: 30, profile: fast });
  await link.open();
  const info = await new Btr15(link, { profile: fast, log }).identify();
  assert.equal(info.noAnswer, true);
  assert.equal(link.stats.tx, 6, 'three tries in each of two frame formats, then nothing more');
  await link.close();
});
