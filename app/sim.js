// A simulated BTR15 that speaks the same HID protocol, for the demo mode and
// the automated tests. It is built from what FiiO's app expects, not from a
// real device, so it proves the app is self-consistent, not that the BTR15
// behaves this way. Optional faults reproduce reported FiiO problems.

import { GAIA_SERVICE, GAIA_COMMAND, GAIA_RESPONSE, BT, decodeGaia, encodeBandBt, decodeBandBt, encodeGainBt, decodeGainBt } from './gaia.js';
import { CMD, crc8, decodeFrame, encodeBand, decodeBand, encodeGain, decodeGain, decodeUint, encodeUint, BTR15 } from './protocol.js';

const flat = () => BTR15.defaultFreqs.map((freq, index) => ({ index, type: 'PK', freq, gain: 0, q: 1 }));
const preset = (gains) => ({ globalGain: 0, bands: flat().map((b, i) => ({ ...b, gain: gains[i] ?? 0 })) });

export class SimulatedBtr15 extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = {
      shelvesRevertOnSave: false, // saved shelves come back as peaks
      dropReplyEvery: 0,          // drop every Nth reply
      latencyMs: 4,
      echoSeq: true,
      emptyEveryMs: 0,            // send an all-zero report this often, like a device answering every USB poll
      legacyOnly: false,          // only answer frames with sequence 00 00 and checksum 00; zeros otherwise
      noReportIds: false,         // one 32-byte report without an ID, like the BTR15's "EQ" interface
      wantsPrefix07: false,       // frames carried after a 07 byte, in both directions
      ...options,
    };
    this.reportId = this.options.noReportIds ? 0 : 7;
    this.productName = 'FIIO BTR15 (simulated)';
    this.vendorId = 0x2972;
    this.productId = 0x0F15;
    this.opened = false;
    this.oninputreport = null;
    this.collections = this.options.noReportIds ? [
      { usagePage: 0x0001, usage: 0x0000, inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 32 }] }], outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 32 }] }], featureReports: [] },
    ] : [
      { usagePage: 0x000C, usage: 0x0001, inputReports: [{ reportId: 1, items: [{ reportSize: 8, reportCount: 2 }] }], outputReports: [], featureReports: [] },
      { usagePage: 0xFF00, usage: 0x0001, inputReports: [{ reportId: 7, items: [{ reportSize: 8, reportCount: 63 }] }], outputReports: [{ reportId: 7, items: [{ reportSize: 8, reportCount: 63 }] }], featureReports: [] },
    ];
    this.firmware = [1, 0, 2];
    this.eqSwitch = 1;
    this.stored = {
      0: preset([3, 2, 0, -1, 0, 1, 2, 3, 2, 1]), 1: preset([-1, 1, 2, 3, 2, 0, -1, -1, 0, 1]),
      2: preset([4, 3, 1, 0, -1, 0, 1, 2, 3, 3]), 3: preset([5, 4, 2, 0, 0, 0, 0, 1, 2, 3]),
      4: preset([3, 4, 3, 1, 0, 0, 1, 1, 1, 0]), 5: preset([2, 1, 0, 0, 0, 0, 0, 0, 1, 2]),
      6: preset([5, 4, 1, 0, -1, -1, 0, 1, 2, 2]),
      7: { globalGain: -3, bands: [
        { index: 0, type: 'LS', freq: 105, gain: 4, q: 0.7 }, { index: 1, type: 'PK', freq: 200, gain: -2.5, q: 1.1 },
        { index: 2, type: 'PK', freq: 1500, gain: 1.5, q: 2 }, { index: 3, type: 'PK', freq: 3200, gain: -3, q: 4 },
        { index: 4, type: 'HS', freq: 10000, gain: -2, q: 0.7 },
        ...flat().slice(5),
      ] },
      8: preset([]), 9: preset([]), 11: preset([]), 240: preset([]),
    };
    this.active = 7;
    this.live = clone(this.stored[7]);
    this.replyCount = 0;
    this.received = [];
  }

  async open() {
    this.opened = true;
    if (this.options.emptyEveryMs) this._emptyTimer = setInterval(() => this._emit(new Uint8Array(32)), this.options.emptyEveryMs);
  }
  async close() { this.opened = false; clearInterval(this._emptyTimer); }

  _emit(report) {
    setTimeout(() => {
      if (!this.opened) return;
      const ev = new Event('inputreport');
      ev.data = new DataView(report.buffer);
      ev.reportId = this.reportId;
      ev.device = this;
      this.dispatchEvent(ev);
      this.oninputreport?.(ev);
    }, this.options.latencyMs);
  }

  async sendReport(reportId, data) {
    if (!this.opened) throw new Error('Device not open');
    if (this.options.noReportIds && reportId !== 0) throw new DOMException('Failed to write the report.', 'NotAllowedError'); // as Chrome does
    if (reportId !== this.reportId) return; // ignored, like a report the device does not listen to
    let bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
    if (this.options.wantsPrefix07) {
      if (bytes[0] !== 0x07) return; // firmware ignores it
      bytes = bytes.subarray(1);
    }
    const f = decodeFrame(bytes);
    this.received.push(f);
    if (!f.valid) return;
    if (this.options.legacyOnly && (f.seq !== 0 || f.crc !== 0)) { this._emit(new Uint8Array(32)); return; }
    const p = f.payload;
    if (f.kind === 'get') {
      switch (f.cmd) {
        case CMD.FIRMWARE_VERSION: return this._reply(f, this.firmware);
        case CMD.PEQ_SWITCH: return this._reply(f, [this.eqSwitch]);
        case CMD.PEQ_PRESET: return this._reply(f, encodeUint(this.active));
        case CMD.PEQ_COUNT: return this._reply(f, [this.live.bands.length]);
        case CMD.GLOBAL_GAIN: return this._reply(f, encodeGain(this.live.globalGain));
        case CMD.PEQ_PARAMS: {
          const b = this.live.bands[p[0]];
          if (b) return this._reply(f, encodeBand(b));
          return undefined;
        }
        default: return undefined;
      }
    }
    switch (f.cmd) {
      case CMD.PEQ_PARAMS: {
        const b = decodeBand(p);
        if (b && this.live.bands[b.index]) this.live.bands[b.index] = { index: b.index, type: b.type, freq: b.freq, gain: b.gain, q: b.q };
        break;
      }
      case CMD.GLOBAL_GAIN: this.live.globalGain = decodeGain(p); break;
      case CMD.PEQ_PRESET: {
        const id = decodeUint(p);
        if (this.stored[id]) { this.active = id; this.live = clone(this.stored[id]); }
        break;
      }
      case CMD.PEQ_SAVE: {
        const id = decodeUint(p);
        const copy = clone(this.live);
        if (this.options.shelvesRevertOnSave) copy.bands.forEach((b) => { if (b.type !== 'PK') b.type = 'PK'; });
        this.stored[id] = copy;
        break;
      }
      case CMD.PEQ_SWITCH: this.eqSwitch = p[0] ? 1 : 0; break;
      default: break;
    }
    return undefined;
  }

  _reply(req, payload) {
    this.replyCount++;
    if (this.options.dropReplyEvery && this.replyCount % this.options.dropReplyEvery === 0) return;
    const seq = this.options.echoSeq ? req.seq : 0;
    const body = [0xBB, 0x0B, (seq >> 8) & 0xFF, seq & 0xFF, req.cmd, payload.length, ...payload];
    const frame = [...body, crc8(body), 0xEE];
    const report = new Uint8Array(this.options.noReportIds ? 32 : 63);
    report.set(this.options.wantsPrefix07 ? [0x07, ...frame] : frame);
    this._emit(report);
  }
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }

