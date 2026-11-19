// A copyable log of everything sent to and received from the device.

export class TrafficLog {
  // The first `keepHead` entries (connection details, first replies) are kept
  // for good, so a flood later on cannot push them out of a copied log.
  constructor({ limit = 5000, keepHead = 300 } = {}) {
    this.head = [];
    this.entries = [];
    this.dropped = 0;
    this.limit = limit;
    this.keepHead = keepHead;
    this.listeners = new Set();
    this.t0 = Date.now();
  }

  add(kind, text, bytes = null) {
    const e = { t: Date.now(), kind, text, hex: bytes ? toHex(bytes) : null };
    if (this.head.length < this.keepHead) this.head.push(e);
    else {
      this.entries.push(e);
      if (this.entries.length > this.limit) { const n = this.entries.length - this.limit; this.entries.splice(0, n); this.dropped += n; }
    }
    for (const l of this.listeners) l(e);
    return e;
  }

  info(text) { return this.add('info', text); }
  warn(text) { return this.add('warn', text); }
  error(text) { return this.add('error', text); }
  tx(text, bytes) { return this.add('tx', text, bytes); }
  rx(text, bytes) { return this.add('rx', text, bytes); }

  onEntry(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  clear() { this.head = []; this.entries = []; this.dropped = 0; this.t0 = Date.now(); for (const l of this.listeners) l(null); }

  format(e) {
    const ts = new Date(e.t).toISOString().slice(11, 23);
    const tag = { tx: 'TX >', rx: 'RX <', info: 'INFO', warn: 'WARN', error: 'ERR!' }[e.kind] ?? e.kind;
    return `${ts} ${tag} ${e.text}${e.hex ? `\n               ${e.hex}` : ''}`;
  }

  toText(header = '') {
    const gap = this.dropped ? [`… ${this.dropped} entries omitted …`] : [];
    const lines = [...this.head.map((e) => this.format(e)), ...gap, ...this.entries.map((e) => this.format(e))];
    return (header ? header + '\n' : '') + lines.join('\n') + '\n';
  }
}

function toHex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
