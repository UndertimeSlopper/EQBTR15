# BTR15 PEQ Writer

A web page that saves parametric EQ presets to a **FiiO BTR15** over USB, then
reads them back and checks they were stored as written. It also turns EQ files
(AutoEQ GraphicEQ and ParametricEQ, Equalizer APO, CSV) into presets the BTR15 can
actually hold.

It runs in Chrome or Edge on a desktop (WebHID). There is nothing to install.

> Not affiliated with FiiO. The BTR15 support is built from FiiO's own web app tables
> and has not yet been verified on real hardware. See [docs/TESTING.md](docs/TESTING.md).

## Use

* **Hosted:** open the GitHub Pages address of this repository (see "Hosting" below).
* **Local file:** download [`dist/btr15-peq-writer.html`](dist/btr15-peq-writer.html)
  and open it in Chrome or Edge. WebHID works from a local file.
* **From a checkout:** `npm run serve`, then open http://localhost:8080/.

1. Plug in the BTR15 and press **Connect BTR15**. Connecting only reads.
2. Load an EQ file, or press **Load FT1 example**, then press **Fit filters to curve**.
   Or type filters into the table by hand.
3. Tick **Allow writing to the device**, choose USER1–3 and press **Save and verify**.

**Demo device** runs everything against a simulated BTR15 inside the page.

## What it does differently from FiiO's app

* **Safe by construction.** Only seven read and write commands can be encoded. Resets,
  factory reset (`0x21` in FiiO's current code), set-band-count and anything unknown
  throw before a byte is sent. Nothing but GET commands is sent until you tick
  **Allow writing**. Only USER1–3 can be written.
* **Backs up before every write.** The slot is read and kept in browser storage and in
  the log, and can be restored.
* **Verifies.** Every band is read back after it is written. After saving, the page
  switches away and back and reads the slot again, so the check covers what was
  stored, not just what is playing. Each slot card also shows whether it still matches
  what this page last saved, for example after you unplug and replug.
* **Reliable I/O.** One command at a time. Replies are matched by command, band index
  and (when the device echoes it) sequence number, and CRC-checked. Reads time out and
  retry, and fail loudly instead of quietly substituting a default band.
* **Doesn't toggle the EQ switch on connect.** FiiO's page turns the BTR15's EQ on when
  it connects, which may be what re-enumerates USB.
* **A copyable log** of every frame, decoded.

## Auto-EQ

The fitter places peaks and shelves greedily on the residual. It then optimises all
bands and the global gain together (bounded Levenberg-Marquardt, a few restarts), and
rounds to the BTR15's steps: ±12 dB, Q 0.25–8, 20 Hz–20 kHz, 10 bands. It searches in the
values that will be **sent** and scores the response the selected device model says
the BTR15 will **realise**, so it can account for firmware quirks instead of correcting
afterwards.

On the FT1 GraphicEQ it gets within about **0.2 dB RMS** (0.5 dB worst case) from 20 Hz
to 20 kHz. By default the filters are also kept from boosting above 0 dB on their own,
so nothing clips whichever order the BTR15 applies global gain and filters in.

There is also a simple measurement + target → EQ curve step. For AutoEQ's full method,
use its output files.

## The filter-width question

devicePEQ measured FiiO firmware (QX13, KA17) and a Fosi DS3 realising peaking filters
wider than requested: Q ÷ A, with A = 10^(|gain|/40). Nobody has measured a BTR15. The
page offers this as a model you can switch on, and a **listening check** to decide it
without a measurement rig. The BTR15 gets one strong cut, and the browser plays pink
noise through the exact inverse that each model predicts. The right model cancels the
cut, so it sounds like plain noise; the wrong one leaves a ≈3.5 dB colouration. It runs
blind, with A and B shuffled, and reports how likely your answers are by chance.

## Layout

```
index.html          the page
app/main.js         UI wiring
app/protocol.js     frame format, CRC, command allowlist, BTR15 tables
app/device.js       WebHID transport: queue, reply matching, retries, log
app/btr15.js        read / backup / write / save / verify sequences
app/sim.js          simulated BTR15 (demo mode and tests)
app/dsp.js          cookbook biquads, responses, device models
app/fit.js          auto-EQ fitter; measurement + target curve
app/formats.js      importers and exporters
app/listen.js       listening check audio
app/graph.js        response plot
app/storage.js      backups and saved state
docs/PROTOCOL.md    protocol notes and sources
docs/TESTING.md     hardware test plan
tests/              unit tests (node --test) and a browser smoke test
scripts/            single-file build
```

## Develop

```bash
npm test
```

```bash
npm install && node scripts/build-single.mjs
```

The browser smoke test needs Playwright with Chromium: serve the folder, then run
`node tests/e2e/smoke.mjs http://localhost:8080/`.

## Hosting

The page is static. With GitHub Pages enabled for this repository (Settings → Pages →
deploy from a branch, root folder) it is served at
`https://<owner>.github.io/<repo>/`.

## Credits

* [devicePEQ](https://github.com/jeromeof/devicePEQ) by Pragmatic Audio (ISC): the FiiO
  protocol leads and the filter-width measurements.
* [AutoEQ](https://github.com/jaakkopasanen/AutoEq) by Jaakko Pasanen: the formats and
  the idea of fitting PEQ to a curve.
* FiiO's web app at fiiocontrol.fiio.com, studied for the BTR15 tables (no code copied).

MIT licence.
