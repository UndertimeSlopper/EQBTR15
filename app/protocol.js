// FiiO USB-HID control protocol, as far as this app needs it.
//
// Frame layout (learned from FiiO's own web app at fiiocontrol.fiio.com and
// cross-checked against devicePEQ):
//
//   [h1, h2, seqHi, seqLo, cmd, len, ...payload(len), crc8, 0xEE]
//
//   h1 h2   AA 0A for SET, BB 0B for GET (device replies also use BB 0B)
//   seq     16-bit counter; FiiO's current app increments it, older versions
//           (and devicePEQ) send 00 00
//   crc8    CRC-8/MAXIM (Dallas 1-Wire) over every byte before it; older
//           FiiO code sent 00 here
//
// The frame is sent as HID output report 7 on the BTR15, zero-padded to the
// report length from the device's HID descriptor.
//
// SAFETY: only the commands in ALLOWED can be encoded. Anything else, in
// particular resets (0x1B, 0x1C) and 0x21, which FiiO's current code calls
// RESET_TO_FACTORY, throws before a byte leaves the page.

export const FIIO_VENDOR_ID = 0x2972;
export const SET_HDR = [0xAA, 0x0A];
export const GET_HDR = [0xBB, 0x0B];
export const END = 0xEE;

export const CMD = {
  FIRMWARE_VERSION: 0x0B,
  PEQ_PARAMS: 0x15,
  PEQ_PRESET: 0x16,
  GLOBAL_GAIN: 0x17,
  PEQ_COUNT: 0x18,
  PEQ_SAVE: 0x19,
  PEQ_SWITCH: 0x1A,
};

// Names for the log, including commands this app refuses to send.
export const CMD_NAMES = {
  0x01: 'VOL_MAX', 0x02: 'VOL_OUTPUT', 0x04: 'FILTER_MODE', 0x07: 'VOL_BALANCE',
  0x0B: 'FIRMWARE_VERSION', 0x15: 'PEQ_PARAMS', 0x16: 'PEQ_PRESET', 0x17: 'GLOBAL_GAIN',
  0x18: 'PEQ_COUNT', 0x19: 'PEQ_SAVE', 0x1A: 'PEQ_SWITCH', 0x1B: 'RESET_PRESET',
  0x1C: 'RESET_ALL_PRESETS', 0x21: 'RESET_TO_FACTORY', 0x30: 'PEQ_NAME',
  0x60: 'PEQ_PRESET_V2', 0x61: 'PEQ_PRESET_PARAMS_V2',
};

export const ALLOWED = {
  get: new Set([CMD.FIRMWARE_VERSION, CMD.PEQ_PARAMS, CMD.PEQ_PRESET, CMD.GLOBAL_GAIN, CMD.PEQ_COUNT, CMD.PEQ_SWITCH]),
  set: new Set([CMD.PEQ_PARAMS, CMD.PEQ_PRESET, CMD.GLOBAL_GAIN, CMD.PEQ_SAVE, CMD.PEQ_SWITCH]),
};

export const FILTER_CODES = { PK: 0, LS: 1, HS: 2 };
export const FILTER_FROM_CODE = { 0: 'PK', 1: 'LS', 2: 'HS', 3: 'BP', 4: 'LP', 5: 'HP', 6: 'AP' };

// ── CRC-8/MAXIM: poly 0x31 reflected (0x8C), init 0 ─────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 1 ? (c >>> 1) ^ 0x8C : c >>> 1;
    t[i] = c;
  }
  return t;
})();

export function crc8(bytes, end = bytes.length) {
  let c = 0;
  for (let i = 0; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF];
  return c;
}

// ── Encoding ────────────────────────────────────────────────────────────────
export function encodeFrame(kind, cmd, payload = [], seq = 0) {
  if (kind !== 'get' && kind !== 'set') throw new Error(`Bad frame kind ${kind}`);
  if (!ALLOWED[kind].has(cmd)) {
    throw new Error(`Refusing to send ${kind.toUpperCase()} ${hex(cmd)} (${CMD_NAMES[cmd] ?? 'unknown'}): not on this app's allowlist.`);
  }
  if (payload.length > 56) throw new Error('Payload too long');
  for (const b of payload) if (!Number.isInteger(b) || b < 0 || b > 255) throw new Error(`Bad payload byte ${b}`);
  const hdr = kind === 'set' ? SET_HDR : GET_HDR;
  const body = [hdr[0], hdr[1], (seq >> 8) & 0xFF, seq & 0xFF, cmd, payload.length, ...payload];
  return Uint8Array.from([...body, crc8(body), END]);
}

// ── Decoding ────────────────────────────────────────────────────────────────
export function decodeFrame(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length);
  const out = { raw: b, valid: false };
  if (b.length < 8) return { ...out, error: 'short' };
  if (b[0] === SET_HDR[0] && b[1] === SET_HDR[1]) out.kind = 'set';
  else if (b[0] === GET_HDR[0] && b[1] === GET_HDR[1]) out.kind = 'get';
  else return { ...out, error: 'unknown header' };
  out.seq = (b[2] << 8) | b[3];
  out.cmd = b[4];
  const len = b[5];
  if (6 + len + 2 > b.length) return { ...out, error: 'truncated' };
  out.payload = b.slice(6, 6 + len);
  out.crc = b[6 + len];
  out.crcOk = out.crc === crc8(b, 6 + len);
  out.endOk = b[7 + len] === END;
  out.valid = out.endOk;
  return out;
}

