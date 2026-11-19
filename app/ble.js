// Transport: FiiO's GAIA-over-BLE control channel through Web Bluetooth (or
// the simulator, which implements the few Web Bluetooth objects used here).
//
// Same rules as the USB link: one command in flight, replies matched by
// command and content (band index, preset index), timeouts with retries,
// everything logged, nothing substituted on failure.

import { GAIA_SERVICE, GAIA_COMMAND, GAIA_RESPONSE, encodeGaia, decodeGaia, describeGaia, isSetCommand } from './gaia.js';
import { LinkError, sleep } from './device.js';
import { slotName } from './protocol.js';

export class BleLink {
  constructor(device, { log, timeoutMs = 1500, retries = 2, gapMs = 10, profile } = {}) {
    this.device = device;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.gapMs = gapMs;
    this.profile = profile;
    this.transport = 'bluetooth';
    this.queue = Promise.resolve();
    this.waiters = [];
    this.unsolicited = new Set();
    this.closed = true;
    this.stats = { tx: 0, frames: 0, timeouts: 0, unsolicited: 0, badStatus: 0, unparsed: 0 };
    this._onNotify = (ev) => this._handleNotify(ev);
    this._onGone = () => this._gone();
  }

  async open() {
    const d = this.device;
    this.log?.info(`Connecting over Bluetooth to "${d.name ?? 'unnamed device'}" (id ${d.id ?? '?'})…`);
    d.addEventListener('gattserverdisconnected', this._onGone);
    this.server = await d.gatt.connect();
    let service;
    try {
      service = await this.server.getPrimaryService(GAIA_SERVICE);
    } catch (e) {
      throw new LinkError(`The device has no Qualcomm GAIA service (${e.message}). Is this the BTR15?`, 'noservice');
    }
    this.cmdChar = await service.getCharacteristic(GAIA_COMMAND);
    this.respChar = await service.getCharacteristic(GAIA_RESPONSE);
    const p = this.cmdChar.properties ?? {};
    this.withResponse = !!p.write || !p.writeWithoutResponse;
    this.respChar.addEventListener('characteristicvaluechanged', this._onNotify);
    await this.respChar.startNotifications();
    this.closed = false;
    this.log?.info(`Connected. GAIA command characteristic: ${p.write ? 'write' : ''}${p.writeWithoutResponse ? ' write-without-response' : ''}; replies by notification.`);
  }

  async close() {
    this.closed = true;
    this._failAll(new LinkError('Connection closed', 'closed'));
    try { this.respChar?.removeEventListener('characteristicvaluechanged', this._onNotify); } catch { /* ignore */ }
    this.device.removeEventListener('gattserverdisconnected', this._onGone);
    try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* ignore */ }
  }

  markDisconnected() { this._gone(); }

  _gone() {
    if (this.closed && !this.waiters.length) return;
    this.closed = true;
    this.log?.warn('Bluetooth connection lost.');
    this._failAll(new LinkError('Device disconnected', 'disconnected'));
    this.onDisconnect?.();
  }

  onUnsolicited(fn) { this.unsolicited.add(fn); return () => this.unsolicited.delete(fn); }

  _failAll(err) {
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
  }

  _describe(f) { return describeGaia(f, { slotName: (id) => slotName(id, this.profile) }); }

  _handleNotify(ev) {
    const v = ev.target.value;
    const data = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const f = decodeGaia(data);
    if (!f.valid || f.kind !== 'reply') {
      this.stats.unparsed++;
      this.log?.rx(`notification not understood (${f.error ?? f.kind})`, data);
      return;
    }
    this.stats.frames++;
    if (f.status !== 0) this.stats.badStatus++;
    const w = this.waiters.find((x) => x.match(f));
    if (w) {
      this.log?.rx(this._describe(f), data);
      this.waiters.splice(this.waiters.indexOf(w), 1);
      clearTimeout(w.timer);
      w.resolve(f);
      return;
    }
    this.stats.unsolicited++;
    this.log?.rx(`(unsolicited) ${this._describe(f)}`, data);
    for (const fn of this.unsolicited) { try { fn(f); } catch { /* listener error */ } }
  }

  _enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(() => sleep(this.gapMs), () => sleep(this.gapMs));
    return run;
  }

  async _write(bytes, text) {
    if (this.closed) throw new LinkError('Not connected', 'closed');
    this.log?.tx(text, bytes);
    this.stats.tx++;
    try {
      if (this.withResponse && this.cmdChar.writeValueWithResponse) await this.cmdChar.writeValueWithResponse(bytes);
      else if (this.cmdChar.writeValueWithoutResponse) await this.cmdChar.writeValueWithoutResponse(bytes);
      else await this.cmdChar.writeValue(bytes);
    } catch (e) {
      throw new LinkError(`Bluetooth write failed: ${e.message ?? e}`, 'send');
    }
  }

  _wait(match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve, reject };
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new LinkError('Timed out waiting for reply', 'timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  // Read with reply. `match(data)` narrows which reply counts.
  get(cmd, data = [], { match, timeoutMs = this.timeoutMs, retries = this.retries } = {}) {
    return this._enqueue(async () => {
      let last;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const bytes = encodeGaia(cmd, data);
        const f = decodeGaia(bytes);
        const wait = this._wait((r) => r.cmd === cmd && (r.status !== 0 || !match || match(r.data)), timeoutMs);
        try {
          await this._write(bytes, this._describe(f) + (attempt ? ` (retry ${attempt})` : ''));
          const r = await wait;
          if (r.status !== 0) throw new LinkError(`The device answered ${this._describe(f)} with status 0x${r.status.toString(16).padStart(2, '0')}`, 'status');
          return r;
        } catch (e) {
          wait.catch(() => {});
          last = e;
          if (e.code === 'timeout') { this.stats.timeouts++; this.log?.warn(`No reply to ${this._describe(f)} within ${timeoutMs} ms`); continue; }
          throw e;
        }
      }
      throw last;
    });
  }

  // Write. The BTR15 acknowledges writes with a reply carrying the same
  // command; it is waited for (and a bad status reported) but not required.
  set(cmd, data = [], { listenMs = 1200 } = {}) {
    if (!isSetCommand(cmd)) throw new Error('set() needs a write command');
    return this._enqueue(async () => {
      const bytes = encodeGaia(cmd, data);
      const f = decodeGaia(bytes);
      const wait = this._wait((r) => r.cmd === cmd, listenMs);
      try {
        await this._write(bytes, this._describe(f));
      } catch (e) {
        wait.catch(() => {});
        throw e;
      }
      let r = null;
      try { r = await wait; } catch { this.log?.info(`(no acknowledgement for ${this._describe(f)} within ${listenMs} ms)`); }
      if (r && r.status !== 0) throw new LinkError(`The device refused ${this._describe(f)} with status 0x${r.status.toString(16).padStart(2, '0')}`, 'status');
      return r;
    });
  }

  idle() { return this.queue; }
}
