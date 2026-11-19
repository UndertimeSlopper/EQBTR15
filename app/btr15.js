// High-level BTR15 operations built on FiioLink.
//
// Writing a user slot is done as a checked sequence:
//   1. note the active preset, switch to the target slot, confirm the switch
//   2. read the slot's current contents and keep them as a backup
//   3. write every band and the global gain, reading each one back
//   4. send the save command for that slot
//   5. optionally switch away and back, then read again, which checks what the
//      device actually STORED rather than what it is currently playing
// Any mismatch stops the sequence and is reported with a diff.

import { CMD, BTR15, encodeBand, decodeBand, encodeGain, decodeGain, decodeUint, encodeUint, slotName } from './protocol.js';
import { sleep } from './device.js';

export class Btr15 {
  constructor(link, { profile = BTR15, log } = {}) {
    this.link = link;
    this.profile = profile;
    this.log = log;
    this.bandCount = null;
  }

  slotName(id) { return slotName(id, this.profile); }

  // ── Reads (GET only) ──────────────────────────────────────────────────────
  async readFirmware() {
    const f = await this.link.get(CMD.FIRMWARE_VERSION);
    return Array.from(f.payload);
  }
  async readEqSwitch() {
    const f = await this.link.get(CMD.PEQ_SWITCH);
    return f.payload[0] ? 1 : 0;
  }
  async readPreset() {
    const f = await this.link.get(CMD.PEQ_PRESET);
    return decodeUint(f.payload);
  }
  async readBandCount() {
    const f = await this.link.get(CMD.PEQ_COUNT);
    const n = f.payload[0];
    if (!n || n > 32) throw new Error(`Device reported an implausible band count (${n}).`);
    this.bandCount = n;
    return n;
  }
  async readGlobalGain() {
    const f = await this.link.get(CMD.GLOBAL_GAIN);
    return decodeGain(f.payload);
  }
  async readBand(i) {
    const f = await this.link.get(CMD.PEQ_PARAMS, [i], { match: (p) => p.length >= 8 && p[0] === i });
    return decodeBand(f.payload);
  }
  async readBands(n = this.bandCount) {
    if (!n) n = await this.readBandCount();
    const bands = [];
    for (let i = 0; i < n; i++) bands.push(await this.readBand(i));
    return bands;
  }

  // Everything readable without changing anything.
  async identify() {
    const info = {};
    const tryRead = async (key, fn) => {
      try { info[key] = await fn(); } catch (e) { info[key] = null; info.errors = [...(info.errors ?? []), `${key}: ${e.message}`]; }
    };
    await tryRead('firmware', () => this.readFirmware());
    await tryRead('eqSwitch', () => this.readEqSwitch());
    await tryRead('preset', () => this.readPreset());
    await tryRead('bandCount', () => this.readBandCount());
    await tryRead('globalGain', () => this.readGlobalGain());
    if (info.bandCount) await tryRead('bands', () => this.readBands(info.bandCount));
    return info;
  }

  // The active preset's live values.
  async readLive() {
    const preset = await this.readPreset();
    const globalGain = await this.readGlobalGain();
    const bands = await this.readBands();
    return { preset, globalGain, bands };
  }

  // ── Changes to the active preset (SET) ────────────────────────────────────
  async switchPreset(id) {
    await this.link.set(CMD.PEQ_PRESET, encodeUint(id));
    await sleep(this.profile.presetSwitchDelayMs);
    let now = await this.readPreset();
    if (now !== id) {
      this.log?.warn(`Preset is ${now} after switching to ${id}; trying once more.`);
      await this.link.set(CMD.PEQ_PRESET, encodeUint(id));
      await sleep(this.profile.presetSwitchDelayMs * 1.5);
      now = await this.readPreset();
      if (now !== id) throw new Error(`The device did not switch to ${this.slotName(id)} (it reports ${this.slotName(now)}).`);
    }
    return now;
  }

  async readSlot(id) {
    await this.switchPreset(id);
    return this.readLive();
  }

  async writeBand(band) {
    await this.link.set(CMD.PEQ_PARAMS, encodeBand(band));
  }
  async writeGlobalGain(db) {
    await this.link.set(CMD.GLOBAL_GAIN, encodeGain(db));
  }
  async setEqSwitch(on) {
    await this.link.set(CMD.PEQ_SWITCH, [on ? 1 : 0]);
  }
  async save(id) {
    return this.link.set(CMD.PEQ_SAVE, encodeUint(id), { listenMs: 400 });
  }

  // Write bands + gain to the live preset and read each back.
  async writeLiveVerified({ globalGain, bands }, { retries = 2, onProgress } = {}) {
    const problems = [];
    for (const b of bands) {
      let ok = false;
      let got = null;
      for (let a = 0; a <= retries && !ok; a++) {
        await this.writeBand(b);
        got = await this.readBand(b.index);
        ok = bandMatches(b, got);
        if (!ok) this.log?.warn(`Band ${b.index} read back as ${fmtBand(got)}, expected ${fmtBand(b)}${a < retries ? '; rewriting' : ''}`);
      }
      if (!ok) problems.push({ index: b.index, expected: b, got });
      onProgress?.(b.index);
    }
    let gainOk = false;
    let gotGain = null;
    for (let a = 0; a <= retries && !gainOk; a++) {
      await this.writeGlobalGain(globalGain);
      gotGain = await this.readGlobalGain();
      gainOk = Math.abs(gotGain - globalGain) < 0.05;
    }
    if (!gainOk) problems.push({ index: 'global gain', expected: globalGain, got: gotGain });
    return problems;
  }

