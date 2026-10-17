"use strict";
// Start/stop search loop.

$("btnSearch").onclick = () => {
  if (CallState.busy) return;
  if (CallState.mode === "idle" || CallState.mode === "searching") {
    if (CallState.mode === "searching") { stopSearch(); callEnd("stopcall"); }
    else { searchN = 0; micOpenForSession(); startSearch(); }
  }
  else callEnd("stopcall");
};
// First press keeps hunting until a partner connects. Any idle/closed
// with no match re-fires automatically; only an explicit stop (or a real
// call ending) goes idle. Toggle searchAuto=false to restore one-shot.
let searchAuto = prefs().keepSearching;   // Settings > Call
let searchN = 0;
function startSearch() {
  if (CallState.mode !== "searching" && CallState.mode !== "idle") return;
  CallState.busy = true; callPaint();
  searchN++;
  send({ cmd: "search", lang: $("lang").value });
  WAVE.reset("Waiting…");
  setRecUI(false);
  showMatch(null, "searching", searchN > 1 ? `Looking… (${searchN})` : "Searching…");
  setConn("on", searchN > 1 ? "Looking…" : "Searching…");
  callMode("searching");
}
function stopSearch() {
  searchN = 0;
  send({ cmd: "stopcall" });
  rtcStop();
  currentMatchId = null;
  callMode("idle");
  setConn(ws && ws.readyState === 1 ? "on" : "off", ws && ws.readyState === 1 ? "Ready" : "Connecting…");
  showMatch(null, "empty");
  if (typeof peerInfo !== "undefined" && peerInfo) showPeer(peerInfo, "ended");
}
// Call setup panel is commented out in Settings — handlers stay for restore,
// guarded so missing elements do not throw at load.
$("btnCall") && ($("btnCall").onclick = () => {
  send({
    cmd: "call", lang: $("lang").value,
    media: false,
    record: false,
    audioFile: ($("audioFile").value || "").trim() || null,
  });
  WAVE.reset();
  setRecUI(false);
  showMatch(null, "searching", "Starting call…");
  callMode("searching");
});
