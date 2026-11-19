// UI wiring. Everything that touches the device goes through Btr15/FiioLink;
// this file only decides when, and shows the results.

import { FreqGrid, responseDb, getModel, parseModelId, modelId } from './dsp.js';
import { parseEqText, sampleCurve, toApoParametric, toPresetJson } from './formats.js';
import { fitPeq, fitStats, quantizeSent, equalizationCurve, BTR15_LIMITS } from './fit.js';
import { BTR15, FIIO_VENDOR_ID, slotName } from './protocol.js';
import { FiioLink, pickControlInterface, summarizeCollections, hasOutputReport } from './device.js';
import { Btr15, toDeviceBands, fmtBand, compareValues } from './btr15.js';
import { SimulatedBtr15Spp } from './sim.js';
import { BleLink, SppLink } from './ble.js';
import { Btr15Bt } from './btr15bt.js';
import { BTR15_BT, GAIA_SERVICE, BT, SPP_UUID, GAIA_SPP_UUID } from './gaia.js';
import { TrafficLog } from './log.js';
import { ResponseGraph } from './graph.js';
import { LISTEN_TESTS, NoiseEngine } from './listen.js';
import * as store from './storage.js';

export const APP_VERSION = '0.1.0';

const $ = (id) => document.getElementById(id);
const log = new TrafficLog();
const grid = new FreqGrid({ fmin: 20, fmax: 20000, pointsPerOctave: 48 });
// The active device's profile (slot numbers differ between USB and Bluetooth).
const prof = () => state.conn?.btr.profile ?? BTR15_BT;
const sname = (id) => slotName(id, prof());
const devName = (d) => d?.productName ?? d?.name ?? (d?.getInfo ? 'FiiO BTR15 (Bluetooth serial)' : 'device');

const state = {
  conn: null,        // { device, link, btr, sim, isBtr15 }
  info: null,        // last identify() result
  slots: {},         // id -> { globalGain, bands, readAt }
  compare: null,     // slot id shown on the graph
  target: null,      // { name, source, points }
  filters: [],       // intended filters
  globalGain: 0,
  model: 'standard',
  busy: false,
  lastDevice: null,  // { vendorId, productId } for automatic reconnection
  wroteOnce: false,
  listenResults: {},
};

// ── Log panel ────────────────────────────────────────────────────────────────
const logEl = $('log');
log.onEntry((e) => {
  if (!e) { logEl.replaceChildren(); return; }
  const span = document.createElement('span');
  span.className = e.kind;
  span.textContent = log.format(e) + '\n';
  const atEnd = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8;
  logEl.append(span);
  while (logEl.childNodes.length > 3000) logEl.firstChild.remove();
  if (atEnd) logEl.scrollTop = logEl.scrollHeight;
});

function logHeader() {
  const c = state.conn;
  return [
    `BTR15 PEQ Writer ${APP_VERSION}  ${location.href}`,
    `Time ${new Date().toISOString()}  ${navigator.userAgent}`,
    !c ? 'Device: none' : c.transport === 'bluetooth'
      ? `Device "${devName(c.device)}" over ${c.link.transport === 'bluetooth-serial' ? `Bluetooth serial ${JSON.stringify(c.device.getInfo?.() ?? {})}` : 'Bluetooth LE'}${c.sim ? ' (SIMULATED)' : ''}`
      : `Device "${devName(c.device)}" over USB VID 0x${hex4(c.device.vendorId)} PID 0x${hex4(c.device.productId)}${c.sim ? ' (SIMULATED)' : ''}`,
    !c ? '' : c.transport === 'bluetooth'
      ? `Link stats ${JSON.stringify(c.link.stats)} firmware=${c.btr.firmware?.join('.') ?? '?'} typeByte=${c.btr.withType}`
      : `Link stats ${JSON.stringify(c.link.stats)} framing=${c.link.framing} prefix=[${c.link.prefix.join(',')}] usesReportIds=${c.link.usesReportIds} seqEcho=${c.link.seqEcho} reportId=${c.link.reportId} padTo=${c.link.padTo}`,
    `Model ${state.model}  allowWrites=${$('allowWrites').checked}`,
    '----',
  ].filter(Boolean).join('\n');
}

$('btnCopyLog').onclick = async () => {
  const text = log.toText(logHeader());
  try {
    await navigator.clipboard.writeText(text);
    flash($('btnCopyLog'), 'Copied');
  } catch {
    store.download(`btr15-log-${stamp()}.txt`, text);
  }
};
$('btnSaveLog').onclick = () => store.download(`btr15-log-${stamp()}.txt`, log.toText(logHeader()));
$('btnClearLog').onclick = () => log.clear();

// ── Busy / write gating ─────────────────────────────────────────────────────
function canWrite() {
  return !!(state.conn && state.conn.isBtr15 && state.info && !state.info.noAnswer && $('allowWrites').checked && !state.busy && !state.conn.link.closed && !ls.active);
}
function updateControls() {
  const connected = !!state.conn && !state.conn.link.closed;
  for (const b of document.querySelectorAll('[data-write]')) b.disabled = !canWrite();
  $('btnReadLive').disabled = !connected || state.busy;
  if (state.conn?.btr.readsSlotsDirectly) $('btnReadSlots').disabled = !connected || state.busy || !!state.info?.noAnswer;
  $('btnConnect').hidden = connected;
  $('btnConnectSerial').hidden = connected;
  $('btnConnectUsb').hidden = connected;
  $('btnDemo').hidden = connected;
  $('btnDisconnect').hidden = !connected;
  $('btnLsStop').disabled = state.busy && !ls.active;
  if (ls.active) $('btnLsStart').disabled = true;
  for (const b of document.querySelectorAll('.slot [data-write]')) b.disabled = !canWrite();
  for (const b of document.querySelectorAll('.slot [data-read]')) b.disabled = !connected || state.busy;
}
$('allowWrites').onchange = () => {
  if ($('allowWrites').checked) log.info('Writing to the device is now ALLOWED for this page session.');
  else log.info('Writing disabled: only GET commands will be sent.');
  updateControls();
};

async function busy(label, fn) {
  if (state.busy) return undefined;
  state.busy = true;
  updateControls();
  setStatus(`${label}…`, 'ok');
  try {
    return await fn();
  } catch (e) {
    log.error(`${label} failed: ${e.message}`);
    state.busy = false;
    refreshStatus();
    await alertDlg(`${label} failed`, `<p>${esc(e.message)}</p><p class="muted small">The log has the details.</p>`);
    return undefined;
  } finally {
    state.busy = false;
    refreshStatus();
    updateControls();
  }
}

function refreshStatus() {
  const c = state.conn;
  if (!c) setStatus('Not connected');
  else if (c.link.closed) setStatus('Disconnected: waiting', 'bad');
  else setStatus(connLabel(), 'ok');
}

function connLabel() {
  const c = state.conn;
  if (!c) return 'Not connected';
  if (c.link.closed) return 'Disconnected';
  return `${c.sim ? 'Demo: ' : ''}${devName(c.device)}${c.transport === 'bluetooth' ? '' : ' (USB)'}`;
}

// ── Connecting ──────────────────────────────────────────────────────────────
if (!('serial' in navigator) && !('bluetooth' in navigator)) $('noBt').hidden = false;
if (!('serial' in navigator)) $('btnConnectSerial').disabled = true;
if (!('bluetooth' in navigator)) $('btnConnect').disabled = true;
if (!('hid' in navigator)) {
  $('btnConnectUsb').disabled = true;
} else {
  navigator.hid.addEventListener('disconnect', (e) => {
    if (state.conn && !state.conn.sim && e.device === state.conn.device) {
      log.warn('The device disconnected (unplugged, or it re-enumerated). Waiting for it to come back…');
      state.conn.link.markDisconnected();
      setStatus('Disconnected: waiting', 'bad');
      updateControls();
      if (ls.active) lsAbort('The device disconnected during the listening check.');
    }
  });
  navigator.hid.addEventListener('connect', async (e) => {
    const d = e.device;
    if (!state.lastDevice || d.vendorId !== state.lastDevice.vendorId || d.productId !== state.lastDevice.productId) return;
    if (state.conn && !state.conn.link.closed) return;
    // 'connect' fires once per HID interface; collect them all, then choose.
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(async () => {
      const all = (await navigator.hid.getDevices()).filter((x) => x.vendorId === d.vendorId && x.productId === d.productId);
      log.info(`Device is back (${all.length} HID interface(s)); reconnecting.`);
      await openDevice(all, { auto: true });
    }, 600);
  });
}

