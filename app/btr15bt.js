// BTR15 operations over Bluetooth (GAIA). Same checked sequences as the USB
// class (backup, write with read-back, stored check); only the primitives
// differ.
//
// Differences from USB:
//  - User presets are 4, 8 and 9 (USER1-3). Bands and global gain are
//    addressed by custom-preset index (0-2), so any user preset can be READ
//    without switching to it.
//  - There is no separate save command: FiiO's app writes bands straight into
//    the active custom preset. The stored check (switch away and back, read
//    again) still runs, and the slot cards compare against the last write.
//  - Built-in presets (Jazz, Pop, ...) cannot be read over Bluetooth.

import { Btr15 } from './btr15.js';
import { BT, BTR15_BT, encodeBandBt, decodeBandBt, encodeGainBt, decodeGainBt } from './gaia.js';
import { sleep } from './device.js';

export class Btr15Bt extends Btr15 {
  constructor(link, { profile = BTR15_BT, log } = {}) {
    super(link, { profile, log });
    this.bandCount = profile.expectedBands;
    this.activePreset = null;
    this.firmware = null;
    this.readsSlotsDirectly = true;
    this.hasSaveCommand = false;
  }

  customIndexOf(id) {
    const i = this.profile.customIndex[id];
    return i === undefined ? null : i;
  }

  get withType() {
    if (!this.firmware) return true;
    const v = this.firmware[0] + this.firmware[1] / 10;
    return v >= this.profile.typeByteFromFirmware;
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  async readFirmware() {
    const r = await this.link.get(BT.VERSION);
    this.firmware = Array.from(r.data.slice(0, 2));
    return this.firmware;
  }
  async readBattery() {
    const r = await this.link.get(BT.BATTERY);
    return r.data[0];
  }
  async readEqSwitch() {
    const r = await this.link.get(BT.EQ_SWITCH);
    return r.data[0] === 1 ? 1 : 0;
  }
  async readPreset() {
    const r = await this.link.get(BT.PRESET);
    this.activePreset = r.data[0];
    return r.data[0];
  }
  async readBandCount() { return this.bandCount; }

  async readCustomBand(ci, band) {
    const r = await this.link.get(BT.BAND, [ci, band], { match: (d) => d.length >= 8 && d[0] === ci && d[1] === band });
    const b = decodeBandBt(r.data);
    return { index: b.index, type: b.type, freq: b.freq, gain: b.gain, q: b.q, hasType: b.hasType };
  }
  async readCustomGain(ci) {
    const r = await this.link.get(BT.GLOBAL_GAIN, [ci], { match: (d) => d.length >= 3 && d[0] === ci });
    return decodeGainBt(r.data).gain;
  }
  async readCustom(ci) {
    const bands = [];
    for (let i = 0; i < this.bandCount; i++) bands.push(await this.readCustomBand(ci, i));
    const globalGain = await this.readCustomGain(ci);
    return { globalGain, bands };
  }

  _activeIndex() {
    const ci = this.customIndexOf(this.activePreset);
    if (ci === null) throw new Error(`The active preset (${this.slotName(this.activePreset)}) is a built-in one; its bands cannot be read or written over Bluetooth.`);
    return ci;
  }
  async readBand(i) { return this.readCustomBand(this._activeIndex(), i); }
  async readBands() { const ci = this._activeIndex(); const out = []; for (let i = 0; i < this.bandCount; i++) out.push(await this.readCustomBand(ci, i)); return out; }
  async readGlobalGain() { return this.readCustomGain(this._activeIndex()); }

  async readLive() {
    const preset = await this.readPreset();
    const ci = this.customIndexOf(preset);
    if (ci === null) return { preset, globalGain: null, bands: null, builtIn: true };
    const { globalGain, bands } = await this.readCustom(ci);
    return { preset, globalGain, bands };
  }

  // Reading a user preset needs no switch over Bluetooth.
  async readSlot(id) {
    const ci = this.customIndexOf(id);
    if (ci === null) throw new Error(`${this.slotName(id)} is not a user preset.`);
    const { globalGain, bands } = await this.readCustom(ci);
    return { preset: id, globalGain, bands };
  }

  async identify() {
    const info = { transport: 'bluetooth', encoding: this.link.transport === 'bluetooth-serial' ? 'Bluetooth serial (GAIA over SPP)' : 'Bluetooth LE (GAIA over GATT)' };
    const tryRead = async (key, fn) => {
      try { info[key] = await fn(); } catch (e) { info[key] = null; info.errors = [...(info.errors ?? []), `${key}: ${e.message}`]; }
    };
    let firstError = null;
    try { info.firmware = await this.readFirmware(); } catch (e) { firstError = e; info.firmware = null; info.errors = [`firmware: ${e.message}`]; }
    if (firstError) {
      info.noAnswer = true;
      if (firstError.code === 'auth') {
        info.authFailed = true;
        this.log?.error('The BTR15 refused the command: this computer is not paired with it for Bluetooth control. Nothing further was sent.');
      } else if (firstError.code === 'timeout') {
        this.log?.error('The BTR15 did not answer the version request over Bluetooth. Nothing further was sent.');
      } else {
        this.log?.error(`The first command failed (${firstError.message}). Nothing further was sent.`);
      }
      return info;
    }
    await tryRead('battery', () => this.readBattery());
    await tryRead('eqSwitch', () => this.readEqSwitch());
    await tryRead('preset', () => this.readPreset());
    info.bandCount = this.bandCount;
    if (info.firmware) {
      this.log?.info(`Firmware ${info.firmware.join('.')}: ${this.withType ? 'filter types (peak, low shelf, high shelf) are sent' : 'below 2.5, so FiiO sends no filter type: bands are peaks only'}.`);
    }
    if (info.preset != null && this.customIndexOf(info.preset) !== null) {
      await tryRead('bands', () => this.readBands());
      await tryRead('globalGain', () => this.readGlobalGain());
    }
    return info;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────
  async switchPreset(id) {
    await this.link.set(BT.SET_PRESET, [id]);
    await sleep(this.profile.presetSwitchDelayMs);
    let now = await this.readPreset();
    if (now !== id) {
      this.log?.warn(`Preset is ${now} after switching to ${id}; trying once more.`);
      await this.link.set(BT.SET_PRESET, [id]);
      await sleep(this.profile.presetSwitchDelayMs * 2);
      now = await this.readPreset();
      if (now !== id) throw new Error(`The device did not switch to ${this.slotName(id)} (it reports ${this.slotName(now)}).`);
    }
    return now;
  }

  async writeBand(band) {
    if (!this.withType && band.type !== 'PK') throw new Error('This firmware cannot store shelf filters (FiiO sends no filter type below firmware 2.5).');
    await this.link.set(BT.SET_BAND, encodeBandBt(this._activeIndex(), band, { withType: this.withType }));
  }
  async writeGlobalGain(db) {
    await this.link.set(BT.SET_GLOBAL_GAIN, encodeGainBt(this._activeIndex(), db));
  }
  async setEqSwitch(on) {
    await this.link.set(BT.SET_EQ_SWITCH, [on ? 1 : 0]);
  }
  // No save command over Bluetooth: writes go straight into the preset.
  async save() { return null; }
}