// ── Field codecs (all big-endian) ───────────────────────────────────────────
export const u16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
export const s16 = (v) => u16(v < 0 ? v + 0x10000 : v);
export const readU16 = (p, i) => (p[i] << 8) | p[i + 1];
export const readS16 = (p, i) => { const v = readU16(p, i); return v & 0x8000 ? v - 0x10000 : v; };

export function encodeBand({ index, type, freq, gain, q }) {
  const code = typeof type === 'number' ? type : FILTER_CODES[type];
  if (code === undefined) throw new Error(`Unsupported filter type ${type}`);
  const g = Math.round(gain * 10);
  const f = Math.round(freq);
  const qq = Math.round(q * 100);
  if (f < 1 || f > 0xFFFF || qq < 1 || qq > 0xFFFF || g < -0x8000 || g > 0x7FFF) throw new Error('Band value out of range');
  return [index, ...s16(g), ...u16(f), ...u16(qq), code];
}

export function decodeBand(p) {
  if (!p || p.length < 8) return null;
  const code = p[7];
  return {
    index: p[0],
    gain: readS16(p, 1) / 10,
    freq: readU16(p, 3),
    q: readU16(p, 5) / 100,
    typeCode: code,
    type: FILTER_FROM_CODE[code] ?? `type${code}`,
  };
}

export const encodeGain = (db) => s16(Math.round(db * 10));
export const decodeGain = (p) => readS16(p, 0) / 10;

export function decodeUint(p) {
  let v = 0;
  for (const x of p) v = (v * 256) + x;
  return v;
}
export function encodeUint(v) {
  if (v < 256) return [v];
  return u16(v);
}

// ── Human-readable description for the log ─────────────────────────────────
export function describe(frame, { slotName } = {}) {
  if (!frame.kind) return 'unrecognised frame';
  const name = CMD_NAMES[frame.cmd] ?? `cmd ${hex(frame.cmd)}`;
  const p = frame.payload ?? [];
  const dir = frame.kind === 'set' ? 'SET' : 'GET';
  const sn = (id) => (slotName ? `${slotName(id)} (${id})` : String(id));
  switch (frame.cmd) {
    case CMD.PEQ_PARAMS: {
      if (p.length === 1) return `${dir} ${name} band ${p[0]}`;
      const b = decodeBand(p);
      return b ? `${dir} ${name} band ${b.index}: ${b.type} ${b.freq} Hz ${fmtGain(b.gain)} dB Q ${b.q.toFixed(2)}` : `${dir} ${name}`;
    }
    case CMD.GLOBAL_GAIN:
      return p.length >= 2 ? `${dir} ${name} ${fmtGain(decodeGain(p))} dB` : `${dir} ${name}`;
    case CMD.PEQ_PRESET:
      return p.length ? `${dir} ${name} ${sn(decodeUint(p))}` : `${dir} ${name}`;
    case CMD.PEQ_SAVE:
      return p.length ? `${dir} ${name} into ${sn(decodeUint(p))}` : `${dir} ${name}`;
    case CMD.PEQ_COUNT:
      return p.length ? `${dir} ${name} = ${p[0]}` : `${dir} ${name}`;
    case CMD.PEQ_SWITCH:
      return p.length ? `${dir} ${name} = ${p[0] ? 'on' : 'off'}` : `${dir} ${name}`;
    case CMD.FIRMWARE_VERSION:
      return p.length ? `${dir} ${name} = ${Array.from(p).join('.')}` : `${dir} ${name}`;
    default:
      return `${dir} ${name}${p.length ? ' [' + Array.from(p, (x) => hex(x)).join(' ') + ']' : ''}`;
  }
}

export function hex(x) { return x.toString(16).toUpperCase().padStart(2, '0'); }
export function hexBytes(bytes) { return Array.from(bytes, hex).join(' '); }
function fmtGain(g) { return (g > 0 ? '+' : '') + g.toFixed(1); }

// ── BTR15 profile (from FiiO's web app tables) ─────────────────────────────
export const BTR15 = {
  name: 'FiiO BTR15',
  productNames: ['FIIO BTR15'],
  reportId: 7,
  expectedBands: 10,
  presetSwitchDelayMs: 1000, // FiiO's app waits 1 s after a preset switch on the BTR15
  userSlots: [7, 8, 9],
  slots: [
    { id: 0, name: 'Jazz' }, { id: 1, name: 'Pop' }, { id: 2, name: 'Rock' },
    { id: 3, name: 'Dance' }, { id: 4, name: 'R&B' }, { id: 5, name: 'Classic' },
    { id: 6, name: 'Hip-hop' },
    { id: 7, name: 'USER1', user: true }, { id: 8, name: 'USER2', user: true }, { id: 9, name: 'USER3', user: true },
    { id: 11, name: 'Close EQ' }, { id: 240, name: 'BYPASS' },
  ],
  // Default band frequencies FiiO's app uses when it resets a BTR15 preset.
  defaultFreqs: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  limits: { freq: [20, 20000], gain: [-12, 12], q: [0.25, 8], globalGain: [-12, 12] },
  types: ['PK', 'LS', 'HS'],
};

export function slotName(id, profile = BTR15) {
  return profile.slots.find((s) => s.id === id)?.name ?? `preset ${id}`;
}
