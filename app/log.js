// A copyable log of everything sent to and received from the device.

export class TrafficLog {
  constructor({ limit = 5000 } = {}) {
    this.entries = [];
    this.limit = limit;
    this.listeners = new Set();
    this.t0 = Date.now();
  }

  add(kind, text, bytes = null) {
    const e = { t: Date.now(), kind, text, hex: bytes ? toHex(bytes) : null };
    this.entries.push(e);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    for (const l of this.listeners) l(e);
    return e;
  }

  info(text) { return this.add('info', text); }
  warn(text) { return this.add('warn', text); }
  error(text) { return this.add('error', text); }
  tx(text, bytes) { return this.add('tx', text, bytes); }
  rx(text, bytes) { return this.add('rx', text, bytes); }

  onEntry(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  clear() { this.entries = []; this.t0 = Date.now(); for (const l of this.listeners) l(null); }

  format(e) {
    const ts = new Date(e.t).toISOString().slice(11, 23);
    const tag = { tx: 'TX >', rx: 'RX <', info: 'INFO', warn: 'WARN', error: 'ERR!' }[e.kind] ?? e.kind;
    return `${ts} ${tag} ${e.text}${e.hex ? `\n               ${e.hex}` : ''}`;
  }

  toText(header = '') {
    return (header ? header + '\n' : '') + this.entries.map((e) => this.format(e)).join('\n') + '\n';
  }
}

function toHex(bytes) {
  return Array.from(bytes, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
