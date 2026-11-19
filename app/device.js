// Transport: one FiiO control channel over a WebHID device (or the simulator,
// which implements the same small subset of the HIDDevice interface).
//
// Reliability choices, each a response to something FiiO's own app does:
//  - One command in flight at a time, through a single queue.
//  - A reply must match the command byte AND, for band reads, the band index
//    (FiiO's app matches on the command only, so a late reply for band 3 can
//    be taken as band 4).
//  - Reads time out and retry; a read that still fails is an error, never a
//    silently substituted default band (FiiO's app fills in 20 Hz / 0 dB).
//  - Replies with a bad CRC are logged and retried.
//  - Unsolicited reports (e.g. the preset changed on the device) are logged
//    and passed to listeners instead of being mistaken for replies.

import { encodeFrame, decodeFrame, describe, hexBytes, slotName, CMD } from './protocol.js';

export class LinkError extends Error {
  constructor(message, code) { super(message); this.name = 'LinkError'; this.code = code; }
}

export function summarizeCollections(device) {
  const lines = [];
  for (const c of device.collections ?? []) {
    const reps = (list) => (list ?? []).map((r) => {
      const bits = (r.items ?? []).reduce((s, it) => s + (it.reportSize ?? 0) * (it.reportCount ?? 0), 0);
      return `#${r.reportId ?? 0}(${Math.ceil(bits / 8)}B)`;
    }).join(',') || '-';
    lines.push(`usagePage 0x${(c.usagePage ?? 0).toString(16)} usage 0x${(c.usage ?? 0).toString(16)} in:${reps(c.inputReports)} out:${reps(c.outputReports)} feat:${reps(c.featureReports)}`);
  }
  return lines;
}

export function outputReportLength(device, reportId) {
  let bits = 0;
  for (const c of device.collections ?? []) {
    for (const r of c.outputReports ?? []) {
      if ((r.reportId ?? 0) === reportId) for (const it of r.items ?? []) bits += (it.reportSize ?? 0) * (it.reportCount ?? 0);
    }
  }
  return bits ? Math.ceil(bits / 8) : null;
}

export function hasOutputReport(device, reportId) {
  return (device.collections ?? []).some((c) => (c.outputReports ?? []).some((r) => (r.reportId ?? 0) === reportId));
}

// Among the HID interfaces of one physical device, pick the control channel.
export function pickControlInterface(devices, reportId) {
  return devices.find((d) => hasOutputReport(d, reportId))
    ?? devices.find((d) => (d.collections ?? []).some((c) => (c.usagePage ?? 0) >= 0xFF00 && (c.outputReports ?? []).length))
    ?? devices.find((d) => (d.collections ?? []).some((c) => (c.outputReports ?? []).length))
    ?? null;
}

