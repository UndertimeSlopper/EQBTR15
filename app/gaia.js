// FiiO's BTR15 Bluetooth control protocol: FiiO commands carried in Qualcomm
// GAIA packets over BLE GATT. Learned from the FiiO Control Android app
// (see docs/PROTOCOL.md); no FiiO code is copied.
//
// GATT (standard Qualcomm GAIA):
//   service   00001100-d102-11e1-9b23-00025b00a5a5
//   command   00001101-…  written with response
//   response  00001102-…  notifications
//
// Packets. FiiO's 16-bit command 0xHHLL rides as GAIA command 0x04HH with LL
// as the first payload byte:
//   request   00 0A 04 HH LL [data…]
//   reply     00 0A 84 HH ST LL [data…]      ST = status, 00 = success
//
// Reads are 0x0Fxx-style commands; the matching write is the same number
// with 0x1000 added (0x0302 read band, 0x1302 write band).
//
// SAFETY: only the commands in BT_ALLOWED can be encoded. In particular the
// app's "reset preset" (0x1309) and rename (0x130B) are refused.

export const GAIA_SERVICE = '00001100-d102-11e1-9b23-00025b00a5a5';
export const GAIA_COMMAND = '00001101-d102-11e1-9b23-00025b00a5a5';
export const GAIA_RESPONSE = '00001102-d102-11e1-9b23-00025b00a5a5';

export const BT = {
  VERSION: 0x0002,      // reply [major, minor]
  BATTERY: 0x0003,      // reply [percent]
  EQ_SWITCH: 0x0301,    // reply [0/1]
  BAND: 0x0302,         // request [custom index, band]; reply [index, band, gain16, freq16, q16, type]
  PRESET: 0x0304,       // reply [preset id]
  GLOBAL_GAIN: 0x0308,  // request [custom index]; reply [index, gain16]
  NAME: 0x030B,         // request [custom index]; reply [index, chars…]
  SET_EQ_SWITCH: 0x1301,
  SET_BAND: 0x1302,     // [custom index, band, gain16, freq16, q16, type (firmware >= 2.5)]
  SET_PRESET: 0x1304,   // [preset id]
  SET_GLOBAL_GAIN: 0x1308, // [custom index, gain16]
};

export const BT_NAMES = {
  0x0002: 'VERSION', 0x0003: 'BATTERY', 0x0301: 'EQ_SWITCH', 0x0302: 'BAND', 0x0304: 'PRESET',
  0x0307: 'EQ_FLAG_0307', 0x0308: 'GLOBAL_GAIN', 0x030B: 'PRESET_NAME',
  0x1301: 'SET_EQ_SWITCH', 0x1302: 'SET_BAND', 0x1304: 'SET_PRESET', 0x1308: 'SET_GLOBAL_GAIN',
  0x1309: 'RESET_PRESET', 0x130B: 'SET_PRESET_NAME',
};

export const BT_ALLOWED = new Set([
  BT.VERSION, BT.BATTERY, BT.EQ_SWITCH, BT.BAND, BT.PRESET, BT.GLOBAL_GAIN, BT.NAME,
  BT.SET_EQ_SWITCH, BT.SET_BAND, BT.SET_PRESET, BT.SET_GLOBAL_GAIN,
]);

export const isSetCommand = (cmd) => (cmd & 0xF000) === 0x1000;

export function encodeGaia(cmd, data = []) {
  if (!BT_ALLOWED.has(cmd)) {
    throw new Error(`Refusing to send Bluetooth command 0x${hex4(cmd)} (${BT_NAMES[cmd] ?? 'unknown'}): not on this app's allowlist.`);
  }
  for (const b of data) if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`Bad payload byte ${b}`);
  return Uint8Array.from([0x00, 0x0A, 0x04, (cmd >> 8) & 0xFF, cmd & 0xFF, ...data]);
}

// Decode either direction. Returns { kind: 'request'|'reply', cmd, status?, data }.
export function decodeGaia(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length);
  if (b.length < 5 || b[0] !== 0x00 || b[1] !== 0x0A) return { valid: false, raw: b, error: 'not a FiiO GAIA packet' };
  if (b[2] === 0x04) return { valid: true, kind: 'request', cmd: (b[3] << 8) | b[4], data: b.slice(5), raw: b };
  if (b[2] === 0x84) {
    if (b.length < 6) return { valid: true, kind: 'reply', cmd: b[3] << 8, status: b[4], data: new Uint8Array(0), short: true, raw: b };
    return { valid: true, kind: 'reply', cmd: (b[3] << 8) | b[5], status: b[4], data: b.slice(6), raw: b };
  }
  return { valid: false, raw: b, error: `unknown GAIA command byte 0x${b[2].toString(16)}` };
}

