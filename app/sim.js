// A simulated BTR15 that speaks the same HID protocol, for the demo mode and
// the automated tests. It is built from what FiiO's app expects, not from a
// real device, so it proves the app is self-consistent, not that the BTR15
// behaves this way. Optional faults reproduce reported FiiO problems.

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
      ...options,
    };
    this.productName = 'FIIO BTR15 (simulated)';
    this.vendorId = 0x2972;
    this.productId = 0x0F15;
    this.opened = false;
    this.oninputreport = null;
    this.collections = [
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
      ev.reportId = 7;
      ev.device = this;
      this.dispatchEvent(ev);
      this.oninputreport?.(ev);
    }, this.options.latencyMs);
  }

  async sendReport(reportId, data) {
    if (!this.opened) throw new Error('Device not open');
    if (reportId !== 7) return; // ignored, like a report the device does not listen to
    const bytes = new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length);
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
    const report = new Uint8Array(63);
    report.set(frame);
    this._emit(report);
  }
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }
