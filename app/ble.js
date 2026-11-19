// Transport: FiiO's GAIA-over-BLE control channel through Web Bluetooth (or
// the simulator, which implements the few Web Bluetooth objects used here).
//
// Same rules as the USB link: one command in flight, replies matched by
// command and content (band index, preset index), timeouts with retries,
// everything logged, nothing substituted on failure.

import { GAIA_SERVICE, GAIA_COMMAND, GAIA_RESPONSE, encodeGaia, decodeGaia, describeGaia, isSetCommand, encodeGaiaSpp, decodeGaiaSpp, GaiaStreamParser } from './gaia.js';
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
    this.encode = encodeGaia;
    this.decode = decodeGaia;
  }

  async open() {
    const d = this.device;
    this.log?.info(`Connecting over Bluetooth to "${d.name ?? 'unnamed device'}" (id ${d.id ?? '?'})…`);
    d.addEventListener('gattserverdisconnected', this._onGone);
    await this._attach();
    this.closed = false;
  }

  // Connect GATT and find the GAIA characteristics (also used to reconnect).
  async _attach() {
    const d = this.device;
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
    if (this._reattaching) return; // a reconnect attempt is in progress
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
    this._handlePacket(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }

  _handlePacket(data) {
    const f = (this.decodeIn ?? this.decode)(data);
    if (!f.valid || f.kind !== 'reply') {
      this.stats.unparsed++;
      this.log?.rx(`packet not understood (${f.error ?? f.kind})`, data);
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

  async _rawWrite(bytes) {
    if (this.withResponse && this.cmdChar.writeValueWithResponse) await this.cmdChar.writeValueWithResponse(bytes);
    else if (this.cmdChar.writeValueWithoutResponse) await this.cmdChar.writeValueWithoutResponse(bytes);
    else await this.cmdChar.writeValue(bytes);
  }

  async _write(bytes, text) {
    if (this.closed) throw new LinkError('Not connected', 'closed');
    this.log?.tx(text, bytes);
    this.stats.tx++;
    try {
      await this._rawWrite(bytes);
    } catch (e0) {
      let e = e0;
      // The GAIA command characteristic needs an encrypted (paired) LE link.
      // When it is missing, Chrome/Edge pair on demand; while that pairing is
      // pending (or waiting for you to confirm it) writes fail with "already
      // in progress". Wait for it rather than giving up at once.
      for (let i = 0; i < 8 && /in progress/i.test(`${e.message ?? e}`); i++) {
        if (i === 0) this.log?.warn('Bluetooth says a connection or pairing is in progress; waiting for it (accept any pairing prompt from Windows or the browser)…');
        await sleep(1500);
        try { await this._rawWrite(bytes); return; } catch (e2) { e = e2; }
      }
      const msg = `${e.message ?? e}`;
      // The BTR15 refuses commands from a device it is not paired with.
      if (/authenticat|insufficient|encrypt|not paired|pairing|in progress/i.test(msg)) {
        this.authFailed = true;
        throw new LinkError(`Bluetooth write failed: ${msg}`, 'auth');
      }
      // A dropped link: wait for the browser to settle, reconnect once, retry once.
      if (/connection|disconnected|gatt/i.test(msg) && !this.closed) {
        this.log?.warn(`Bluetooth write failed (${msg}); reconnecting once and retrying.`);
        try {
          await this._reattach();
          await this._rawWrite(bytes);
          return;
        } catch (e2) {
          const m2 = `${e2.message ?? e2}`;
          if (/authenticat|insufficient|encrypt|not paired|pairing/i.test(m2)) { this.authFailed = true; throw new LinkError(`Bluetooth write failed: ${m2}`, 'auth'); }
          throw new LinkError(`Bluetooth write failed after reconnecting: ${m2}`, 'send');
        }
      }
      throw new LinkError(`Bluetooth write failed: ${msg}`, 'send');
    }
  }

  async _reattach() {
    this._reattaching = true;
    try {
      for (let i = 0; i < 6 && !this.device.gatt.connected; i++) {
        await sleep(500);
        try { await this._attach(); } catch (e) { if (i === 5) throw e; }
      }
      if (!this.device.gatt.connected) await this._attach();
    } finally {
      this._reattaching = false;
    }
  }

  // Registers for a reply right away (it can arrive before the write call
  // returns); the timeout only starts once start() is called after the write.
  _wait(match, timeoutMs) {
    let w;
    const promise = new Promise((resolve, reject) => {
      w = { match, resolve, reject };
      this.waiters.push(w);
    });
    promise.start = () => {
      if (!this.waiters.includes(w)) return;
      w.timer = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        w.reject(new LinkError('Timed out waiting for reply', 'timeout'));
      }, timeoutMs);
    };
    promise.cancel = () => {
      const i = this.waiters.indexOf(w);
      if (i >= 0) this.waiters.splice(i, 1);
      clearTimeout(w.timer);
    };
    return promise;
  }

  // Read with reply. `match(data)` narrows which reply counts.
  get(cmd, data = [], { match, timeoutMs = this.timeoutMs, retries = this.retries } = {}) {
    return this._enqueue(async () => {
      let last;
      for (let attempt = 0; attempt <= retries; attempt++) {
        const bytes = this.encode(cmd, data);
        const f = this.decode(bytes);
        const wait = this._wait((r) => r.cmd === cmd && (r.status !== 0 || !match || match(r.data)), timeoutMs);
        try {
          await this._write(bytes, this._describe(f) + (attempt ? ` (retry ${attempt})` : ''));
          wait.start();
          const r = await wait;
          if (r.status !== 0) throw new LinkError(`The device answered ${this._describe(f)} with status 0x${r.status.toString(16).padStart(2, '0')}`, 'status');
          return r;
        } catch (e) {
          wait.cancel();
          wait.catch(() => {});
          last = e;
          if (e.code === 'timeout') { this.stats.timeouts++; this.log?.warn(`No reply to ${this._describe(f)} within ${timeoutMs} ms`); continue; }
          throw e; // auth, send and status errors are not retried here
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
      const bytes = this.encode(cmd, data);
      const f = this.decode(bytes);
      const wait = this._wait((r) => r.cmd === cmd, listenMs);
      try {
        await this._write(bytes, this._describe(f));
      } catch (e) {
        wait.cancel();
        wait.catch(() => {});
        throw e;
      }
      wait.start();
      let r = null;
      try { r = await wait; } catch { this.log?.info(`(no acknowledgement for ${this._describe(f)} within ${listenMs} ms)`); }
      if (r && r.status !== 0) throw new LinkError(`The device refused ${this._describe(f)} with status 0x${r.status.toString(16).padStart(2, '0')}`, 'status');
      return r;
    });
  }

  idle() { return this.queue; }
}

// Classic Bluetooth: the same GAIA commands over a serial port (SPP/RFCOMM),
// through Web Serial. On Windows the BTR15's serial service appears as a
// "Standard Serial over Bluetooth link" COM port once it is paired.
export class SppLink extends BleLink {
  constructor(port, opts = {}) {
    super(port, { timeoutMs: 2000, ...opts });
    this.port = port;
    this.transport = 'bluetooth-serial';
    this.encode = encodeGaiaSpp;
    this.decode = decodeGaiaSpp;
    this.decodeIn = (b) => decodeGaiaSpp(b, { incoming: true });
    this.parser = new GaiaStreamParser();
  }

  async open() {
    const info = this.port.getInfo?.() ?? {};
    this.log?.info(`Opening serial port ${JSON.stringify(info)}…`);
    try {
      await this.port.open({ baudRate: 115200 });
    } catch (e) {
      throw new LinkError(`Could not open the serial port: ${e.message}`, 'open');
    }
    this.writer = this.port.writable.getWriter();
    this.closed = false;
    this._readLoop();
    this.log?.info('Serial port open.');
  }

  async _readLoop() {
    try {
      this.reader = this.port.readable.getReader();
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value?.length) continue;
        const { packets, junk } = this.parser.push(value);
        if (junk) { this.stats.unparsed++; this.log?.rx('bytes outside a GAIA packet', junk); }
        for (const pkt of packets) this._handlePacket(pkt);
        clearTimeout(this._flushTimer);
        if (this.parser.buf.length) {
          this._flushTimer = setTimeout(() => {
            const rest = this.parser.flush();
            if (rest) { this.stats.unparsed++; this.log?.rx('incomplete packet (length did not match)', rest); }
          }, 300);
        }
      }
    } catch (e) {
      if (!this.closed) this.log?.warn(`Serial read stopped: ${e.message}`);
    } finally {
      try { this.reader?.releaseLock(); } catch { /* ignore */ }
      if (!this.closed) this._gone();
    }
  }

  async _rawWrite(bytes) {
    await this.writer.write(bytes);
  }

  async _write(bytes, text) {
    if (this.closed) throw new LinkError('Not connected', 'closed');
    this.log?.tx(text, bytes);
    this.stats.tx++;
    try {
      await this._rawWrite(bytes);
    } catch (e) {
      throw new LinkError(`Serial write failed: ${e.message ?? e}`, 'send');
    }
  }

  async close() {
    this.closed = true;
    this._failAll(new LinkError('Connection closed', 'closed'));
    clearTimeout(this._flushTimer);
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { this.writer?.releaseLock(); } catch { /* ignore */ }
    try { await this.port.close(); } catch { /* ignore */ }
  }

  _gone() {
    if (this.closed && !this.waiters.length) return;
    this.closed = true;
    this.log?.warn('Serial (Bluetooth) connection lost.');
    this._failAll(new LinkError('Device disconnected', 'disconnected'));
    this.onDisconnect?.();
  }
}
