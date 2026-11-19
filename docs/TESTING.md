# Hardware test plan (Bluetooth)

Run these in order in Chrome or Edge on Windows, with Bluetooth on. After each test
press **Copy log** and paste it into the chat. Each test only relies on what the
previous one confirmed.

Before you start:

* Pair the BTR15 with Windows (**Settings → Bluetooth & devices → Add device → Bluetooth**, with the BTR15 in pairing mode). If it was paired before and misbehaves, remove it and pair it again.
* Close FiiO Control on your phone.

## Test 1: read only (read commands only)

1. Open the page and press **Connect BTR15**. Chrome/Edge lists serial ports. Pick the BTR15's Bluetooth serial port: it may be called **FIIO BTR15** or **Standard Serial over Bluetooth link (COM…)**. Windows usually creates two of the latter; the right one is the **outgoing** one. If the page gets no answer, connect again and pick the other one.
   * If no such port is listed: **Settings → Bluetooth & devices → Devices → More Bluetooth settings → COM Ports → Add… → Outgoing**, pick the BTR15 and its **Serial Port** service. That tab also shows which COM number is outgoing.
2. Leave **Allow writing to the device** unticked.
3. Check the Device panel: firmware (should be 4.4), EQ switch, active preset, and the bands and global gain of the active preset if it is a user preset.
4. Press **Read USER1–3**. This reads all three user presets without switching presets.
5. Compare what the page shows with FiiO Control for one of the user presets.
6. Copy the log.

(**Bluetooth LE** is a second route, FiiO's fallback. On Windows it needs an LE pairing that the normal pairing may not create, and it failed that way in the first test.)

## Test 2: the first write

1. Press **Load FT1 example** (or open your own file), then **Fit filters to curve**.
2. Tick **Allow writing to the device**. Under **Save to the BTR15**, choose the
   preset you care least about (USER3 by default), keep **Check what was stored**
   ticked, and press **Save and verify**.
3. The page switches to that preset, backs it up, writes each band and the global
   gain, reads each one back, then switches to another user preset and back and
   reads it again. You should see "Saved into USER3 and verified".
4. Turn the BTR15 off and on. Connect again and press **Read USER1–3**. The USER3
   card should say **Matches what this page saved**.
5. Open FiiO Control on the phone and check that USER3 shows the same filters,
   shelves included.
6. Copy the log.

If anything doesn't match, the page stops and shows a diff. The preset's previous
contents are under **Backups**, and **Restore…** writes them back.

## Test 3: listening check (filter width)

1. Make the BTR15 the Windows output device (USB or Bluetooth audio), turn off other
   effects, and turn the volume down.
2. Under **Listening check**, keep "Peaking filter width" and "Blind", then press
   **Start**. Raise the volume to a comfortable level for the noise.
3. Press **Device cut only** once: you should hear a dip around 1 kHz. If it sounds
   exactly like **R**, the BTR15's EQ isn't active; stop and tell me.
4. For each round, switch between **R**, **A** and **B** as often as you like, then
   answer which of A or B sounds exactly like R. Do at least 6 rounds.
5. Press **Finish and restore**, then copy the log.

## Test 4: compare with your phone

1. Select the model the listening check supported, re-fit, and save to a user preset.
2. A/B at the **same BTR15 volume**: (a) the BTR15 on that user preset with the phone
   EQ off; (b) the BTR15 on a flat preset (or EQ off) with your phone's GraphicEQ on.
3. Tell me what still differs and in which range (bass, mids, treble).