export class FiioLink {
  constructor(device, { reportId = 7, log, timeoutMs = 800, retries = 2, gapMs = 8, profile } = {}) {
    this.device = device;
    this.reportId = reportId;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.gapMs = gapMs;
    this.profile = profile;
    this.seq = 1;
    this.queue = Promise.resolve();
    this.waiters = [];
    this.unsolicited = new Set();
    this.closed = false;
    this.seqEcho = null; // learned: does the device echo our sequence number?
    this.stats = { tx: 0, rx: 0, crcBad: 0, timeouts: 0, unsolicited: 0 };
    this._onInput = (ev) => this._handleInput(ev);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this._onInput);
    this.padTo = outputReportLength(this.device, this.reportId);
    this.log?.info(`Opened "${this.device.productName}" VID 0x${hex4(this.device.vendorId)} PID 0x${hex4(this.device.productId)}; using output report ${this.reportId}${this.padTo ? ` (${this.padTo} bytes)` : ' (length unknown, not padded)'}`);
  }

  async close() {
    this.closed = true;
    this.device.removeEventListener('inputreport', this._onInput);
    this._failAll(new LinkError('Connection closed', 'closed'));
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }

  markDisconnected() {
    this.closed = true;
    this.device.removeEventListener('inputreport', this._onInput);
    this._failAll(new LinkError('Device disconnected', 'disconnected'));
  }

  onUnsolicited(fn) { this.unsolicited.add(fn); return () => this.unsolicited.delete(fn); }

  _failAll(err) {
    const w = this.waiters.splice(0);
    for (const x of w) { clearTimeout(x.timer); x.reject(err); }
  }

  _describe(frame) {
    return describe(frame, { slotName: (id) => slotName(id, this.profile) });
  }

  _handleInput(ev) {
    const data = new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength);
    const frame = decodeFrame(data);
    this.stats.rx++;
    const shown = frame.payload ? data.slice(0, 8 + frame.payload.length) : data;
    const idNote = ev.reportId !== undefined && ev.reportId !== this.reportId ? ` [input report ${ev.reportId}]` : '';
    if (!frame.valid) {
      this.log?.rx(`unparsed report${idNote} (${frame.error ?? 'bad frame'})`, data);
      return;
    }
    let note = '';
    if (!frame.crcOk) { note = ' CRC MISMATCH'; this.stats.crcBad++; }
    // Once the device has shown it echoes our sequence number, require it, so
    // an echo of an earlier SET can never pass as the reply to a later GET.
    const waiter = this.waiters.find((w) => w.match(frame) && (this.seqEcho !== true || w.anySeq || frame.seq === w.seq));
    if (waiter) {
      if (this.seqEcho === null && !waiter.anySeq) {
        this.seqEcho = frame.seq === waiter.seq;
        this.log?.info(`Device ${this.seqEcho ? 'echoes' : 'does not echo'} the frame sequence number${this.seqEcho ? '; replies are now matched by it' : ''}.`);
      }
      this.log?.rx(`${this._describe(frame)}${note}${idNote}`, shown);
      if (!frame.crcOk && waiter.strictCrc) return; // let it time out and retry
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.stats.unsolicited++;
    this.log?.rx(`(unsolicited) ${this._describe(frame)}${note}${idNote}`, shown);
    for (const fn of this.unsolicited) { try { fn(frame); } catch { /* listener error */ } }
  }

  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => sleep(this.gapMs), () => sleep(this.gapMs));
    return run;
  }

  async _send(frameBytes, text) {
    if (this.closed) throw new LinkError('Not connected', 'closed');
    let data = frameBytes;
    if (this.padTo && data.length < this.padTo) { data = new Uint8Array(this.padTo); data.set(frameBytes); }
    this.log?.tx(text, frameBytes);
    this.stats.tx++;
    try {
      await this.device.sendReport(this.reportId, data);
    } catch (e) {
      throw new LinkError(`sendReport failed: ${e.message ?? e}`, 'send');
    }
  }

  _nextSeq() { const s = this.seq; this.seq = (this.seq + 1) & 0xFFFF; return s; }

  _wait(match, seq, timeoutMs, strictCrc, anySeq = false) {
    return new Promise((resolve, reject) => {
      const w = { match, seq, resolve, reject, strictCrc, anySeq };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new LinkError('Timed out waiting for reply', 'timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  // GET with reply. `match(payload)` narrows which reply counts (e.g. band index).
  get(cmd, payload = [], { match, timeoutMs = this.timeoutMs, retries = this.retries } = {}) {
    return this._enqueue(async () => {
      let lastErr;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const seq = this._nextSeq();
        const bytes = encodeFrame('get', cmd, payload, seq);
        const frame = decodeFrame(bytes);
        const wait = this._wait((f) => f.kind === 'get' && f.cmd === cmd && (!match || match(f.payload)), seq, timeoutMs, true);
        try {
          await this._send(bytes, this._describe(frame) + (attempt ? ` (retry ${attempt})` : ''));
          return await wait;
        } catch (e) {
          wait.catch(() => {});
          lastErr = e;
          if (e.code === 'timeout') { this.stats.timeouts++; this.log?.warn(`No reply to ${this._describe(frame)} within ${timeoutMs} ms`); continue; }
          throw e;
        }
      }
      throw lastErr;
    });
  }

  // SET. Any reply carrying the same command within `listenMs` is logged and
  // returned, but none is required: verification is done by reading back.
  set(cmd, payload = [], { listenMs = 60 } = {}) {
    return this._enqueue(async () => {
      const seq = this._nextSeq();
      const bytes = encodeFrame('set', cmd, payload, seq);
      const frame = decodeFrame(bytes);
      const wait = this._wait((f) => f.cmd === cmd && (f.kind === 'set' || payloadEquals(f.payload, payload)), seq, listenMs, false, true);
      try {
        await this._send(bytes, this._describe(frame));
      } catch (e) {
        wait.catch(() => {});
        throw e;
      }
      try { return await wait; } catch { return null; }
    });
  }

  // Run a block of commands without other queued work interleaving.
  idle() { return this.queue; }
}

function payloadEquals(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex4 = (v) => (v ?? 0).toString(16).toUpperCase().padStart(4, '0');

export { CMD, hexBytes };