// ── Simulated BTR15 over Bluetooth (GAIA) ───────────────────────────────────
// Implements the small part of Web Bluetooth that BleLink uses.

export class SimulatedBtr15Ble extends EventTarget {
  constructor(options = {}) {
    super();
    this.options = { firmware: [4, 4], latencyMs: 6, dropReplyEvery: 0, shelvesRevert: false, ...options };
    this.name = 'FiiO BTR15 (simulated)';
    this.id = 'sim-btr15';
    this.connected = false;
    this.received = [];
    const flatBands = () => BTR15_BT_FREQS.map((freq, index) => ({ index, type: 'PK', freq, gain: 0, q: 1 }));
    this.custom = [
      { globalGain: -3, bands: [{ index: 0, type: 'LS', freq: 105, gain: 4, q: 0.7 }, { index: 1, type: 'PK', freq: 200, gain: -2.5, q: 1.1 }, { index: 2, type: 'PK', freq: 3200, gain: -3, q: 4 }, ...flatBands().slice(3)] },
      { globalGain: 0, bands: flatBands() },
      { globalGain: 0, bands: flatBands() },
    ];
    this.preset = 4;
    this.eqSwitch = 1;
    this.replyCount = 0;
    const sim = this;
    this.respChar = new (class extends EventTarget {
      constructor() { super(); this.uuid = GAIA_RESPONSE; this.properties = { notify: true }; }
      async startNotifications() { return this; }
    })();
    this.cmdChar = {
      uuid: GAIA_COMMAND,
      properties: { write: true, writeWithoutResponse: false },
      writeValueWithResponse: async (bytes) => sim._handle(new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length)),
    };
    const service = {
      uuid: GAIA_SERVICE,
      getCharacteristic: async (uuid) => {
        if (uuid === GAIA_COMMAND) return sim.cmdChar;
        if (uuid === GAIA_RESPONSE) return sim.respChar;
        throw new DOMException('No characteristic', 'NotFoundError');
      },
    };
    this.gatt = {
      get connected() { return sim.connected; },
      connect: async () => { sim.connected = true; return { getPrimaryService: async (uuid) => { if (uuid !== GAIA_SERVICE) throw new DOMException('No service', 'NotFoundError'); return service; } }; },
      disconnect: () => { sim.connected = false; sim.dispatchEvent(new Event('gattserverdisconnected')); },
    };
  }

  _reply(cmd, status, data) {
    this.replyCount++;
    if (this.options.dropReplyEvery && this.replyCount % this.options.dropReplyEvery === 0) return;
    const bytes = Uint8Array.from([0x00, 0x0A, 0x84, (cmd >> 8) & 0xFF, status, cmd & 0xFF, ...data]);
    setTimeout(() => {
      if (!this.connected) return;
      const ev = new Event('characteristicvaluechanged');
      Object.defineProperty(ev, 'target', { value: { value: new DataView(bytes.buffer) } });
      this.respChar.dispatchEvent(ev);
    }, this.options.latencyMs);
  }

  _handle(bytes) {
    if (!this.connected) throw new DOMException('GATT Server is disconnected', 'NetworkError');
    const f = decodeGaia(bytes);
    this.received.push(f);
    if (!f.valid || f.kind !== 'request') return;
    const d = f.data;
    const ci = { 4: 0, 8: 1, 9: 2 }[this.preset];
    const withType = this.options.firmware[0] + this.options.firmware[1] / 10 >= 2.5;
    switch (f.cmd) {
      case BT.VERSION: return this._reply(f.cmd, 0, this.options.firmware);
      case BT.BATTERY: return this._reply(f.cmd, 0, [80]);
      case BT.EQ_SWITCH: return this._reply(f.cmd, 0, [this.eqSwitch]);
      case BT.PRESET: return this._reply(f.cmd, 0, [this.preset]);
      case BT.BAND: {
        const p = this.custom[d[0]];
        const b = p?.bands[d[1]];
        if (!b) return this._reply(f.cmd, 1, []);
        return this._reply(f.cmd, 0, encodeBandBt(d[0], b, { withType }));
      }
      case BT.GLOBAL_GAIN: {
        const p = this.custom[d[0]];
        if (!p) return this._reply(f.cmd, 1, []);
        return this._reply(f.cmd, 0, encodeGainBt(d[0], p.globalGain));
      }
      case BT.SET_PRESET: if (d[0] <= 9) this.preset = d[0]; return this._reply(f.cmd, 0, []);
      case BT.SET_EQ_SWITCH: this.eqSwitch = d[0] ? 1 : 0; return this._reply(f.cmd, 0, []);
      case BT.SET_BAND: {
        const b = decodeBandBt(withType ? d : [...d, 0]);
        const p = this.custom[b.customIndex];
        if (!p || ci !== b.customIndex) return this._reply(f.cmd, 1, []);
        p.bands[b.index] = { index: b.index, type: this.options.shelvesRevert ? 'PK' : b.type, freq: b.freq, gain: b.gain, q: b.q };
        return this._reply(f.cmd, 0, []);
      }
      case BT.SET_GLOBAL_GAIN: {
        const x = decodeGainBt(d);
        const p = this.custom[x.customIndex];
        if (!p) return this._reply(f.cmd, 1, []);
        p.globalGain = x.gain;
        return this._reply(f.cmd, 0, []);
      }
      default: return this._reply(f.cmd, 1, []);
    }
  }
}

