"use strict";
// Per-leg relay recording, uploaded to the server as it records.

// per-leg recording: each leg captured separately, so the two sides stay
// distinguishable without unmixing. Chunks stream to the server through
// ServerRec (recordings/upload.js); browser storage (OPFS) is no longer used
// because it lost and broke files.

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
  since: 0,       // ms epoch the current recording started (0 = off)
  slots: {},      // key -> { key, dest, keepAlive, rec: ServerRec }
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

function recSlotStart(slot, group) {
  slot.rec = new ServerRec(slot.dest.stream, { kind: "relay", track: slot.key, group });
  slot.rec.start().catch((e) => logLine(`[mitm] ${slot.key} record failed: ${e.message}`, "err"));
}

// Start recording both legs and the mix. Called from the Record button (a
// user gesture, so the AudioContext is allowed to run).
function relayRecordStart() {
  if (REC.on) return;
  if (!window.MediaRecorder) { logLine("[mitm] MediaRecorder is not available in this browser", "err"); return; }
  const ctx = BridgeAudio.context();
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  REC.on = true;
  REC.since = Date.now();
  const group = `g${REC.since.toString(36)}`;
  for (const key of ["A", "B", "mix"]) {
    try { recSlotStart(recSlot(key), group); }
    catch (e) { logLine(`[mitm] ${key} record failed: ${e.message}`, "err"); }
  }
  for (const leg of [LEGS.A, LEGS.B]) {
    leg.recording = true;
    if (leg.peerStream) recFeed(leg, leg.peerStream);
  }
  logLine("[mitm] recording legs A, B and the mix to the server", "sys");
  setTimeout(recListRefresh, 1500);
}

function relayRecordStop() {
  if (!REC.on) return;
  REC.on = false;
  for (const leg of [LEGS.A, LEGS.B]) { leg.recording = false; recUnfeed(leg); }
  REC.since = 0;
  const stops = Object.values(REC.slots).filter((s) => s.rec).map((slot) => {
    const r = slot.rec; slot.rec = null;
    return r.stop();
  });
  Promise.all(stops).then((rs) => {
    const kb = rs.reduce((n, r) => n + r.bytes, 0) / 1024;
    logLine(`[mitm] recording saved on the server (${kb.toFixed(0)} KB, ${fmtDur(rs[0] ? rs[0].elapsed() : 0)})`, "match");
    recListRefresh();
    setTimeout(recListRefresh, 2500); // after the server's remux
  });
}
