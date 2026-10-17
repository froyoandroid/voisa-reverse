"use strict";
// Record toggle and Talk (mic) control.

// record button (live toggle)
let recOn = false;
function setRecUI(on) {
  recOn = on;
  const b = $("btnRecord");
  if (!b) return;
  b.textContent = on ? "Stop recording" : "Record";
  b.classList.toggle("on", on);
}
$("btnRecord").onclick = () => send({ cmd: "record", on: !recOn });
// Talk toggle: off -> live (acquire + publish), live -> muted, muted -> live.
// Mute flips track.enabled only. The mic goes onto the call's existing audio
// sender with replaceTrack, so Talk never renegotiates.
async function micTalk() {
  if (CallState.mode !== "active") return;
  if (rtc.micTrack && rtc.micTrack.readyState === "ended") {
    rtc.micStream = null; rtc.micTrack = null; rtc.micState = "off";
  }
  if (rtc.micState === "live") {
    if (rtc.micTrack) rtc.micTrack.enabled = false;
    rtc.micState = "muted"; micPaint(); logLine("mic: muted", "warn");
    return;
  }
  if (rtc.micState === "muted" && rtc.micTrack && rtc.micTrack.readyState === "live") {
    rtc.micTrack.enabled = true;
    rtc.micState = "live"; micPaint(); logLine("mic: live", "match");
    return;
  }
  try {
    await micEnsure();
  } catch (_) { return; }
  await micAttach();
  rtc.micState = "live"; micPaint(); logLine("mic: live", "match");
}
$("btnTalk").onclick = () => micTalk();
$("btnMicRetry").onclick = () => { rtc.micDenied = false; micPaint(); micTalk(); };

function callEnd(reason) {
  // stop locally at once: the peer teardown must not depend on the server
  // replying, or the audio continues until (and unless) it does
  rtcStop();
  currentMatchId = null;
  showMatch(null, "empty");
  send({ cmd: reason || "stopcall" });
  callMode("idle");
}

$("btnHangup") && ($("btnHangup").onclick = () => callEnd("hangup"));
$("btnBufferDialog") && ($("btnBufferDialog").onclick = () => {
  const ev = $("bdEvent").value;
  send({ cmd: "bufferdialog", event: ev });
  logLine(`Response: ${ev}`, "sys");
});

$("btnEmit").onclick = () => {
  let payload = {};
  const raw = $("payload").value.trim();
  if (raw) {
    try { payload = JSON.parse(raw); }
    catch { return logLine("Event data must be valid JSON.", "err"); }
  }
  send({ cmd: "emit", event: $("evt").value, payload });
};