  // The full checked save. `values` are SENT values (already corrected and
  // rounded): { globalGain, bands: [{index,type,freq,gain,q}] } covering every band.
  async writeSlot(slot, values, { verifyStored = true, onStep = () => {}, onBackup } = {}) {
    if (!this.profile.userSlots.includes(slot)) throw new Error(`Refusing to write ${this.slotName(slot)}: only user slots can be written.`);
    const n = this.bandCount ?? await this.readBandCount();
    if (values.bands.length !== n) throw new Error(`Expected ${n} bands, got ${values.bands.length}.`);
    validateSent(values, this.profile);

    onStep('switch', `Switching to ${this.slotName(slot)}`);
    const before = await this.readPreset();
    if (before !== slot) await this.switchPreset(slot);

    onStep('backup', `Backing up ${this.slotName(slot)}`);
    const backup = await this.readLive();
    if (backup.preset !== slot) throw new Error('Active preset changed during backup.');
    await onBackup?.(backup);

    onStep('write', 'Writing bands and global gain');
    const live = await this.writeLiveVerified(values, { onProgress: (i) => onStep('write', `Wrote band ${i + 1} of ${n}`) });
    if (live.length) return { ok: false, stage: 'write', problems: live, backup, previousPreset: before };

    onStep('save', `Saving into ${this.slotName(slot)}`);
    const ack = await this.save(slot);
    await sleep(500);

    let stored = null;
    if (verifyStored) {
      const other = this.profile.userSlots.find((s) => s !== slot);
      onStep('verify', `Checking what was stored (switching to ${this.slotName(other)} and back)`);
      await this.switchPreset(other);
      await this.switchPreset(slot);
      stored = await this.readLive();
      const problems = compareValues(values, stored);
      if (problems.length) return { ok: false, stage: 'stored', problems, backup, stored, ack, previousPreset: before };
    }
    onStep('done', 'Saved and verified');
    return { ok: true, backup, stored, ack, previousPreset: before };
  }
}

export function bandMatches(want, got) {
  if (!got) return false;
  if (got.index !== want.index) return false;
  if (Math.abs(got.gain - want.gain) > 0.05) return false;
  // A 0 dB band is inaudible whatever its other fields say.
  if (Math.abs(want.gain) < 0.05) return true;
  return got.freq === Math.round(want.freq) && Math.abs(got.q - want.q) < 0.005 && got.type === want.type;
}

export function compareValues(want, got) {
  const problems = [];
  for (const b of want.bands) {
    const g = got.bands.find((x) => x.index === b.index);
    if (!bandMatches(b, g)) problems.push({ index: b.index, expected: b, got: g });
  }
  if (Math.abs(got.globalGain - want.globalGain) > 0.05) problems.push({ index: 'global gain', expected: want.globalGain, got: got.globalGain });
  return problems;
}

export function validateSent({ globalGain, bands }, profile = BTR15) {
  const L = profile.limits;
  const inR = (x, [a, b]) => x >= a - 1e-9 && x <= b + 1e-9;
  if (!inR(globalGain, L.globalGain)) throw new Error(`Global gain ${globalGain} dB is outside ${L.globalGain.join('…')} dB.`);
  for (const b of bands) {
    if (!profile.types.includes(b.type)) throw new Error(`Band ${b.index}: type ${b.type} is not supported.`);
    if (!inR(b.freq, L.freq)) throw new Error(`Band ${b.index}: ${b.freq} Hz is outside ${L.freq.join('…')} Hz.`);
    if (!inR(b.gain, L.gain)) throw new Error(`Band ${b.index}: ${b.gain} dB is outside ${L.gain.join('…')} dB.`);
    if (!inR(b.q, L.q)) throw new Error(`Band ${b.index}: Q ${b.q} is outside ${L.q.join('…')}.`);
  }
}

// Turn a list of (sent) filters into exactly n device bands, padding with flat ones.
export function toDeviceBands(sentFilters, n, profile = BTR15) {
  if (sentFilters.length > n) throw new Error(`${sentFilters.length} filters, but the device has ${n} bands.`);
  const bands = [];
  for (let i = 0; i < n; i++) {
    const f = sentFilters[i];
    if (f) {
      bands.push({ index: i, type: f.type, freq: Math.round(f.freq), gain: f.enabled === false ? 0 : round(f.gain, 1), q: round(f.q, 2) });
    } else {
      bands.push({ index: i, type: 'PK', freq: profile.defaultFreqs[i] ?? 1000, gain: 0, q: 1 });
    }
  }
  return bands;
}

export function fmtBand(b) {
  if (!b) return '(no reply)';
  return `${b.type} ${b.freq} Hz ${b.gain > 0 ? '+' : ''}${Number(b.gain).toFixed(1)} dB Q ${Number(b.q).toFixed(2)}`;
}

const round = (x, d) => Number(Number(x).toFixed(d));
