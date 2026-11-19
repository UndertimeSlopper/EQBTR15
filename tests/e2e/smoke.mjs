// End-to-end smoke test against the in-page simulated BTR15 (Bluetooth).
// Usage: node tests/e2e/smoke.mjs [baseUrl] [screenshotDir]
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const base = process.argv[2] ?? 'http://localhost:8765/';
const shots = process.argv[3];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const okDialog = async () => { await page.locator('#confirmDlg[open] #confirmOk').click(); };

await page.goto(base);
await page.click('#btnExample');
await page.waitForSelector('#srcInfo b');
await page.click('#btnFit');
await page.waitForFunction(() => /Done in/.test(document.querySelector('#fitStatus').textContent));
const stats = await page.textContent('#fitStats');
console.log('fit:', stats.replace(/\s+/g, ' ').trim());
const rows = await page.locator('#filterTable tbody tr').count();
console.log('filter rows:', rows);

await page.click('#btnDemo');
await page.waitForFunction(() => /Read: firmware/.test(document.querySelector('#log').textContent));
console.log('device:', (await page.textContent('#devInfo .facts')).replace(/\s+/g, ' ').trim());

await page.check('#allowWrites');
await page.click('#btnSave');
await okDialog();
await page.waitForSelector('#saveResult p', { timeout: 20000 });
console.log('save:', (await page.textContent('#saveResult')).trim());
if (shots) await page.screenshot({ path: `${shots}/after-save.png`, fullPage: true });

// Read all user presets (over Bluetooth this needs no switching and no dialog).
await page.click('#btnReadSlots');
await page.waitForFunction(() => document.querySelectorAll('.slot table').length >= 3, null, { timeout: 20000 });
console.log('slots read:', await page.locator('.slot table').count());

// Listening check prep + restore (audio runs headless; we only check the flow).
await page.click('#btnLsStart');
await okDialog();
await page.waitForSelector('#lsPanel:not([hidden])', { timeout: 20000 });
await page.click('.ab-btn[data-cond="A"]');
await page.click('[data-answer="A"]');
await page.click('#btnLsStop');
await page.waitForFunction(() => /Restored USER3/.test(document.querySelector('#log').textContent), null, { timeout: 20000 });
console.log('listening check: prepared and restored');

const logText = await page.textContent('#log');
console.log('log lines:', logText.split('\n').length);
if (shots) await page.screenshot({ path: `${shots}/final.png`, fullPage: true });
await browser.close();
if (errors.length) { console.error('ERRORS:\n' + errors.join('\n')); process.exit(1); }
console.log('OK');