// ── Bluetooth serial: what FiiO Control uses while the BTR15 plays audio ────
const SERIAL_HELP = `<p>The list should show the BTR15 (for example <b>FIIO BTR15</b>) when it is paired with Windows and switched on. Pick it.</p>
  <p>If it is not listed:</p>
  <ol>
    <li>Check that the BTR15 is paired and connected in Windows (<b>Settings → Bluetooth &amp; devices</b>), and that FiiO Control on the phone is closed.</li>
    <li>Press <b>Connect BTR15</b> again; the page then also offers to show every serial port.</li>
    <li>To help me: open <b>Control Panel → Hardware and Sound → Devices and Printers</b>, right-click the BTR15, choose <b>Properties</b>, open the <b>Services</b> tab (or <b>Hardware</b> tab) and tell me what is listed.</li>
  </ol>`;

let serialAttempts = 0;
$('btnConnectSerial').onclick = async () => {
  let port;
  const ids = [GAIA_SPP_UUID, SPP_UUID];
  // First try: only Bluetooth devices offering GAIA or SPP. Later tries also
  // list every serial port, in case the BTR15 shows up as a COM port.
  const opts = serialAttempts++ === 0
    ? { filters: ids.map((id) => ({ bluetoothServiceClassId: id })), allowedBluetoothServiceClassIds: ids }
    : { allowedBluetoothServiceClassIds: ids };
  log.info(`Opening the serial port chooser (${opts.filters ? 'Bluetooth GAIA/SPP services only' : 'all serial ports, plus Bluetooth GAIA/SPP services'}).`);
  try {
    port = await navigator.serial.requestPort(opts);
  } catch (e) {
    if (e instanceof TypeError) {
      log.warn(`This browser does not accept Bluetooth service filters (${e.message}); listing plain serial ports.`);
      try { port = await navigator.serial.requestPort(); } catch (e2) { log.info(`No serial port chosen (${e2.message}).`); await alertDlg('No port chosen', SERIAL_HELP); return; }
    } else if (e.name === 'NotFoundError') {
      log.info(`No serial port chosen (${e.message}).`);
      await alertDlg('Connecting to the BTR15', SERIAL_HELP);
      return;
    } else {
      log.error(`Serial port chooser failed: ${e.name}: ${e.message}`);
      await alertDlg('Serial ports unavailable', `<p>${esc(e.message)}</p>`);
      return;
    }
  }
  await openGaia(new SppLink(port, { log, profile: BTR15_BT }), port);
};

// ── Bluetooth LE (FiiO's fallback route; needs an LE pairing on Windows) ────
$('btnConnect').onclick = async () => {
  let device;
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: 'FiiO BTR15' }, { namePrefix: 'FIIO BTR15' }, { namePrefix: 'BTR15' }, { services: [GAIA_SERVICE] }],
      optionalServices: [GAIA_SERVICE],
    });
  } catch (e) {
    if (e.name === 'NotFoundError') {
      log.info(`No Bluetooth device chosen (${e.message}).`);
      const all = await confirmDlg('BTR15 not in the list?', `<p>If the BTR15 did not appear, it may not be advertising its name. You can list every nearby Bluetooth device instead and pick it from there.</p>
        <p>Also check: the BTR15 is on, Bluetooth is on in Windows, and FiiO Control on your phone is closed (its connection can keep the BTR15 busy).</p>`, 'Show all devices');
      if (!all) return;
      try {
        device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: [GAIA_SERVICE] });
      } catch (e2) { log.info(`No Bluetooth device chosen (${e2.message}).`); return; }
    } else {
      log.error(`Bluetooth chooser failed: ${e.name}: ${e.message}`);
      if (e.name === 'SecurityError' || /origin|file/i.test(e.message)) {
        await alertDlg('Bluetooth not allowed here', `<p>The browser refused Bluetooth access for this page (${esc(e.message)}). Some browsers do not allow Web Bluetooth from a local file. Open the hosted copy of this page instead (https address), or tell the developer.</p>`);
      } else if (e.name === 'NotAllowedError' || /globally disabled|adapter not available|Bluetooth adapter/i.test(e.message)) {
        await alertDlg('Bluetooth unavailable', `<p>${esc(e.message)}</p><p>Check that Bluetooth is turned on in Windows settings.</p>`);
      }
      return;
    }
  }
  await openGaia(new BleLink(device, { log, profile: BTR15_BT }), device);
};

$('btnDemo').onclick = async () => {
  log.info('Connecting to the SIMULATED BTR15 over a simulated Bluetooth serial link (nothing here touches real hardware).');
  const sim = new SimulatedBtr15Spp();
  await openGaia(new SppLink(sim, { log, profile: { ...BTR15_BT, presetSwitchDelayMs: 150 } }), sim, { sim: true });
};

// Open a GAIA link (serial or LE) and identify the BTR15.
async function openGaia(link, device, { sim = false } = {}) {
  if (state.conn) { try { await state.conn.link.close(); } catch { /* ignore */ } }
  const profile = link.profile;
  try {
    await link.open();
  } catch (e) {
    log.error(`Could not connect: ${e.message}`);
    await alertDlg('Could not connect', `<p>${esc(e.message)}</p>${link.transport === 'bluetooth-serial'
      ? '<p>Make sure the BTR15 is on and paired with Windows, and that FiiO Control on the phone is closed. If you picked a "Standard Serial over Bluetooth link" port, try the other one.</p>'
      : '<p>Close FiiO Control on your phone (or turn the phone\'s Bluetooth off for a moment), make sure the BTR15 is on, and try again.</p>'}`);
    return;
  }
  const isBtr15 = sim || link.transport === 'bluetooth-serial' || /BTR15/i.test(device.name ?? '');
  const btr = new Btr15Bt(link, { profile, log });
  state.conn = { device, link, btr, sim, isBtr15, transport: 'bluetooth' };
  state.slots = {};
  link.onDisconnect = () => {
    setStatus('Bluetooth disconnected', 'bad');
    if (ls.active) lsAbort('The Bluetooth connection dropped during the listening check.');
    renderDevice();
    updateControls();
  };
  link.onUnsolicited((f) => {
    if (f.cmd === BT.PRESET && f.data?.length && state.info) { state.info.preset = f.data[0]; renderDevice(); }
  });
  if (!isBtr15) log.warn(`"${devName(device)}" does not look like a BTR15. Reading is allowed; writing stays disabled.`);
  setStatus(connLabel(), 'ok');
  updateControls();
  await identify();
}

// ── USB (experimental: no FiiO software answers on the BTR15's USB interface yet)
$('btnConnectUsb').onclick = async () => {
  let devices;
  try {
    devices = await navigator.hid.requestDevice({ filters: [{ vendorId: FIIO_VENDOR_ID }] });
  } catch (e) {
    log.error(`Device chooser failed: ${e.message}`);
    return;
  }
  if (!devices.length) { log.info('No device chosen.'); return; }
  await openDevice(devices);
};

$('btnDisconnect').onclick = async () => {
  if (ls.active) await lsStop();
  const c = state.conn;
  state.lastDevice = null;
  if (c) await c.link.close();
  state.conn = null;
  state.info = null;
  log.info('Disconnected.');
  setStatus('Not connected');
  renderDevice();
  updateControls();
};

async function openDevice(devices, { sim = false, auto = false } = {}) {
  for (const d of devices) {
    log.info(`HID interface "${d.productName}" VID 0x${hex4(d.vendorId)} PID 0x${hex4(d.productId)}: ${summarizeCollections(d).join(' | ') || 'no collections reported'}`);
  }
  const dev = pickControlInterface(devices, BTR15.reportId);
  if (!dev) {
    log.error('None of the chosen HID interfaces has an output report this app can use.');
    await alertDlg('No control interface', '<p>The chosen device has no HID output report. Copy the log and paste it into the chat.</p>');
    return;
  }
  const isBtr15 = sim || /BTR15/i.test(dev.productName ?? '');
  let reportId = BTR15.reportId;
  if (!hasOutputReport(dev, reportId)) {
    const ids = [...new Set((dev.collections ?? []).flatMap((c) => (c.outputReports ?? []).map((r) => r.reportId ?? 0)))];
    if (ids.length === 1) {
      reportId = ids[0];
      log.info(`This interface has no output report ${BTR15.reportId}; its only output report is ${reportId}${reportId === 0 ? ' (no report IDs)' : ''}. The connection probe tries the ways FiiO firmware may expect frames on it.`);
    } else {
      log.warn(`The device lists no output report ${BTR15.reportId} (it has: ${ids.join(', ') || 'none'}). Trying ${reportId} anyway.`);
    }
  }
  if (state.conn) { try { await state.conn.link.close(); } catch { /* ignore */ } }
  const profile = sim ? { ...BTR15, presetSwitchDelayMs: 150 } : BTR15;
  const link = new FiioLink(dev, { reportId, log, profile });
  try {
    await link.open();
  } catch (e) {
    log.error(`Could not open the device: ${e.message}. Close FiiO's app or web page (or another tab using it) and try again.`);
    await alertDlg('Could not open the device', `<p>${esc(e.message)}</p><p>Close FiiO Control, fiiocontrol.fiio.com and any other tab using the BTR15, then try again.</p>`);
    return;
  }
  const btr = new Btr15(link, { profile, log });
  state.conn = { device: dev, link, btr, sim, isBtr15, transport: 'usb' };
  state.lastDevice = sim ? null : { vendorId: dev.vendorId, productId: dev.productId };
  state.slots = {};
  link.onUnsolicited((f) => {
    if (f.cmd === 0x16 && f.payload?.length) { state.info && (state.info.preset = f.payload.length === 1 ? f.payload[0] : (f.payload[0] << 8) | f.payload[1]); renderDevice(); }
  });
  if (!isBtr15) log.warn(`"${dev.productName}" is not a BTR15. Reading is allowed; writing stays disabled because slot numbers differ between FiiO models.`);
  setStatus(connLabel(), 'ok');
  updateControls();
  await identify(auto);
}