// ── Field codecs (big-endian, as on USB) ────────────────────────────────────
const u16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
const s16 = (v) => u16(v < 0 ? v + 0x10000 : v);
const rU16 = (p, i) => (p[i] << 8) | p[i + 1];
const rS16 = (p, i) => { const v = rU16(p, i); return v & 0x8000 ? v - 0x10000 : v; };
const TYPE_CODE = { PK: 0, LS: 1, HS: 2 };
const TYPE_NAME = { 0: 'PK', 1: 'LS', 2: 'HS', 3: 'BP', 4: 'LP', 5: 'HP', 6: 'AP' };

export function encodeBandBt(customIndex, { index, type, freq, gain, q }, { withType = true } = {}) {
  const code = TYPE_CODE[type];
  if (code === undefined) throw new Error(`Unsupported filter type ${type}`);
  const out = [customIndex, index, ...s16(Math.round(gain * 10)), ...u16(Math.round(freq)), ...u16(Math.round(q * 100))];
  if (withType) out.push(code);
  return out;
}

export function decodeBandBt(d) {
  if (!d || d.length < 8) return null;
  const typeCode = d.length >= 9 ? d[8] : 0;
  return {
    customIndex: d[0],
    index: d[1],
    gain: rS16(d, 2) / 10,
    freq: rU16(d, 4),
    q: rU16(d, 6) / 100,
    typeCode,
    type: TYPE_NAME[typeCode] ?? `type${typeCode}`,
    hasType: d.length >= 9,
  };
}

export const encodeGainBt = (customIndex, db) => [customIndex, ...s16(Math.round(db * 10))];
export const decodeGainBt = (d) => (d && d.length >= 3 ? { customIndex: d[0], gain: rS16(d, 1) / 10 } : null);

