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
    this.framing = 'current'; // or 'legacy' (seq 00 00, checksum 00)
    this.prefix = [];         // bytes put in front of the frame inside the report (e.g. [0x07])
    this.stats = { tx: 0, frames: 0, crcBad: 0, timeouts: 0, unsolicited: 0, empty: 0, emptyNearTx: 0, unparsed: 0 };
    this.lastTxAt = 0;
    this._quiet = { empty: 0, emptyNearTx: 0, unparsed: 0, since: 0, timer: null, seenUnparsed: new Set() };
    this._onInput = (ev) => this._handleInput(ev);
  }

  async open() {
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this._onInput);
    this.padTo = outputReportLength(this.device, this.reportId);
    this.usesReportIds = (this.device.collections ?? []).some((c) => [...(c.inputReports ?? []), ...(c.outputReports ?? [])].some((r) => (r.reportId ?? 0) !== 0));
    this.log?.info(`Opened "${this.device.productName}" VID 0x${hex4(this.device.vendorId)} PID 0x${hex4(this.device.productId)}; using output report ${this.reportId}${this.padTo ? ` (${this.padTo} bytes)` : ' (length unknown, not padded)'}`);
  }

  // Choose how frames are carried. Used by the connection probe.
  setEncoding({ reportId = this.reportId, prefix = this.prefix, framing = this.framing } = {}) {
    this.reportId = reportId;
    this.prefix = prefix;
    this.framing = framing;
    this.padTo = outputReportLength(this.device, reportId);
  }

  async close() {
    this.closed = true;
    this._flushQuiet(true);
    this.device.removeEventListener('inputreport', this._onInput);
    this._failAll(new LinkError('Connection closed', 'closed'));
    try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
  }

  markDisconnected() {
    this.closed = true;
    this._flushQuiet(true);
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
    const idNote = ev.reportId !== undefined && ev.reportId !== this.reportId ? ` [input report ${ev.reportId}]` : '';
    // Reports that are all zeros carry nothing. Some devices send them on every
    // USB poll, so they are counted and summarised instead of logged one by one.
    if (data.every((b) => b === 0)) {
      this.stats.empty++;
      const near = Date.now() - this.lastTxAt < 150;
      if (near) this.stats.emptyNearTx++;
      this._noteQuiet('empty', near, () => `Input report ${ev.reportId ?? '?'} arrives as ${data.length} zero bytes. These carry no data; from now on they are counted and summarised every few seconds instead of logged.`);
      return;
    }
    // Frames normally start at byte 0. A firmware that carries the report ID
    // inside the data puts one byte (07) in front, so look a little further.
    let off = 0;
    while (off < 3 && !isHeader(data, off)) off++;
    if (off === 3) off = 0;
    const frame = decodeFrame(off ? data.subarray(off) : data);
    if (off) frame.offset = off;
    const shown = frame.payload ? data.slice(0, off + 8 + frame.payload.length) : data;
    if (frame.valid && off) frame.note = ` [frame at byte ${off}, after ${hexBytes(data.slice(0, off))}]`;
    if (!frame.valid) {
      this.stats.unparsed++;
      const key = `${ev.reportId}:${hexBytes(data.slice(0, 16))}`;
      if (this._quiet.seenUnparsed.size < 12 && !this._quiet.seenUnparsed.has(key)) {
        this._quiet.seenUnparsed.add(key);
        this.log?.rx(`unparsed report${idNote} (${frame.error ?? 'bad frame'}, ${data.length} bytes)`, data);
      } else {
        this._noteQuiet('unparsed', false, null);
      }
      return;
    }
    this.stats.frames++;
    // A CRC mismatch is logged but not fatal: USB already protects the bytes,
    // and FiiO's own app does not check most reply checksums.
    let note = '';
    if (!frame.crcOk) { note = frame.crc === 0 ? ' (checksum 00, legacy style)' : ' CRC MISMATCH'; this.stats.crcBad++; }
    // Once the device has shown it echoes our sequence number, require it, so
    // an echo of an earlier SET can never pass as the reply to a later GET.
    const waiter = this.waiters.find((w) => w.match(frame) && (this.seqEcho !== true || w.anySeq || frame.seq === w.seq));
    if (waiter) {
      if (this.seqEcho === null && !waiter.anySeq) {
        this.seqEcho = frame.seq === waiter.seq;
        this.log?.info(`Device ${this.seqEcho ? 'echoes' : 'does not echo'} the frame sequence number${this.seqEcho ? '; replies are now matched by it' : ''}.`);
      }
      this.log?.rx(`${this._describe(frame)}${note}${frame.note ?? ''}${idNote}`, shown);
      if (!frame.crcOk && waiter.strictCrc) return; // let it time out and retry
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    this.stats.unsolicited++;
    this.log?.rx(`(unsolicited) ${this._describe(frame)}${note}${frame.note ?? ''}${idNote}`, shown);
    for (const fn of this.unsolicited) { try { fn(frame); } catch { /* listener error */ } }
  }

  _noteQuiet(kind, nearTx, firstMessage) {
    const q = this._quiet;
    if (kind === 'empty' && this.stats.empty === 1 && firstMessage) this.log?.info(firstMessage());
    q[kind]++;
    if (nearTx) q.emptyNearTx++;
    if (!q.since) q.since = Date.now();
    if (!q.timer) q.timer = setTimeout(() => this._flushQuiet(), 5000);
  }

  _flushQuiet(final = false) {
    const q = this._quiet;
    clearTimeout(q.timer);
    q.timer = null;
    if (!q.empty && !q.unparsed) return;
    const secs = Math.max(0.001, (Date.now() - q.since) / 1000);
    const parts = [];
    if (q.empty) parts.push(`${q.empty} all-zero reports (${(q.empty / secs).toFixed(1)}/s; ${q.emptyNearTx} within 150 ms after a command we sent)`);
    if (q.unparsed) parts.push(`${q.unparsed} more unparsed reports`);
    this.log?.info(`Ignored ${parts.join(' and ')} in the last ${secs.toFixed(1)} s${final ? ' (final count)' : ''}.`);
    q.empty = 0; q.emptyNearTx = 0; q.unparsed = 0; q.since = 0;
  }

  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => sleep(this.gapMs), () => sleep(this.gapMs));
    return run;
  }

  async _send(frameBytes, text) {
    if (this.closed) throw new LinkError('Not connected', 'closed');
    const body = this.prefix.length ? Uint8Array.from([...this.prefix, ...frameBytes]) : frameBytes;
    let data = body;
    if (this.padTo && data.length < this.padTo) { data = new Uint8Array(this.padTo); data.set(body); }
    this.log?.tx(`${text}${this.reportId !== 7 || this.prefix.length ? ` [report ${this.reportId}${this.prefix.length ? ', data starts ' + hexBytes(this.prefix) : ''}]` : ''}`, body);
    this.stats.tx++;
    this.lastTxAt = Date.now();
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
        const legacy = this.framing === 'legacy';
        const seq = legacy ? 0 : this._nextSeq();
        const bytes = encodeFrame('get', cmd, payload, seq, { legacy });
        const frame = decodeFrame(bytes);
        const wait = this._wait((f) => f.kind === 'get' && f.cmd === cmd && (!match || match(f.payload)), seq, timeoutMs, false, legacy);
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
      const legacy = this.framing === 'legacy';
      const seq = legacy ? 0 : this._nextSeq();
      const bytes = encodeFrame('set', cmd, payload, seq, { legacy });
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

function isHeader(d, i) {
  return (d[i] === 0xBB && d[i + 1] === 0x0B) || (d[i] === 0xAA && d[i + 1] === 0x0A);
}

function payloadEquals(a, b) {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex4 = (v) => (v ?? 0).toString(16).toUpperCase().padStart(4, '0');

export { CMD, hexBytes };