const BTR15_BT_FREQS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// ── Simulated BTR15 over a Bluetooth serial port (Web Serial SerialPort) ────
export class SimulatedBtr15Spp extends SimulatedBtr15Ble {
  constructor(options = {}) {
    super({ splitReplies: true, ...options });
    this.name = 'FiiO BTR15 (simulated serial)';
    this.readable = null;
    this.writable = null;
  }

  getInfo() { return { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb', simulated: true }; }

  async open() {
    this.connected = true;
    const sim = this;
    this.readable = new ReadableStream({ start(c) { sim._ctl = c; } });
    this.writable = new WritableStream({
      write(chunk) {
        const b = Uint8Array.from(chunk);
        if (b[0] !== 0xFF || b.length < 9) return;
        // Convert the serial request into the BLE form the shared handler uses.
        sim._handle(Uint8Array.from([0x00, 0x0A, 0x04, b[7], b[8], ...b.slice(9)]));
      },
    });
    if (this.options.emitNoise) this._ctl.enqueue(Uint8Array.from([0x00, 0x12]));
  }

  async close() {
    this.connected = false;
    try { this._ctl?.close(); } catch { /* already closed */ }
  }

  _reply(cmd, status, data) {
    this.replyCount++;
    if (this.options.dropReplyEvery && this.replyCount % this.options.dropReplyEvery === 0) return;
    const bytes = Uint8Array.from([0xFF, 0x03, 0x00, data.length + 2, 0x00, 0x1D, 0xCD, (cmd >> 8) & 0xFF, status, cmd & 0xFF, ...data]);
    setTimeout(() => {
      if (!this.connected) return;
      if (this.options.splitReplies && bytes.length > 4) {
        this._ctl.enqueue(bytes.slice(0, 3));
        this._ctl.enqueue(bytes.slice(3));
      } else {
        this._ctl.enqueue(bytes);
      }
    }, this.options.latencyMs);
  }
}