async function identify(auto = false) {
  await busy('Reading device', async () => {
    const info = await state.conn.btr.identify();
    state.info = info;
    if (info.noAnswer) {
      setStatus('No answer from device', 'bad');
      if (info.authFailed) {
        setStatus('Not paired', 'bad');
        await alertDlg('The BTR15 needs a Bluetooth LE pairing', `<p>The BTR15 accepted the connection but refused the first command (<b>${esc(info.errors?.[0] ?? '')}</b>). It only takes commands over an encrypted Bluetooth LE link, which needs an <b>LE pairing</b> with this computer. The usual Windows "Add device" pairing is for audio and is not enough. Nothing was written.</p>
          <ol>
            <li>Close FiiO Control on the phone.</li>
            <li>In Windows <b>Settings → Bluetooth &amp; devices</b>, remove the BTR15 (<b>⋯ → Remove device</b>), so no half-finished pairing is left.</li>
            <li>Put the BTR15 in pairing mode, so its screen shows <b>PAIRING</b>.</li>
            <li>Here, press <b>Disconnect</b> if shown, then <b>Connect BTR15</b>, and pick it. The browser will try to pair over LE when the page sends its first command: <b>accept any pairing prompt</b> from Windows or the browser.</li>
          </ol>
          <p class="small">If the BTR15 started sending messages (lines "pushed by device" in the log) but commands still failed, the pairing probably finished: <b>reload the page</b> and connect again without pairing mode. Once paired over LE, later connections should not need pairing mode.</p>`);
        return;
      }
      await alertDlg('The BTR15 did not answer', state.conn.link.transport === 'bluetooth-serial'
        ? `<p>The serial port opened but nothing answered the version request. Nothing was written.</p><p>If you picked a "Standard Serial over Bluetooth link" port, disconnect and try the other one (the <b>outgoing</b> port). Otherwise press <b>Copy log</b> and paste it into the chat.</p>`
        : state.conn.transport === 'bluetooth'
        ? `<p>The BTR15 accepted the Bluetooth connection but did not answer the version request. Nothing was written.</p><p>Please press <b>Copy log</b> and paste it into the chat. Closing FiiO Control on your phone may help.</p>`
        : `<p>The page asked for the band count in every encoding it knows and got no reply. Nothing was written.</p>
        <p>Please press <b>Copy log</b> and paste it into the chat. Also check that FiiO Control and fiiocontrol.fiio.com are closed, then try unplugging and reconnecting.</p>`);
      return;
    }
    if (info.errors?.length) log.warn(`Some reads failed: ${info.errors.join('; ')}`);
    log.info(`Encoding: ${info.encoding}. Read: firmware ${info.firmware?.join('.') ?? '?'}, EQ switch ${info.eqSwitch === null ? '?' : info.eqSwitch ? 'on' : 'off'}, preset ${info.preset ?? '?'} (${info.preset != null ? sname(info.preset) : '?'}), ${info.bandCount ?? '?'} bands, global gain ${info.globalGain ?? '?'} dB`);
    if (info.battery != null) log.info(`Battery ${info.battery}%.`);
    if (info.preset != null && !info.bands && c0() && state.conn.transport === 'bluetooth' && state.conn.btr.customIndexOf(info.preset) === null) {
      log.info(`The active preset (${sname(info.preset)}) is a built-in one; its bands are not readable over Bluetooth. Press "Read USER1–3" to read the user presets.`);
    }
    if (info.bands && info.preset != null) {
      state.slots[info.preset] = { globalGain: info.globalGain, bands: info.bands, readAt: Date.now() };
      logSlot(info.preset, state.slots[info.preset]);
    }
    if (auto) log.info('Reconnected after the device came back.');
  });
  renderDevice();
  render();
}

// ── Device panel ────────────────────────────────────────────────────────────
function renderDevice() {
  const c = state.conn;
  const info = state.info;
  $('devEmpty').hidden = !!c;
  $('devInfo').hidden = !c;
  if (!c) { $('slotCards').replaceChildren(); return; }
  $('fModel').textContent = devName(c.device);
  $('fFirmware').textContent = info?.firmware?.join('.') ?? '–';
  $('fSwitch').textContent = info?.eqSwitch == null ? '–' : info.eqSwitch ? 'On' : 'Off';
  $('fPreset').textContent = info?.preset == null ? '–' : `${sname(info.preset)} (${info.preset})`;
  $('fBands').textContent = info?.bandCount ?? '–';
  $('fFraming').textContent = info?.noAnswer ? 'no answer' : info?.encoding ?? '–';
  $('fGain').textContent = info?.globalGain == null ? '–' : `${fmtG(info.globalGain)} dB`;

  const warn = [];
  if (!c.isBtr15) warn.push('This is not a BTR15, so writing is disabled.');
  if (info?.noAnswer) warn.push('The device did not answer. Copy the log and paste it into the chat.');
  if (info?.eqSwitch === 0) warn.push(c.transport === 'bluetooth'
    ? 'The BTR15 reports its EQ as OFF, so no preset is audible. Turn it on from FiiO Control, the device, or the button below.'
    : 'The BTR15 reports its EQ switch as OFF, so no preset is audible. Turn it on from the device or with the button below. FiiO says the BTR15 re-connects over USB when EQ is toggled, so audio may drop for a moment.');
  if (c.transport === 'bluetooth' && c.btr.firmware && !c.btr.withType) warn.push(`Firmware ${c.btr.firmware.join('.')} is older than 2.5: FiiO sends no filter type to it, so only peak filters can be stored. Use "Peaks only" when fitting.`);
  if (info?.bandCount && info.bandCount !== prof().expectedBands) warn.push(`The device reports ${info.bandCount} bands; FiiO's app assumes ${prof().expectedBands}.`);
  if (info?.preset != null && !prof().slots.some((s) => s.id === info.preset)) warn.push(`Active preset ${info.preset} is not in FiiO's BTR15 table.`);
  $('devWarn').hidden = !warn.length;
  $('devWarn').innerHTML = warn.map(esc).join('<br>');

  const eqBtn = $('btnEqSwitch');
  eqBtn.hidden = info?.eqSwitch == null;
  eqBtn.textContent = info?.eqSwitch ? 'Turn EQ switch off' : 'Turn EQ switch on';

  const sel = $('selPreset');
  const keep = sel.value;
  sel.replaceChildren(...prof().slots.map((s) => new Option(`${s.name} (${s.id})`, s.id)));
  sel.value = keep && prof().slots.some((x) => String(x.id) === keep) ? keep : (info?.preset ?? prof().userSlots[0]);
  fillSlotSelect($('saveSlot'), 2);
  fillSlotSelect($('lsSlot'), 2);

  const cards = prof().userSlots.map((id) => slotCard(id));
  if (info?.preset != null && !prof().userSlots.includes(info.preset) && state.slots[info.preset]) cards.unshift(slotCard(info.preset));
  $('slotCards').replaceChildren(...cards);
  updateControls();
}

function slotCard(id) {
  const s = state.slots[id];
  const div = document.createElement('div');
  div.className = 'slot';
  const active = state.info?.preset === id;
  div.innerHTML = `<h4><span>${esc(sname(id))}${active ? ' <span class="chip">active</span>' : ''}</span><span class="muted small">${s ? 'read ' + new Date(s.readAt).toLocaleTimeString() : 'not read yet'}</span></h4>`;
  if (s) {
    const lw = c0() ? store.lastWrite(deviceKey(), id) : null;
    if (lw) {
      const diff = compareValues(lw, s);
      const p = document.createElement('p');
      p.className = `small ${diff.length ? 'result-bad' : 'result-ok'}`;
      p.textContent = diff.length
        ? `Differs from what this page saved on ${new Date(lw.at).toLocaleString()} (${diff.length} value(s)). See the log.`
        : `Matches what this page saved on ${new Date(lw.at).toLocaleString()}.`;
      div.append(p);
    }
    const t = document.createElement('table');
    const used = s.bands.filter((b) => Math.abs(b.gain) >= 0.05);
    t.innerHTML = `<tr><td colspan="4" class="muted">Global gain ${fmtG(s.globalGain)} dB · ${used.length} active band(s)</td></tr>` +
      used.map((b) => `<tr><td>${b.index + 1}</td><td>${esc(b.type)}</td><td>${b.freq} Hz</td><td>${fmtG(b.gain)} dB</td><td>Q ${b.q.toFixed(2)}</td></tr>`).join('');
    div.append(t);
    const row = document.createElement('div');
    row.className = 'row';
    row.append(
      btn(state.compare === id ? 'Hide on graph' : 'Show on graph', () => { state.compare = state.compare === id ? null : id; render(); renderDevice(); }),
      btn('Load into editor', () => loadFromDevice(id)),
      btn('Download', () => store.download(`btr15-${sname(id)}-${stamp()}.json`, JSON.stringify(store.makeBackup({ device: devDesc(), slot: id, slotName: sname(id), live: s }), null, 2), 'application/json')),
    );
    div.append(row);
  } else if (prof().userSlots.includes(id)) {
    const row = document.createElement('div');
    row.className = 'row';
    const b = btn('Read', () => readSlots([id]));
    if (state.conn?.btr.readsSlotsDirectly) b.dataset.read = ''; else b.dataset.write = '';
    row.append(b);
    div.append(row);
  }
  return div;
}

function c0() { return !!state.conn; }
function deviceKey() {
  const c = state.conn;
  if (!c) return 'none';
  // Both Bluetooth routes reach the same presets, so they share one key.
  if (c.transport === 'bluetooth') return c.sim ? 'sim-bt' : 'btr15-bluetooth';
  return `${c.sim ? 'sim' : 'usb'}:${hex4(c.device.vendorId)}:${hex4(c.device.productId)}`;
}

function logSlot(id, s) {
  log.info(`${sname(id)} (${id}): global gain ${fmtG(s.globalGain)} dB; ${s.bands.map((b) => `[${b.index}] ${fmtBand(b)}`).join('; ')}`);
  const lw = store.lastWrite(deviceKey(), id);
  if (lw) {
    const diff = compareValues(lw, s);
    if (diff.length) log.warn(`${sname(id)} DIFFERS from what this page saved on ${lw.at}: ${JSON.stringify(diff)}`);
    else log.info(`${sname(id)} matches what this page saved on ${lw.at}.`);
  }
}

$('btnReadLive').onclick = () => busy('Reading active preset', async () => {
  const live = await state.conn.btr.readLive();
  state.info.preset = live.preset;
  if (live.builtIn) {
    log.info(`The active preset is ${sname(live.preset)}, a built-in one; its bands are not readable over Bluetooth.`);
    renderDevice();
    return;
  }
  state.info.globalGain = live.globalGain;
  state.slots[live.preset] = { globalGain: live.globalGain, bands: live.bands, readAt: Date.now() };
  logSlot(live.preset, state.slots[live.preset]);
  renderDevice(); render();
});

$('btnReadSlots').onclick = () => readSlots(prof().userSlots);

async function readSlots(ids) {
  if (state.conn?.btr.readsSlotsDirectly) {
    // Over Bluetooth user presets are read by index: read commands only, no switching.
    await busy('Reading user presets', async () => {
      for (const id of ids) {
        const live = await state.conn.btr.readSlot(id);
        state.slots[id] = { globalGain: live.globalGain, bands: live.bands, readAt: Date.now() };
        logSlot(id, state.slots[id]);
        renderDevice();
      }
    });
    renderDevice(); render();
    return;
  }
  if (!canWrite()) return;
  if (!await confirmOnce('switch', 'Read user slots', `<p>Reading a slot means switching the BTR15 to it (a SET command; stored contents are not changed). The page switches back to <b>${esc(sname(state.info?.preset ?? 7))}</b> afterwards.</p><p>FiiO users report audio can stop briefly when presets switch.</p>`)) return;
  await busy('Reading user slots', async () => {
    const btr = state.conn.btr;
    const original = await btr.readPreset();
    try {
      for (const id of ids) {
        const live = await btr.readSlot(id);
        state.slots[id] = { globalGain: live.globalGain, bands: live.bands, readAt: Date.now() };
        logSlot(id, state.slots[id]);
        renderDevice();
      }
    } finally {
      if ((await btr.readPreset()) !== original) await btr.switchPreset(original);
      state.info.preset = original;
    }
  });
  renderDevice(); render();
}

$('btnSwitch').onclick = () => busy('Switching preset', async () => {
  const id = Number($('selPreset').value);
  if (!await confirmOnce('switch', 'Switch preset', `<p>Switch the BTR15 to <b>${esc(sname(id))}</b>? This changes which preset plays; no stored preset is changed.</p>`)) return;
  await state.conn.btr.switchPreset(id);
  state.info.preset = id;
  const live = await state.conn.btr.readLive();
  if (!live.builtIn) {
    state.slots[id] = { globalGain: live.globalGain, bands: live.bands, readAt: Date.now() };
    logSlot(id, state.slots[id]);
  }
  renderDevice(); render();
});

$('btnEqSwitch').onclick = () => busy('Changing EQ switch', async () => {
  const on = !state.info.eqSwitch;
  if (!await confirmDlg(`Turn EQ ${on ? 'on' : 'off'}?`, state.conn.transport === 'bluetooth'
    ? '<p>Turns the BTR15\'s EQ on or off, as the switch in FiiO Control does. FiiO says the BTR15 re-connects over USB when its EQ is toggled, so USB audio may stop for a moment.</p>'
    : '<p>FiiO says the BTR15 re-connects over USB when its EQ is toggled, so audio may stop for a moment and this page will reconnect. One Windows user lost audio with EQ on in UAC 2.0 mode; switching to UAC 1.0 on the device was the workaround reported.</p>')) return;
  await state.conn.btr.setEqSwitch(on);
  await sleep(1500);
  if (!state.conn.link.closed) state.info.eqSwitch = await state.conn.btr.readEqSwitch();
  renderDevice();
});

function loadFromDevice(id) {
  const s = state.slots[id];
  const model = getModel(state.model);
  state.filters = s.bands.filter((b) => Math.abs(b.gain) >= 0.05 && ['PK', 'LS', 'HS'].includes(b.type))
    .map((b) => model.toRealised({ type: b.type, freq: b.freq, gain: b.gain, q: b.q, enabled: true }));
  state.globalGain = s.globalGain;
  log.info(`Loaded ${sname(id)} into the editor (Q shown as realised under the "${state.model}" model).`);
  render();
}

// ── Editor: loading curves and filters ──────────────────────────────────────
function loadText(text, name = 'pasted text') {
  let r;
  try { r = parseEqText(text, name); } catch (e) {
    $('srcInfo').textContent = `Could not read ${name}: ${e.message}`;
    $('srcWarnings').replaceChildren();
    log.warn(`Import of ${name} failed: ${e.message}`);
    return;
  }
  if (r.kind === 'backup') { offerRestore(r.backup); return; }
  if (r.kind === 'curve') {
    state.target = { name, source: r.source, points: r.points };
    $('srcInfo').innerHTML = `<b>${esc(name)}</b>: ${esc(r.source)}, ${r.points.length} points, ${r.points[0][0]}–${r.points.at(-1)[0]} Hz. Press <b>Fit filters to curve</b>.`;
    log.info(`Loaded curve ${name} (${r.source}, ${r.points.length} points).`);
  } else {
    state.filters = r.filters.map((f) => ({ ...f }));
    state.globalGain = r.preamp ?? 0;
    // The file's own response becomes the target, so you can compare, or re-fit it for the device.
    const db = responseDb(r.filters, grid, r.preamp ?? 0);
    state.target = { name, source: `${r.source} (its own response)`, points: Array.from(grid.f, (f, i) => [f, db[i]]) };
    const tooMany = r.filters.length > prof().expectedBands;
    $('srcInfo').innerHTML = `<b>${esc(name)}</b>: ${esc(r.source)}, ${r.filters.length} filters, preamp ${fmtG(r.preamp ?? 0)} dB.` +
      (tooMany ? ` That is more than the BTR15's ${prof().expectedBands} bands: press <b>Fit filters to curve</b> to re-fit it.` : ' Loaded as entered; you can also re-fit it.');
    log.info(`Loaded ${r.filters.length} filters from ${name}.`);
  }
  $('srcWarnings').replaceChildren(...r.warnings.map((w) => li(w)));
  render();
  persist();
}

$('btnOpen').onclick = () => $('fileInput').click();
$('fileInput').onchange = async (e) => {
  const f = e.target.files[0];
  if (f) loadText(await f.text(), f.name);
  e.target.value = '';
};
$('btnPaste').onclick = () => { $('pasteBox').hidden = false; $('pasteText').focus(); };
$('btnPasteCancel').onclick = () => { $('pasteBox').hidden = true; };
$('btnPasteLoad').onclick = () => { loadText($('pasteText').value, 'pasted text'); $('pasteBox').hidden = true; };
$('btnExample').onclick = async () => {
  const res = location.protocol === 'file:' ? null : await fetch('examples/FiiO_FT1_GraphicEq.txt').catch(() => null);
  if (res?.ok) loadText(await res.text(), 'FiiO_FT1_GraphicEq.txt');
  else loadText(FT1_FALLBACK, 'FiiO_FT1_GraphicEq.txt');
};
const drop = $('dropZone');
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', async (e) => {
  const f = e.dataTransfer.files[0];
  if (f) loadText(await f.text(), f.name);
  else { const t = e.dataTransfer.getData('text'); if (t) loadText(t, 'dropped text'); }
});

$('btnMakeCurve').onclick = async () => {
  const mf = $('measFile').files[0];
  const tf = $('targetFile').files[0];
  if (!mf || !tf) { await alertDlg('Two files needed', '<p>Choose a measurement file and a target file (frequency and dB columns).</p>'); return; }
  try {
    const m = parseEqText(await mf.text(), mf.name);
    const t = parseEqText(await tf.text(), tf.name);
    if (m.kind !== 'curve' || t.kind !== 'curve') throw new Error('Both files must be frequency/dB curves.');
    const pts = equalizationCurve(m.points, t.points, { maxBoost: Number($('measMaxBoost').value) || 6 });
    state.target = { name: `${mf.name} → ${tf.name}`, source: 'measurement + target', points: pts };
    $('srcInfo').innerHTML = `<b>EQ curve</b> from ${esc(mf.name)} towards ${esc(tf.name)}. Press <b>Fit filters to curve</b>.`;
    $('srcWarnings').replaceChildren();
    log.info(`Built an EQ curve from ${mf.name} and ${tf.name}.`);
    render(); persist();
  } catch (e) {
    await alertDlg('Could not make a curve', `<p>${esc(e.message)}</p>`);
  }
};

// ── Model choice ────────────────────────────────────────────────────────────
function syncModelRadios() {
  const { peak, shelf } = parseModelId(state.model);
  for (const r of document.querySelectorAll('input[name=peakLaw]')) r.checked = r.value === peak;
  for (const r of document.querySelectorAll('input[name=shelfLaw]')) r.checked = r.value === shelf;
}
for (const r of document.querySelectorAll('input[name=peakLaw], input[name=shelfLaw]')) {
  r.onchange = () => {
    const peak = document.querySelector('input[name=peakLaw]:checked').value;
    const shelf = document.querySelector('input[name=shelfLaw]:checked').value;
    setModel(modelId({ peak, shelf }));
  };
}
function setModel(id) {
  // Keep the intended filters; what gets SENT changes.
  state.model = id;
  syncModelRadios();
  log.info(`Device model set to "${id}".`);
  render(); persist();
}

// ── Fitting ─────────────────────────────────────────────────────────────────
$('btnFit').onclick = async () => {
  if (!state.target) { await alertDlg('Nothing to fit', '<p>Load a curve first (GraphicEQ, CSV, or a parametric file to re-fit).</p>'); return; }
  $('btnFit').disabled = true;
  $('fitStatus').textContent = 'Fitting…';
  await sleep(30);
  try {
    const t0 = performance.now();
    const r = fitPeq(state.target.points, {
      bands: clampInt($('optBands').value, 1, state.info?.bandCount ?? prof().expectedBands),
      types: $('optTypes').value.split(','),
      trebleWeight: Number($('optTreble').value),
      chainHeadroom: $('optChain').checked,
      model: state.model,
      limits: BTR15_LIMITS,
    });
    state.filters = r.filters.map((f) => ({ ...f, enabled: true }));
    state.globalGain = r.globalGain;
    $('fitStatus').textContent = `Done in ${Math.round(performance.now() - t0)} ms.`;
    log.info(`Auto-EQ (${state.model}): ${r.sent.length} filters, RMS error ${r.stats.all.rms.toFixed(2)} dB, max ${r.stats.all.max.toFixed(2)} dB, global gain ${fmtG(r.globalGain)} dB.`);
  } catch (e) {
    $('fitStatus').textContent = `Fit failed: ${e.message}`;
  } finally {
    $('btnFit').disabled = false;
  }
  render(); persist();
};

// ── Filter table ────────────────────────────────────────────────────────────
function sentFor(f) {
  const model = getModel(state.model);
  const want = model.toSent(f);
  const q = quantizeSent(want);
  const clamped = Math.abs(q.q - want.q) > 0.006 || Math.abs(q.gain - want.gain) > 0.051 || Math.abs(q.freq - want.freq) > 0.51;
  return { sent: q, clamped, want };
}

function renderTable() {
  const tbody = $('filterTable').tBodies[0];
  tbody.replaceChildren(...state.filters.map((f, i) => {
    const tr = document.createElement('tr');
    const { sent, clamped } = sentFor(f);
    tr.innerHTML = `<td>${i + 1}</td>
      <td><input type="checkbox" data-k="enabled" ${f.enabled !== false ? 'checked' : ''} aria-label="Filter ${i + 1} on"></td>
      <td><select data-k="type" aria-label="Type">${['PK', 'LS', 'HS'].map((t) => `<option ${t === f.type ? 'selected' : ''} value="${t}">${{ PK: 'Peak', LS: 'Low shelf', HS: 'High shelf' }[t]}</option>`).join('')}</select></td>
      <td><input type="number" data-k="freq" value="${Math.round(f.freq)}" min="20" max="20000" step="1"></td>
      <td><input type="number" data-k="gain" value="${round(f.gain, 1)}" min="-12" max="12" step="0.1"></td>
      <td><input type="number" data-k="q" value="${round(f.q, 2)}" min="0.05" max="20" step="0.01"></td>
      <td class="sent ${clamped ? 'clamped' : ''}" title="${clamped ? 'Clamped to the BTR15 range' : ''}">${esc(fmtBand(sent))}${clamped ? ' ⚠' : ''}</td>
      <td><button class="icon" aria-label="Remove filter ${i + 1}">✕</button></td>`;
    for (const inp of tr.querySelectorAll('[data-k]')) {
      const k = inp.dataset.k;
      const upd = () => {
        if (k === 'enabled') f.enabled = inp.checked;
        else if (k === 'type') f.type = inp.value;
        else { const v = Number(inp.value); if (!Number.isFinite(v)) return; f[k] = v; }
        const s = sentFor(f);
        const cell = tr.querySelector('.sent');
        cell.textContent = fmtBand(s.sent) + (s.clamped ? ' ⚠' : '');
        cell.classList.toggle('clamped', s.clamped);
        renderGraph();
        persist();
      };
      inp.addEventListener('input', upd);
      inp.addEventListener('change', upd);
    }
    tr.querySelector('button').onclick = () => { state.filters.splice(i, 1); render(); persist(); };
    return tr;
  }));
  $('globalGain').value = round(state.globalGain, 1);
  $('btnAddFilter').disabled = state.filters.length >= (state.info?.bandCount ?? prof().expectedBands);
}

$('globalGain').addEventListener('input', () => {
  const v = Number($('globalGain').value);
  if (Number.isFinite(v)) { state.globalGain = v; renderGraph(); persist(); }
});
$('btnAddFilter').onclick = () => {
  state.filters.push({ type: 'PK', freq: 1000, gain: 0, q: 1, enabled: true });
  render(); persist();
};
$('btnSort').onclick = () => { state.filters.sort((a, b) => a.freq - b.freq); render(); persist(); };
$('btnClearFilters').onclick = () => { state.filters = []; state.globalGain = 0; render(); persist(); };
$('btnExportApo').onclick = () => store.download(`btr15-eq-${stamp()}.txt`, toApoParametric(state.filters, state.globalGain));
$('btnExportJson').onclick = () => store.download(`btr15-eq-${stamp()}.json`, toPresetJson({
  name: state.target?.name ?? 'EQ', filters: state.filters, globalGain: state.globalGain, model: state.model, source: state.target?.source,
}), 'application/json');

// ── Graph ───────────────────────────────────────────────────────────────────
const graph = new ResponseGraph($('graph'));

function realisedResponse(sentFilters, globalGain) {
  const model = getModel(state.model);
  return responseDb(sentFilters.filter((f) => f.enabled !== false).map(model.toRealised), grid, globalGain);
}

function renderGraph() {
  const series = [];
  const sent = state.filters.map((f) => sentFor(f).sent);
  const fit = realisedResponse(sent, round(state.globalGain, 1));
  let target = null;
  if (state.target) {
    target = sampleCurve(state.target.points, grid.f);
    series.push({ id: 'target', label: 'Target', freqs: grid.f, db: target, cls: 'target' });
  }
  if (state.filters.length || !state.target) series.push({ id: 'fit', label: 'BTR15 (this EQ)', freqs: grid.f, db: fit, cls: 'fit' });
  let stored = null;
  const cmp = state.compare != null ? state.slots[state.compare] : null;
  if (cmp) {
    stored = realisedResponse(cmp.bands.filter((b) => ['PK', 'LS', 'HS'].includes(b.type)), cmp.globalGain);
    series.push({ id: 'stored', label: `On device: ${sname(state.compare)}`, freqs: grid.f, db: stored, cls: 'stored' });
  }
  if (target) {
    if (state.filters.length) series.push({ id: 'err', label: 'Error', freqs: grid.f, db: fit.map((v, i) => v - target[i]), cls: 'err', error: true });
    if (stored) series.push({ id: 'err2', label: 'Device error', freqs: grid.f, db: stored.map((v, i) => v - target[i]), cls: 'err2', error: true });
  }
  graph.set(series);
  $('legend').innerHTML = series.filter((x) => !x.error).map((x) => `<span><i class="lg-${x.cls}"></i>${esc(x.label)}</span>`).join('') +
    (series.some((x) => x.error) ? '<span><i class="lg-err"></i>Difference (lower panel)</span>' : '');

  // Stats and warnings.
  const statsEl = $('fitStats');
  const warns = [];
  const chainPeak = Math.max(...realisedResponse(sent, 0));
  const peak = Math.max(...fit);
  if (target && state.filters.length) {
    const s = fitStats(grid, target, fit);
    statsEl.innerHTML = `<span>Error vs target: <b>RMS ${s.all.rms.toFixed(2)} dB</b>, max ${s.all.max.toFixed(2)} dB</span>` +
      `<span class="muted">20–250 Hz ${s.bass.rms.toFixed(2)} · 250 Hz–4 kHz ${s.mid.rms.toFixed(2)} · 4–10 kHz ${s.treble.rms.toFixed(2)} · 10–20 kHz ${s.air.rms.toFixed(2)}</span>` +
      `<span class="muted">Peak ${fmtG(peak)} dB · filters' own peak ${fmtG(chainPeak)} dB</span>`;
  } else {
    statsEl.innerHTML = state.filters.length ? `<span class="muted">Peak ${fmtG(peak)} dB · filters' own peak ${fmtG(chainPeak)} dB</span>` : '';
  }
  if (peak > 0.05) warns.push(`The EQ boosts up to ${fmtG(peak)} dB overall, which can clip on loud music. Lower the global gain by at least ${peak.toFixed(1)} dB.`);
  else if (chainPeak > 0.5) warns.push(`The filters boost ${fmtG(chainPeak)} dB before the global gain is counted. If the BTR15 applies its global gain after the filters, loud passages could clip. Re-fit with "Keep the filters themselves at or below 0 dB" to be safe.`);
  const n = state.info?.bandCount ?? prof().expectedBands;
  if (state.filters.length > n) warns.push(`${state.filters.length} filters, but the BTR15 has ${n} bands. Fit to the curve to reduce them.`);
  if (state.filters.some((f) => sentFor(f).clamped)) warns.push('Some values are outside what the BTR15 accepts (±12 dB, Q 0.25–8, 20 Hz–20 kHz) and will be clamped (marked ⚠).');
  if (Math.abs(state.globalGain) > 12) warns.push('Global gain is limited to ±12 dB on the BTR15.');
  $('filterWarnings').replaceChildren(...warns.map((w) => li(w)));
}

function render() {
  renderTable();
  renderGraph();
  renderModelNote();
}

function renderModelNote() {
  const m = getModel(state.model);
  const res = state.listenResults;
  const bits = [];
  bits.push(m.isIdentity ? 'Filters are sent exactly as shown.' : `Values are converted before sending (see "Sent to BTR15").`);
  if (res.peak) bits.push(`Listening check (peaks, ${new Date(res.peak.at).toLocaleDateString()}): ${res.peak.summary}.`);
  if (res.shelf) bits.push(`Listening check (shelves): ${res.shelf.summary}.`);
  $('modelNote').textContent = bits.join(' ');
}

// ── Saving ──────────────────────────────────────────────────────────────────
$('btnSave').onclick = async () => {
  if (!canWrite()) return;
  const slot = Number($('saveSlot').value);
  const n = state.conn.btr.bandCount ?? state.info?.bandCount;
  if (!n) { await alertDlg('Band count unknown', '<p>Read the device first.</p>'); return; }
  let bands;
  try {
    bands = toDeviceBands(state.filters.map((f) => sentFor(f).sent), n, prof());
  } catch (e) { await alertDlg('Cannot save', `<p>${esc(e.message)}</p>`); return; }
  const globalGain = Math.max(-12, Math.min(12, round(state.globalGain, 1)));
  const rows = bands.map((b) => `<tr><td>${b.index + 1}</td><td>${esc(fmtBand(b))}</td></tr>`).join('');
  const ok = await confirmDlg(`Write ${sname(slot)}?`, `
    ${state.wroteOnce ? '' : '<p><b>This is the first write in this session.</b> The page will switch the BTR15 to the slot, read and back up its contents, then write the values below and save them into that slot. Nothing else is changed. If anything does not read back as written, it stops and shows a diff.</p>'}
    <p>Model: <b>${esc(state.model)}</b>. Global gain <b>${fmtG(globalGain)} dB</b>.</p>
    <table class="diff"><tr><th>Band</th><th>Sent to BTR15</th></tr>${rows}</table>`);
  if (!ok) return;
  await doWriteSlot(slot, { globalGain, bands }, $('verifyStored').checked, 'Saving');
};

async function doWriteSlot(slot, values, verifyStored, label) {
  const stepsEl = $('saveSteps');
  stepsEl.replaceChildren();
  $('saveResult').replaceChildren();
  const steps = {};
  const onStep = (key, text) => {
    for (const s of Object.values(steps)) if (s.classList.contains('doing')) { s.classList.remove('doing'); s.classList.add('done'); }
    let li2 = steps[key];
    if (!li2) { li2 = li(text); steps[key] = li2; stepsEl.append(li2); }
    li2.textContent = text;
    li2.classList.add(key === 'done' ? 'done' : 'doing');
  };
  const result = await busy(label, async () => {
    const r = await state.conn.btr.writeSlot(slot, values, {
      verifyStored,
      onStep,
      onBackup: (live) => {
        const b = store.makeBackup({ device: devDesc(), slot, slotName: sname(slot), live });
        const { ok } = store.addBackup(b);
        log.info(`BACKUP of ${sname(slot)} before writing: ${JSON.stringify(b)}`);
        if (!ok) log.warn('Browser storage is unavailable, so the backup is only in this log. Copy the log to keep it.');
        renderBackups();
      },
    });
    state.wroteOnce = true;
    return r;
  });
  for (const s of Object.values(steps)) s.classList.remove('doing');
  if (!result) { onStepFail(stepsEl); return null; }
  state.info.preset = slot;
  if (result.ok) store.recordLastWrite(deviceKey(), slot, values);
  state.info.globalGain = (result.stored ?? values).globalGain;
  if (result.stored) state.slots[slot] = { globalGain: result.stored.globalGain, bands: result.stored.bands, readAt: Date.now() };
  else state.slots[slot] = { globalGain: values.globalGain, bands: values.bands.map((b) => ({ ...b })), readAt: Date.now() };
  state.compare = slot;
  const out = $('saveResult');
  if (result.ok) {
    out.innerHTML = `<p class="result-ok">Saved into ${esc(sname(slot))}${verifyStored ? ' and verified: the stored slot reads back exactly as written' : ' (live values verified; stored slot not re-checked)'}.</p>`;
    log.info(`Write to ${sname(slot)} OK.`);
  } else {
    onStepFail(stepsEl);
    out.innerHTML = `<p class="result-bad">${result.stage === 'stored' ? 'Saved, but the stored slot does not match what was written:' : 'The device did not accept these values:'}</p>` + diffTable(result.problems) +
      '<p class="small">Copy the log and paste it into the chat. Your previous contents are in Backups.</p>';
    log.error(`Write to ${sname(slot)} FAILED at stage "${result.stage}": ${JSON.stringify(result.problems)}`);
  }
  renderDevice(); render();
  return result;
}

function onStepFail(stepsEl) {
  const last = stepsEl.lastElementChild;
  if (last) { last.classList.remove('done'); last.classList.add('fail'); }
}

function diffTable(problems) {
  const cell = (x) => (x == null ? '(no reply)' : typeof x === 'number' ? `${fmtG(x)} dB` : esc(fmtBand(x)));
  return `<table class="diff"><tr><th>Band</th><th>Written</th><th>Read back</th></tr>${problems.map((p) =>
    `<tr><td>${typeof p.index === 'number' ? p.index + 1 : esc(p.index)}</td><td>${cell(p.expected)}</td><td>${cell(p.got)}</td></tr>`).join('')}</table>`;
}

