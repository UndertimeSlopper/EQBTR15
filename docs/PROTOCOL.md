# FiiO BTR15 USB-HID protocol notes

What this app relies on, where each fact came from, and how sure it is. "Verified"
means checked on a real BTR15; nothing is yet. Everything below comes from reading
code, and the hardware tests in [TESTING.md](TESTING.md) are there to confirm it.

## Sources

| Source | What it gave | Retrieved |
| --- | --- | --- |
| FiiO's web app, fiiocontrol.fiio.com (bundle `static/js/index-hbp1qL_Z.js` and its changelog chunk) | Frame format, CRC, command numbers, the **BTR15 tables** (it lists the BTR15 since v3.5.4), the BTR15-specific handler | 2026-11-19 |
| [devicePEQ](https://github.com/jeromeof/devicePEQ) (ISC), `fiioUsbHidHandler.js`, `usbDeviceConfig.js`, `compensation.js` | Cross-check of byte layout; the filter-width measurements on other FiiO models | 2026-11-19 |
| [AutoEQ](https://github.com/jaakkopasanen/AutoEq) | File formats; shelf filters defined by cookbook Q | from knowledge of the project |

No FiiO code is copied here. The FiiO Control Android app was not needed, because the
web app already has the BTR15 tables.

## Transport

* USB vendor ID `0x2972`. FiiO's app identifies the model from the HID product name; the BTR15's is `FIIO BTR15`.
* HID **output report 7** (FiiO uses 7 for every model not listed otherwise; only the KA17 (1) and JA11 (2) differ). Reports are zero-padded to the length in the HID descriptor.
* Replies arrive as input reports. FiiO's app does not filter them by report ID.

### Observed on a real BTR15 (Windows, Edge 157, 2026-11-19)

* HID product name **`FIIO BTR15 EQ`**, VID `0x2972`, **PID `0x0047`**.
* One HID interface: usage page `0x01` (Generic Desktop), usage `0x00`, **32-byte input and output reports, no report IDs** (report 0), no feature reports. There is no report 7, so FiiO's web-app rule ("report 7 unless listed") cannot apply as written.
* The interface sends an **all-zero 32-byte input report every 4 ms** (250/s) whether or not anything was sent. These are ignored.
* A GET frame placed at byte 0 of report 0 got **no reply**, in both the current and older frame formats.
* Also **no reply** with `07` as the first data byte (`07 BB 0B …`), in either frame format.
* `sendReport(7, …)`, which is what FiiO's web app would do for a product name containing "FIIO BTR15", is **refused by Chrome** ("Failed to write the report"), because the interface has no report IDs.
* So FiiO's web app cannot drive this interface as it enumerates here. Its BTR15 code probably targets a firmware or USB mode that exposes report 7. The FiiO Control Android app does work with this BTR15 over USB, so its code is the next source.

## Frame

```
[h1 h2] [seq_hi seq_lo] [cmd] [len] [payload … len bytes] [crc8] [EE]
 AA 0A  = SET (host → device)
 BB 0B  = GET (host → device) and every reply (device → host)
```

* `seq`: FiiO's current app sends an incrementing 16-bit counter. Older FiiO code, and devicePEQ, send `00 00`.
* `crc8`: CRC-8/MAXIM (Dallas 1-Wire: polynomial 0x31 reflected, init 0) over every byte before it. Older FiiO code and devicePEQ send `00`, so firmware on at least some models does not check it. FiiO's app validates the CRC on some replies, so the device does compute it.
* All multi-byte values are big-endian. Gains are signed 16-bit in 0.1 dB. Frequency is unsigned 16-bit in Hz. Q is unsigned 16-bit in hundredths.

This app sends the current format (incrementing seq, real CRC), logs whether replies echo the sequence number, and, once they do, matches replies by it.

## Commands this app sends

| Cmd | Name (FiiO's) | GET payload → reply payload | SET payload |
| --- | --- | --- | --- |
| `0B` | FIRMWARE_VERSION | – → version bytes | (never sent) |
| `15` | PEQ_PARAMS | `[band]` → `[band, gain16, freq16, q16, type]` | `[band, gain16, freq16, q16, type]` |
| `16` | PEQ_PRE (active preset) | – → `[id]` (1 or 2 bytes) | `[id]` |
| `17` | GLOBAL_GAIN | – → `[gain16]` | `[gain16]` |
| `18` | PEQ_COUNT | – → `[n]` | (never sent) |
| `19` | PEQ_SAVE | – | `[slot id]` |
| `1A` | PEQ_SWITCH (EQ on/off) | – → `[0/1]` | `[0/1]`, only on an explicit button press |

Filter type codes: 0 peak, 1 low shelf, 2 high shelf (3–6 are band-pass, low-pass, high-pass and all-pass, which the BTR15 does not offer).

### Commands this app refuses to encode

Anything not in the table above throws before it is sent. Notably:

* `1B` RESET_PRE and `1C` RESET_ALL_PRE.
* `21`, which FiiO's current app names **RESET_TO_FACTORY** and sends with payload `[0]`. devicePEQ uses `0x21` as a "save v2" command for the BTR17, K17 and K19. That may be right for those models, but it is the same byte FiiO's current code uses for a factory reset, so it is worth knowing about.
* `18` SET (set band count). devicePEQ sends it before writing; FiiO's web app never does.
* `30` preset names (FiiO's app does not support custom names on the BTR15) and the `60`/`61` "PEQ V2" commands (used by FiiO for the KG13, not the BTR15).

## BTR15 specifics (from FiiO's web app tables)

| Item | Value |
| --- | --- |
| Presets | 0 Jazz, 1 Pop, 2 Rock, 3 Dance, 4 R&B, 5 Classic, 6 Hip-hop, **7 USER1, 8 USER2, 9 USER3**, 11 Close EQ, 240 BYPASS (added in FiiO app 3.6.6) |
| Filter types | peak, low shelf, high shelf |
| Band gain | −12 … +12 dB (0.1 dB steps) |
| Global gain | −12 … +12 dB |
| Q | 0.25 … 8 (0.01 steps) |
| Frequency | 20 … 20000 Hz (1 Hz steps) |
| Bands | read from the device (`18`); FiiO's reset writes 10, at 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k and 16k Hz |

The BTR15 gets its own handler in FiiO's app, which differs from the generic one:

* **EQ switch**: toggling it from the UI is a no-op. On connect, the app reads the switch and turns it **on** if it is off (changelog 3.6.6: "same as BTR17"). FiiO has said the BTR15 re-enumerates over USB when EQ is toggled, so this may explain audio dropping when FiiO's page connects. This app reads the switch and only shows it.
* **Preset switch**: waits 1 s after sending it. This app also waits 1 s, then reads the active preset back to confirm.
* **Reset**: instead of `1B`, it writes every band flat (the 10 frequencies above, 0 dB, Q 1, peak) and sets global gain 0.

## Things in FiiO's app code that could explain the reported problems

These are observations from reading the code, not confirmed causes.

* **Saving** writes all bands at once through a queue with no read-back, then sends `19` with the active preset. Nothing checks what was stored.
* **Reading**: if one band's read times out, the app substitutes a default band (20 Hz, 0 dB, Q 1, peak) without telling you. A later save would write that default to the device, which fits "EQ settings not being kept".
* **Matching**: replies are matched on the command byte only, not the band index, so a late reply for one band can be taken as another's.
* **Graph vs device**: the app draws peaks with the standard cookbook formula. If the firmware widens peaks the way devicePEQ measured on the QX13, KA17 and Fosi DS3, the app's graph would be narrower than what you hear.

## Filter maths

FiiO's app draws filters with the RBJ Audio EQ Cookbook formulas at 48 kHz. Shelves use the **Q form**: α = sin(ω₀)/2Q with the 2√A·α term. That is also how AutoEQ and Equalizer APO's LSC/HSC define a shelf's Q, so this app uses the same convention and sends shelf Q unchanged by default.

devicePEQ reports two firmware effects on other FiiO models:

1. **Peaks come out wider**: Q_realised = Q_sent / A, with A = 10^(|gain dB|/40). Measured in detail on a QX13, reproduced on a KA17 and on a Fosi DS3.
2. **Shelves come out "steeper" than requested.** devicePEQ treats the shelf number as slope S. Their measured relation, S = 1/(1 + (1/Q² − 2)/(A + 1/A)), is exactly the cookbook conversion between Q and S. So the firmware is consistent with taking the number as cookbook **Q**, the same convention as AutoEQ. For AutoEQ or APO files this needs no correction.

This app models both effects as options ("How the BTR15 shapes filters"). The listening check tests each on the BTR15 itself.
