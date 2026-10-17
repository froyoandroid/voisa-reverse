"use strict";
// Per-leg recording into browser storage (OPFS).

// per-leg recording: each leg captured separately, so the two sides stay
// distinguishable without unmixing
// The bytes go to the SERVER, not to a download.
//
// A browser-side download produced a broken file: MediaRecorder only writes a
// valid container header on stop, so a reload or a torn-down leg left chunks
// that were never assembled and the .webm would not open. Uploading each chunk
// as it is produced means the server always holds everything received so far,
// and the file is fetched deliberately from the recordings list.
function legRecMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// browser storage (OPFS)
// Recordings live in the browser's Origin Private File System, not on the
// server. Each 1s chunk is appended at an explicit offset with its own
// writable + close, so every chunk is flushed to disk as it lands: a reload
// mid-recording leaves a playable file (header in the first chunk, clusters
// appended in order), which is what the old server-side session file bought.
async function recRoot() {
  return navigator.storage.getDirectory();
}
function recStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
async function recWriteChunk(handle, offset, blob) {
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: "write", position: offset, data: blob });
  await w.close();
}

// recording graph
// Why not MediaRecorder on the peer's stream directly (the old way):
//  - a relay leg changes peer every time a stranger leaves and the leg
//    requeues. The old pc and its track die, so the recorder kept running on
//    a dead track, and the next match started a SECOND recorder that wrote
//    into the same file handle. The result was two WebM headers interleaved
//    in one file, and players stopped at the first peer change.
//  - a remote WebRTC track delivers no frames while it is muted or between
//    packets, and MediaRecorder simply skips that time.
// Instead every recording reads a stable track from the shared AudioContext.
// The context renders continuously (silence when no peer is attached), so
// the timeline never breaks (a keep-alive source fills the gaps between peers). Each new peer is plugged into the same
// destination, so one recording spans every match.
//
//   leg A peer --src--> gain --+--> recA  (relay-A-*.webm: A's stranger only)
//                              +--> recMix
//   leg B peer --src--> gain --+--> recB  (relay-B-*.webm: B's stranger only)
//                              +--> recMix (relay-mix-*.webm: the whole conversation)
const REC = {
  on: false,
  slots: {},      // key -> { key, dest, rec, handle, offset, chain, name }
  feeds: {},      // leg key -> { stream, src, gain }
};

function recSlot(key) {
  const ctx = BridgeAudio.context();
  let s = REC.slots[key];
  if (!s) {
    s = REC.slots[key] = { key, dest: ctx.createMediaStreamDestination() };
    s.dest.channelCount = 1;
    // Keep the destination fed while no peer is plugged in. With no active
    // input Chrome stops producing frames, and MediaRecorder silently drops
    // that stretch (a 3 s gap between peers came out as 0 s). An always-on
    // source at -120 dBFS keeps the clock running and stays inaudible.
    s.keepAlive = ctx.createConstantSource();
    s.keepAlive.offset.value = 1e-6;
    s.keepAlive.connect(s.dest);
    s.keepAlive.start();
  }
  return s;
}

// Plug a leg's current peer into its recording and the mix. Safe to call at
// any time: it does nothing while recording is off, and re-plugging the same
// stream is a no-op.
function recFeed(leg, stream) {
  if (!REC.on || !stream || !stream.getAudioTracks().length) return;
  const cur = REC.feeds[leg.key];
  if (cur && cur.stream === stream) return;
  recUnfeed(leg);
  const ctx = BridgeAudio.context();
  try {
    const src = ctx.createMediaStreamSource(stream);
    const gain = ctx.createGain();
    src.connect(gain);
    gain.connect(recSlot(leg.key).dest);
    gain.connect(recSlot("mix").dest);
    REC.feeds[leg.key] = { stream, src, gain };
    logLine(`[mitm] leg ${leg.key}: peer plugged into recording`, "sys");
  } catch (e) {
    logLine(`[mitm] leg ${leg.key} record feed failed: ${e.message}`, "err");
  }
}

function recUnfeed(leg) {
  const f = REC.feeds[leg.key];
  if (!f) return;
  try { f.src.disconnect(); } catch (_) {}
  try { f.gain.disconnect(); } catch (_) {}
  delete REC.feeds[leg.key];
}

function recSlotStart(slot, stamp) {
  const mime = legRecMime();
  slot.name = `relay-${slot.key}-${stamp}.webm`;
  slot.handle = null; slot.offset = 0; slot.chain = Promise.resolve();
  const rec = new MediaRecorder(slot.dest.stream,
    Object.assign({ audioBitsPerSecond: 64000 }, mime ? { mimeType: mime } : {}));
  slot.rec = rec;
  const name = slot.name;
  rec.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    // serialise writes: a slow flush must never interleave with the next chunk
    slot.chain = slot.chain.then(async () => {
      try {
        if (!slot.handle) {
          const root = await recRoot();
          slot.handle = await root.getFileHandle(name, { create: true });
          slot.offset = 0;
        }
        await recWriteChunk(slot.handle, slot.offset, e.data);
        slot.offset += e.data.size;
      } catch (err) {
        logLine(`[mitm] ${slot.key} chunk write failed: ${err.message}`, "err");
      }
    });
  };
  rec.onstop = async () => {
    try {
      await slot.chain;
      const f = slot.handle ? await slot.handle.getFile() : null;
      if (f && f.size) logLine(`[mitm] ${slot.key === "mix" ? "mix" : "leg " + slot.key} recording saved: ${name} (${(f.size / 1024).toFixed(0)} KB, in browser)`, "match");
      else logLine(`[mitm] ${slot.key}: nothing recorded`, "warn");
    } catch (e) {
      logLine(`[mitm] ${slot.key} stop failed: ${e.message}`, "err");
    }
    slot.handle = null; slot.rec = null;
    recListRefresh();
  };
  // 1s slices: frequent enough that a crash loses at most a second
  rec.start(1000);
}

// Start recording both legs and the mix. Called from the Record button (a
// user gesture, so the AudioContext is allowed to run).
function relayRecordStart() {
  if (REC.on) return;
  if (!window.MediaRecorder) { logLine("[mitm] MediaRecorder is not available in this browser", "err"); return; }
  const ctx = BridgeAudio.context();
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  REC.on = true;
  const stamp = recStamp();
  for (const key of ["A", "B", "mix"]) {
    try { recSlotStart(recSlot(key), stamp); }
    catch (e) { logLine(`[mitm] ${key} record failed: ${e.message}`, "err"); }
  }
  for (const leg of [LEGS.A, LEGS.B]) {
    leg.recording = true;
    if (leg.peerStream) recFeed(leg, leg.peerStream);
  }
  logLine("[mitm] recording legs A, B and the mix to browser storage", "sys");
}

function relayRecordStop() {
  if (!REC.on) return;
  REC.on = false;
  for (const leg of [LEGS.A, LEGS.B]) { leg.recording = false; recUnfeed(leg); }
  for (const slot of Object.values(REC.slots)) {
    try { if (slot.rec && slot.rec.state !== "inactive") slot.rec.stop(); } catch (_) {}
  }
}
