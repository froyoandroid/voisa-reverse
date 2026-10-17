"use strict";
// Browser-side call recording.

// recording (browser-side, replaces the server recorder)
function rtcRecordStart(stream) {
  try {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "";
    rtc.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    rtc.chunks = [];
    rtc.rec.ondataavailable = (e) => { if (e.data.size) rtc.chunks.push(e.data); };
    rtc.rec.onstop = () => {
      const blob = new Blob(rtc.chunks, { type: rtc.rec.mimeType || "audio/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `voisa-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      logLine(`recording saved (${(blob.size / 1024).toFixed(1)} KB)`, "sys");
    };
    rtc.rec.start(1000);
    logLine("recording started (browser)", "sys");
  } catch (e) {
    logLine(`record failed: ${e.message}`, "err");
  }
}

function rtcRecordStop() {
  try { if (rtc.rec && rtc.rec.state !== "inactive") rtc.rec.stop(); } catch (_) {}
  rtc.rec = null;
}

async function rtcStop() {
  micCleanup();
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
