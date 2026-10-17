"use strict";
// Browser-side call recording.

// Call recording: both sides (the peer and your mic) mixed in an
// AudioContext and uploaded to the server as it records (ServerRec). A
// keep-alive source keeps the clock running, so a silent stretch or a muted
// mic is recorded as silence rather than skipped.
const CALLREC = { ctx: null, dest: null, keep: null, srcs: [], rec: null };

function callRecPlug(stream) {
  if (!CALLREC.ctx || !stream || !stream.getAudioTracks().length) return;
  try {
    const src = CALLREC.ctx.createMediaStreamSource(stream);
    src.connect(CALLREC.dest);
    CALLREC.srcs.push(src);
  } catch (e) {
    logLine(`record input failed: ${e.message}`, "warn");
  }
}

function rtcRecordStart(stream) {
  if (CALLREC.rec) return;
  if (!window.MediaRecorder) { logLine("Recording is not supported in this browser.", "err"); return; }
  try {
    const ctx = CALLREC.ctx = new AudioContext();
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    CALLREC.dest = ctx.createMediaStreamDestination();
    CALLREC.dest.channelCount = 1;
    CALLREC.keep = ctx.createConstantSource();
    CALLREC.keep.offset.value = 1e-6;
    CALLREC.keep.connect(CALLREC.dest);
    CALLREC.keep.start();
    callRecPlug(stream);
    if (rtc.micStream) callRecPlug(rtc.micStream);
    const peer = (typeof peerInfo !== "undefined" && peerInfo && peerInfo.name) || "";
    CALLREC.rec = new ServerRec(CALLREC.dest.stream, { kind: "call", track: "call", peer });
    CALLREC.rec.start();
    setRecUI(true, CALLREC.rec.t0);
    logLine("recording to the server (you and the peer)", "sys");
    setTimeout(loadRecs, 1500);
  } catch (e) {
    logLine(`record failed: ${e.message}`, "err");
    rtcRecordStop();
  }
}

// The mic was (re)opened mid-recording: plug it in too.
function rtcRecordAddMic() {
  if (CALLREC.rec && rtc.micStream) callRecPlug(rtc.micStream);
}

function rtcRecordStop() {
  const r = CALLREC.rec;
  CALLREC.rec = null;
  const ctx = CALLREC.ctx;
  CALLREC.srcs.forEach((s) => { try { s.disconnect(); } catch (_) {} });
  CALLREC.srcs = [];
  CALLREC.ctx = null;
  setRecUI(false);
  if (!r) { if (ctx) ctx.close().catch(() => {}); return; }
  r.stop().then(() => {
    if (ctx) ctx.close().catch(() => {});
    logLine(`recording saved on the server (${fmtDur(r.elapsed())}, ${(r.bytes / 1024).toFixed(0)} KB)`, "match");
    loadRecs();
    setTimeout(loadRecs, 2500); // after the server's remux
  });
}

async function rtcStop() {
  micIdle();
  waveStop();
  WAVE.reset();
  rtcRecordStop();
  rtc.pendingCandidates = [];
  if (rtc.pc) {
    try { rtc.pc.close(); } catch (_) {}
    rtc.pc = null;
  }
  rtc.audioSender = null;
  const el = $("peerAudio");
  if (el) el.srcObject = null;
  rtc.matchId = null;
}