// ── Backups ─────────────────────────────────────────────────────────────────
function renderBackups() {
  const list = store.loadBackups();
  const el = $('backupList');
  if (!list.length) { el.textContent = 'No backups yet. One is made automatically before every write.'; el.className = 'muted'; return; }
  el.className = '';
  el.replaceChildren(...list.slice(0, 30).map((b) => {
    const row = document.createElement('div');
    row.className = 'backup-row';
    const used = b.bands.filter((x) => Math.abs(x.gain) >= 0.05).length;
    row.innerHTML = `<b>${esc(b.slotName)}</b><span class="when">${new Date(b.takenAt).toLocaleString()} · ${esc(b.device?.productName ?? '')} · ${used} active band(s), gain ${fmtG(b.globalGain)} dB</span>`;
    const restore = btn('Restore…', () => offerRestore(b));
    restore.dataset.write = '';
    row.append(
      btn('Download', () => store.download(`btr15-backup-${b.slotName}-${b.takenAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(b, null, 2), 'application/json')),
      restore,
      btn('Delete', () => { store.deleteBackup(b.id); renderBackups(); }),
    );
    return row;
  }));
  updateControls();
}

$('btnBackupAll').onclick = () => store.download(`btr15-backups-${stamp()}.json`, JSON.stringify(store.loadBackups(), null, 2), 'application/json');
$('btnImportBackup').onclick = () => $('backupFile').click();
$('backupFile').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    const b = Array.isArray(obj) ? obj[0] : obj;
    if (b?.format !== 'eqbtr15-backup') throw new Error('Not an EQBTR15 backup file.');
    offerRestore(b);
  } catch (err) { await alertDlg('Not a backup', `<p>${esc(err.message)}</p>`); }
};

async function offerRestore(b) {
  if (!canWrite()) { await alertDlg('Writing is off', '<p>Connect the BTR15 and tick "Allow writing to the device" to restore a backup.</p>'); return; }
  const n = state.conn.btr.bandCount ?? state.info?.bandCount;
  if (b.bands.length !== n) { await alertDlg('Band count differs', `<p>The backup has ${b.bands.length} bands; the device has ${n}.</p>`); return; }
  const slot = prof().userSlots.includes(b.slot) ? b.slot : Number($('saveSlot').value);
  if (!await confirmDlg(`Restore ${sname(slot)}?`, `<p>Writes the backup from ${esc(new Date(b.takenAt).toLocaleString())} into <b>${esc(sname(slot))}</b> exactly as stored (raw device values, no model conversion). The current contents are backed up first.</p>`)) return;
  await doWriteSlot(slot, { globalGain: b.globalGain, bands: b.bands.map((x) => ({ ...x })) }, true, 'Restoring');
}

// ── Listening check ─────────────────────────────────────────────────────────
const ls = { engine: new NoiseEngine(), active: false, test: null, slot: null, backup: null, cond: null, map: null, rounds: [], deviceGain: null };

$('lsLevel').oninput = () => ls.engine.setLevel(Number($('lsLevel').value));

$('btnLsStart').onclick = async () => {
  if (!canWrite()) return;
  ls.engine.unlock();
  const test = LISTEN_TESTS[$('lsTest').value];
  const slot = Number($('lsSlot').value);
  const ok = await confirmDlg('Start the listening check?', `
    <p>The page will switch the BTR15 to <b>${esc(sname(slot))}</b>, back it up, and set it <b>live, without saving</b> to a single ${esc(fmtBand(test.device))} band with the other bands flat and global gain 0 dB. When you finish, the backed-up values are written back (still without saving).</p>
    <p><b>Turn the volume down first.</b> Make the BTR15 the Windows output device.</p>`);
  if (!ok) return;
  const started = await busy('Preparing listening check', async () => {
    const btr = state.conn.btr;
    if ((await btr.readPreset()) !== slot) await btr.switchPreset(slot);
    const live = await btr.readLive();
    const b = store.makeBackup({ device: devDesc(), slot, slotName: sname(slot), live });
    store.addBackup(b);
    log.info(`BACKUP of ${sname(slot)} before the listening check: ${JSON.stringify(b)}`);
    renderBackups();
    const n = live.bands.length;
    const bands = toDeviceBands([{ ...test.device, enabled: true }], n, prof());
    const problems = await btr.writeLiveVerified({ globalGain: 0, bands });
    if (problems.length) throw new Error(`The test band did not read back as written: ${JSON.stringify(problems)}`);
    Object.assign(ls, { active: true, test, slot, backup: live, rounds: [], deviceGain: test.device.gain });
    return true;
  });
  if (!started) return;
  newRound();
  await ls.engine.start();
  log.info(`Listening check "${test.title}" started; browser sample rate ${ls.engine.sampleRate} Hz.`);
  $('lsPanel').hidden = false;
  $('btnLsStop').hidden = false;
  await setCond('R');
  updateControls();
};

function newRound() {
  const blind = $('lsBlind').checked;
  const swap = blind && Math.random() < 0.5;
  ls.map = swap ? { A: 1, B: 0 } : { A: 0, B: 1 };
  const h = ls.test.hypotheses;
  $('lsStatus').textContent = blind
    ? `Round ${ls.rounds.length + 1}. A and B are shuffled; labels are shown at the end.`
    : `A = ${h[ls.map.A].label}. B = ${h[ls.map.B].label}.`;
}

async function setCond(cond) {
  if (!ls.active) return;
  const wantGain = cond === 'R' ? 0 : ls.test.device.gain;
  const filter = cond === 'A' ? ls.test.hypotheses[ls.map.A].inverse : cond === 'B' ? ls.test.hypotheses[ls.map.B].inverse : null;
  for (const b of document.querySelectorAll('.ab-btn')) b.classList.toggle('active', b.dataset.cond === cond);
  await ls.engine.setFilter(filter, async () => {
    if (ls.deviceGain !== wantGain) {
      await state.conn.btr.writeBand({ ...ls.test.device, index: 0, gain: wantGain });
      ls.deviceGain = wantGain;
    }
  });
  ls.cond = cond;
}

for (const b of document.querySelectorAll('.ab-btn')) {
  b.onclick = () => { ls.engine.unlock(); setCond(b.dataset.cond).catch((e) => log.error(e.message)); };
}

for (const b of document.querySelectorAll('[data-answer]')) {
  b.onclick = async () => {
    if (!ls.active) return;
    const a = b.dataset.answer;
    const chosen = a === 'none' ? null : ls.map[a];
    ls.rounds.push({ answer: a, chosen });
    log.info(`Listening round ${ls.rounds.length}: answered "${a}"${chosen != null ? ` (= ${ls.test.hypotheses[chosen].id})` : ''}.`);
    renderTally();
    newRound();
    if (ls.cond === 'A' || ls.cond === 'B') await setCond(ls.cond);
  };
}

function renderTally() {
  const h = ls.test.hypotheses;
  const counts = h.map((_, i) => ls.rounds.filter((r) => r.chosen === i).length);
  const none = ls.rounds.filter((r) => r.chosen == null).length;
  const n = ls.rounds.length;
  const blind = $('lsBlind').checked;
  const decided = counts[0] + counts[1];
  const best = counts[0] >= counts[1] ? 0 : 1;
  const p = binomTail(Math.max(...counts), decided);
  let verdict = '';
  if (n >= 6 || (!blind && n >= 1)) {
    if (decided >= 5 && p < 0.05) verdict = `<p><b>Your answers point to: ${esc(h[best].label)}</b> (${counts[best]} of ${decided}; chance alone would do this with p ≈ ${p.toFixed(3)}).</p>`;
    else if (none >= n / 2) verdict = '<p><b>Mostly "can\'t tell".</b> Then the difference does not matter much at these settings, and the standard model is fine. If "Device cut only" also sounded like R, the BTR15\'s EQ is not active.</p>';
    else verdict = '<p>No clear answer yet. A few more rounds help.</p>';
  }
  $('lsTally').innerHTML = `<table><tr><th>${blind ? 'Hypothesis (revealed)' : 'Hypothesis'}</th><th>Chosen</th></tr>` +
    h.map((x, i) => `<tr><td>${esc(x.label)}</td><td>${blind && n < 6 ? '…' : counts[i]}</td></tr>`).join('') +
    `<tr><td>Can't tell</td><td>${none}</td></tr></table>` + (blind && n < 6 ? `<p class="muted small">${n} of 6 rounds; results are shown after 6.</p>` : verdict);
  if (verdict && decided >= 5 && p < 0.05) {
    const use = btn(`Use "${h[best].value}" for ${ls.test.law === 'peak' ? 'peaking filters' : 'shelves'}`, () => {
      const cur = parseModelId(state.model);
      cur[ls.test.law] = h[best].value;
      state.listenResults[ls.test.id] = { at: Date.now(), summary: `${h[best].id} chosen ${counts[best]}/${decided}` };
      setModel(modelId(cur));
    });
    $('lsTally').append(use);
  }
}

// P(X >= k) for X ~ Binomial(n, 0.5).
function binomTail(k, n) {
  if (n === 0) return 1;
  let s = 0;
  for (let i = k; i <= n; i++) s += choose(n, i);
  return s / Math.pow(2, n);
}
function choose(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; }

$('btnLsStop').onclick = () => lsStop();

async function lsStop() {
  if (!ls.active) return;
  await ls.engine.stop();
  const { slot, backup } = ls;
  ls.active = false;
  $('lsPanel').hidden = true;
  $('btnLsStop').hidden = true;
  await busy('Restoring after listening check', async () => {
    const btr = state.conn.btr;
    if ((await btr.readPreset()) !== slot) await btr.switchPreset(slot);
    const problems = await btr.writeLiveVerified({ globalGain: backup.globalGain, bands: backup.bands });
    if (problems.length) throw new Error(`Some bands did not restore: ${JSON.stringify(problems)}. The backup is in Backups.`);
    log.info(`Restored ${sname(slot)} to its backed-up values (live). Nothing was saved during the check.`);
  });
  updateControls();
}

function lsAbort(reason) {
  ls.engine.stop();
  ls.active = false;
  $('lsPanel').hidden = true;
  $('btnLsStop').hidden = true;
  log.warn(`${reason} Reconnect, then restore ${sname(ls.slot)} from Backups if it still has the test band.`);
}

// ── Persistence ─────────────────────────────────────────────────────────────
let persistTimer;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => store.saveState({
    target: state.target, filters: state.filters, globalGain: state.globalGain, model: state.model, listenResults: state.listenResults,
    opts: { bands: $('optBands').value, types: $('optTypes').value, treble: $('optTreble').value, chain: $('optChain').checked },
  }), 300);
}
function restore() {
  const s = store.loadState();
  if (!s) return;
  state.target = s.target ?? null;
  state.filters = Array.isArray(s.filters) ? s.filters : [];
  state.globalGain = Number(s.globalGain) || 0;
  state.model = s.model ?? 'standard';
  state.listenResults = s.listenResults ?? {};
  if (s.opts) {
    $('optBands').value = s.opts.bands ?? 10;
    $('optTypes').value = s.opts.types ?? 'PK,LS,HS';
    $('optTreble').value = s.opts.treble ?? 0.5;
    $('optChain').checked = s.opts.chain ?? true;
  }
  if (state.target) $('srcInfo').innerHTML = `<b>${esc(state.target.name)}</b>: ${esc(state.target.source)} (restored from your last visit).`;
}
for (const id of ['optBands', 'optTypes', 'optTreble', 'optChain']) $(id).addEventListener('change', persist);

// ── Dialog helpers ──────────────────────────────────────────────────────────
function confirmDlg(title, html, okText = 'Continue') {
  const dlg = $('confirmDlg');
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = html;
  $('confirmOk').textContent = okText;
  dlg.querySelector('button[value=cancel]').hidden = false;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }));
}
async function alertDlg(title, html) {
  const dlg = $('confirmDlg');
  $('confirmTitle').textContent = title;
  $('confirmBody').innerHTML = html;
  $('confirmOk').textContent = 'OK';
  dlg.querySelector('button[value=cancel]').hidden = true;
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise((resolve) => dlg.addEventListener('close', resolve, { once: true }));
}
const confirmed = new Set();
async function confirmOnce(key, title, html) {
  if (confirmed.has(key)) return true;
  const ok = await confirmDlg(title, html);
  if (ok) confirmed.add(key);
  return ok;
}

// ── Small helpers ───────────────────────────────────────────────────────────
function setStatus(text, cls = '') { const s = $('connStatus'); s.textContent = text; s.className = `chip ${cls}`; }
function btn(text, onclick) { const b = document.createElement('button'); b.textContent = text; b.onclick = onclick; return b; }
function li(text) { const x = document.createElement('li'); x.textContent = text; return x; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtG(g) { const v = round(g, 1); return `${v > 0 ? '+' : ''}${v.toFixed(1)}`; }
function round(x, d) { return Number(Number(x).toFixed(d)); }
function hex4(v) { return (v ?? 0).toString(16).toUpperCase().padStart(4, '0'); }
function stamp() { return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-'); }
function clampInt(v, a, b) { return Math.max(a, Math.min(b, Math.round(Number(v) || b))); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function flash(el, text) { const t = el.textContent; el.textContent = text; setTimeout(() => { el.textContent = t; }, 1200); }
function devDesc() {
  const c = state.conn;
  if (!c) return null;
  return c.transport === 'bluetooth'
    ? { productName: devName(c.device), transport: 'bluetooth', bluetoothId: c.device.id ?? null, firmware: c.btr.firmware ?? null, simulated: !!c.sim }
    : { productName: devName(c.device), transport: 'usb', vendorId: c.device.vendorId, productId: c.device.productId, firmware: state.info?.firmware ?? null, simulated: !!c.sim };
}

// Fill a <select> with the active profile's user presets, keeping the choice if possible.
function fillSlotSelect(sel, defaultIndex = 0) {
  const ids = prof().userSlots;
  const keep = Number(sel.value);
  sel.replaceChildren(...ids.map((id) => new Option(sname(id), id)));
  sel.value = String(ids.includes(keep) ? keep : ids[Math.min(defaultIndex, ids.length - 1)]);
}

const FT1_FALLBACK = 'GraphicEQ: 20 -8.3; 21 -8.2; 22 -8.1; 23 -8; 24 -8; 26 -7.8; 27 -7.8; 29 -7.6; 30 -7.6; 32 -7.4; 34 -7.3; 36 -7.2; 38 -7.1; 40 -7; 43 -6.9; 45 -6.8; 48 -6.7; 50 -6.6; 53 -6.4; 56 -6.2; 59 -6.1; 63 -6; 66 -6.1; 70 -6.1; 74 -6.3; 78 -6.4; 83 -6.7; 87 -6.8; 92 -7.1; 97 -7.3; 103 -7.6; 109 -7.8; 115 -7.9; 121 -8; 128 -8; 136 -8; 143 -7.9; 151 -7.8; 160 -7.7; 169 -7.5; 178 -7.3; 188 -7.1; 199 -6.9; 210 -6.8; 222 -6.6; 235 -6.3; 248 -6.1; 262 -5.8; 277 -5.5; 292 -5.2; 309 -4.9; 326 -4.7; 345 -4.5; 364 -4.3; 385 -4.2; 406 -4.1; 429 -4.1; 453 -4; 479 -4; 506 -4; 534 -4; 565 -4.1; 596 -4.2; 630 -4.3; 665 -4; 703 -3.5; 743 -3.5; 784 -3.6; 829 -3.8; 875 -4; 924 -4.3; 977 -4.6; 1032 -4.9; 1090 -5; 1151 -5; 1216 -5; 1284 -4.9; 1357 -4.8; 1433 -4.9; 1514 -5.3; 1599 -5.6; 1689 -5.9; 1784 -6; 1885 -6; 1991 -5.5; 2103 -4.7; 2221 -4.1; 2347 -3.9; 2479 -4.1; 2618 -4.2; 2766 -4.2; 2921 -3.8; 3086 -3.1; 3260 -2; 3443 -1; 3637 -0.3; 3842 -0.2; 4058 -0.8; 4287 -1.8; 4528 -3.1; 4783 -5.2; 5052 -7.6; 5337 -8; 5637 -6.6; 5955 -5.1; 6290 -3.7; 6644 -2.3; 7018 -0.8; 7414 -0.2; 7831 -0.5; 8272 -0.6; 8738 -0.9; 9230 -1.4; 9749 -2; 10298 -2.5; 10878 -2.9; 11490 -3.5; 12137 -4.1; 12821 -4.8; 13543 -5.6; 14305 -6.5; 15110 -7.5; 15961 -8.5; 16860 -9.7; 17809 -10.9; 18812 -12.2; 19871 -13.6';

// ── Start ───────────────────────────────────────────────────────────────────
$('version').textContent = `v${APP_VERSION}`;
restore();
fillSlotSelect($('saveSlot'), 2);
fillSlotSelect($('lsSlot'), 2);
syncModelRadios();
render();
renderDevice();
renderBackups();
updateControls();
log.info(`BTR15 PEQ Writer ${APP_VERSION} loaded. Web Bluetooth ${'bluetooth' in navigator ? 'available' : 'NOT available'}; WebHID ${'hid' in navigator ? 'available' : 'NOT available'}.`);
// For automated tests only.
window.__btr15 = { state, log };
