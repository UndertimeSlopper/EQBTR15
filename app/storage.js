// Browser storage for backups and the editor state. Storage can be missing or
// throw (private windows, blocked site data), so every access is guarded and
// the app keeps working without it. Backups are also written into the log,
// so a copied log preserves them too.

const KEY_BACKUPS = 'eqbtr15.backups.v1';
const KEY_STATE = 'eqbtr15.state.v1';

function read(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function loadBackups() { return read(KEY_BACKUPS, []); }

export function addBackup(entry) {
  const list = loadBackups();
  list.unshift(entry);
  // Keep the newest 60; each is about 1 kB.
  const ok = write(KEY_BACKUPS, list.slice(0, 60));
  return { list, ok };
}

export function deleteBackup(id) {
  const list = loadBackups().filter((b) => b.id !== id);
  write(KEY_BACKUPS, list);
  return list;
}

export function loadState() { return read(KEY_STATE, null); }
export function saveState(state) { return write(KEY_STATE, state); }

export function makeBackup({ device, slot, slotName, live }) {
  return {
    format: 'eqbtr15-backup',
    version: 1,
    id: `${Date.now()}-${slot}`,
    takenAt: new Date().toISOString(),
    device,
    slot,
    slotName,
    globalGain: live.globalGain,
    bands: live.bands.map(({ index, type, freq, gain, q }) => ({ index, type, freq, gain, q })),
  };
}

export function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// What this page last saved into each slot, per device, so a later read
// (for example after unplugging) can show whether the BTR15 kept it.
const KEY_LAST = 'eqbtr15.lastWrites.v1';
export function recordLastWrite(deviceKey, slot, values) {
  const all = read(KEY_LAST, {});
  all[`${deviceKey}:${slot}`] = { at: new Date().toISOString(), globalGain: values.globalGain, bands: values.bands };
  write(KEY_LAST, all);
}
export function lastWrite(deviceKey, slot) {
  return read(KEY_LAST, {})[`${deviceKey}:${slot}`] ?? null;
}