export function describeGaia(f, { slotName } = {}) {
  if (!f.valid) return f.error ?? 'unparsed';
  const name = BT_NAMES[f.cmd] ?? `cmd 0x${hex4(f.cmd)}`;
  const d = f.data ?? [];
  const st = f.kind === 'reply' ? (f.status === 0 ? '' : ` STATUS 0x${f.status.toString(16).padStart(2, '0')}`) : '';
  const pre = f.kind === 'request' ? '' : 'reply ';
  const sn = (id) => (slotName ? `${slotName(id)} (${id})` : String(id));
  const g = (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
  switch (f.cmd) {
    case BT.BAND: case BT.SET_BAND: {
      if (d.length === 2) return `${pre}${name} preset #${d[0]} band ${d[1]}${st}`;
      const b = decodeBandBt(d);
      return b ? `${pre}${name} preset #${b.customIndex} band ${b.index}: ${b.type} ${b.freq} Hz ${g(b.gain)} dB Q ${b.q.toFixed(2)}${b.hasType ? '' : ' (no type byte)'}${st}` : `${pre}${name}${st}`;
    }
    case BT.GLOBAL_GAIN: case BT.SET_GLOBAL_GAIN: {
      const x = decodeGainBt(d);
      if (x) return `${pre}${name} preset #${x.customIndex} ${g(x.gain)} dB${st}`;
      return `${pre}${name}${d.length ? ` preset #${d[0]}` : ''}${st}`;
    }
    case BT.PRESET: case BT.SET_PRESET:
      return `${pre}${name}${d.length ? ' ' + sn(d[0]) : ''}${st}`;
    case BT.EQ_SWITCH: case BT.SET_EQ_SWITCH:
      return `${pre}${name}${d.length ? (d[0] ? ' on' : ' off') : ''}${st}`;
    case BT.VERSION:
      return `${pre}${name}${d.length >= 2 ? ` ${d[0]}.${d[1]}` : ''}${st}`;
    case BT.BATTERY:
      return `${pre}${name}${d.length ? ` ${d[0]}%` : ''}${st}`;
    case BT.NAME:
      return `${pre}${name}${d.length ? ` #${d[0]}${d.length > 1 ? ' "' + String.fromCharCode(...Array.from(d.slice(1)).filter((c) => c)) + '"' : ''}` : ''}${st}`;
    default:
      return `${pre}${name}${d.length ? ' [' + Array.from(d, (x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ') + ']' : ''}${st}`;
  }
}

// BTR15 over Bluetooth (FiiO Control's device type 24).
export const BTR15_BT = {
  name: 'FiiO BTR15 (Bluetooth)',
  transport: 'bluetooth',
  expectedBands: 10,
  presetSwitchDelayMs: 600,
  userSlots: [4, 8, 9],
  customIndex: { 4: 0, 8: 1, 9: 2 },
  slots: [
    { id: 0, name: 'Jazz' }, { id: 1, name: 'Pop' }, { id: 2, name: 'Rock' }, { id: 3, name: 'Dance' },
    { id: 4, name: 'USER1', user: true }, { id: 5, name: 'R&B' }, { id: 6, name: 'Classical' },
    { id: 7, name: 'Hip-hop' }, { id: 8, name: 'USER2', user: true }, { id: 9, name: 'USER3', user: true },
  ],
  defaultFreqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  limits: { freq: [20, 20000], gain: [-12, 12], q: [0.25, 8], globalGain: [-12, 12] },
  types: ['PK', 'LS', 'HS'],
  typeByteFromFirmware: 2.5, // FiiO's app only sends the filter type on firmware 2.5 and newer
};

function hex4(v) { return v.toString(16).toUpperCase().padStart(4, '0'); }

// ── Classic Bluetooth: GAIA over the serial port profile (RFCOMM) ───────────
// FiiO Control uses this when the BTR15 is already connected for audio,
// through an insecure RFCOMM socket to the standard SPP UUID. On Windows a
// paired device's SPP shows up as a "Standard Serial over Bluetooth link"
// COM port, which Web Serial can open.
//
//   request  FF 03 00 LEN 00 1D CC HH LL [data]      LEN = data length + 1
//   reply    FF 03 00 LEN 00 1D xx HH ST LL [data]   (FiiO's app skips 7 bytes,
//                                                     then reads HH, ST, LL)
// A packet is 8 + LEN bytes (+1 checksum byte if flags bit 0 is set).

export const SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
// Qualcomm's own GAIA serial service. Qualcomm's GAIA library uses SPP if a
// device offers it and this otherwise; Windows makes no COM port for it, but
// Web Serial can open it directly on a paired device.
export const GAIA_SPP_UUID = '00001107-d102-11e1-9b23-00025b00a5a5';

export function encodeGaiaSpp(cmd, data = []) {
  const body = encodeGaia(cmd, data); // validates against the allowlist
  const d = Array.from(body.slice(5));
  if (d.length + 1 > 254) throw new Error('Payload too long');
  return Uint8Array.from([0xFF, 0x03, 0x00, d.length + 1, 0x00, 0x1D, 0xCC, (cmd >> 8) & 0xFF, cmd & 0xFF, ...d]);
}

// `incoming`: everything the device sends is treated as a reply, whatever
// its command byte says.
export function decodeGaiaSpp(input, { incoming = false } = {}) {
  const b = input instanceof Uint8Array ? input : Uint8Array.from(input);
  if (b.length < 10 || b[0] !== 0xFF) return { valid: false, raw: b, error: 'not a GAIA serial packet' };
  const end = b.length - ((b[2] & 1) ? 1 : 0);
  if (b[6] === 0xCC && !incoming) {
    return { valid: true, kind: 'request', cmd: (b[7] << 8) | b[8], data: b.slice(9, end), raw: b };
  }
  return { valid: true, kind: 'reply', cmd: (b[7] << 8) | b[9], status: b[8], data: b.slice(10, end), raw: b, vendor: (b[4] << 8) | b[5], cmdHi: b[6] };
}

// Splits a serial byte stream into GAIA packets. Bytes before a 0xFF start
// byte, or a packet that never completes, come back as `junk` for the log.
export class GaiaStreamParser {
  constructor() { this.buf = []; }
  push(chunk) {
    for (const x of chunk) this.buf.push(x);
    const packets = [];
    const junk = [];
    for (;;) {
      if (!this.buf.length) break;
      if (this.buf[0] !== 0xFF) { junk.push(this.buf.shift()); continue; }
      if (this.buf.length < 4) break;
      const total = 8 + this.buf[3] + ((this.buf[2] & 1) ? 1 : 0);
      if (this.buf.length < total) break;
      packets.push(Uint8Array.from(this.buf.splice(0, total)));
    }
    return { packets, junk: junk.length ? Uint8Array.from(junk) : null };
  }
  // Whatever is left over (used after a pause, so a mis-framed reply still shows up).
  flush() { const b = this.buf; this.buf = []; return b.length ? Uint8Array.from(b) : null; }
}
