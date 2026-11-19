# Hardware test plan

Run these in order, on Windows in Chrome or Edge, with the BTR15 on USB. After each
test press **Copy log** and paste it into the chat. Each test only uses what the
previous one confirmed.

Before starting, close FiiO Control and any tab with fiiocontrol.fiio.com open:
another program holding the device can swallow replies.

## Test 1: read only (sends GET commands only)

1. Open the page and press **Connect BTR15**. Pick the BTR15 in Chrome's list.
2. Leave **Allow writing to the device** unticked.
3. Check the Device panel: firmware, EQ switch, active preset, number of bands,
   global gain, and the bands of the active preset.
4. Copy the log.

This checks the report ID, the frame format and CRC, that the BTR15 answers, the band
count, and whether it echoes sequence numbers. Nothing on the device changes.

## Test 2: preset switching (changes which preset plays, not their contents)

1. Tick **Allow writing to the device**.
2. Press **Read USER1–3**. The page switches to each user slot, reads it, and switches
   back to the preset that was active.
3. Note whether audio dropped or stopped while it switched. Play music during this test.
4. Copy the log.

## Test 3: the first write

1. Press **Load FT1 example** (or open your own file), then **Fit filters to curve**.
2. Under **Save to the BTR15**, choose the slot you care least about (USER3 by
   default). Keep **Check what was stored** ticked. Press **Save and verify**.
3. The page backs up the slot, writes, reads back, saves, switches away and back, and
   reads again. You should see "Saved into USER3 and verified".
4. Unplug the BTR15, wait a few seconds, plug it back in, then reconnect and press
   **Read USER1–3**. The USER3 card should say **Matches what this page saved**.
   This is the real persistence check, because switching presets might not reload
   from flash.
5. Copy the log.

If anything does not match, the page stops and shows a diff. The slot's previous
contents are under **Backups**; **Restore…** puts them back.

## Test 4: listening check (filter width)

1. In Windows sound settings, make the BTR15 the output device and turn off other
   effects. Turn the volume down.
2. Under **Listening check**, keep "Peaking filter width" and "Blind", then press
   **Start**. Raise the volume to a comfortable level for the noise.
3. Press **Device cut only** once: you should hear a clear dip around 1 kHz. If it
   sounds exactly like **R**, the BTR15's EQ is not active; stop and tell me.
4. For each round, switch between **R**, **A** and **B** as often as you like, then
   answer which of A or B sounds exactly like R. Do 6 rounds or more.
5. Press **Finish and restore**, then copy the log.

The page shows which model your answers support, and a button to use it. Optionally,
repeat with "Low-shelf convention". If you mostly can't tell A from B, the difference
does not matter at these gains.

## Test 5: compare with your phone

1. Select the model the listening check supported, re-fit, and save to a user slot.
2. A/B at the **same BTR15 volume**: (a) BTR15 on that user slot with the phone EQ off;
   (b) BTR15 on **Close EQ** or **BYPASS** with your phone's GraphicEQ on. The fitted
   preset is level-matched to the GraphicEQ (its loudest point is about the same), so
   no volume change is needed.
3. Tell me what still differs and in which range (bass, mids, treble).
