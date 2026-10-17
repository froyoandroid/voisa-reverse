"use strict";
// Call deck painting: primary button, Talk, mic banner.

// One primary button carries the whole flow: idle -> searching -> in call.
// It stays correct because every state path (incoming, matched, ended) syncs it.
const CallState = { mode: "idle", busy: false };
function callPaint() {
  const s = $("btnSearch"), r = $("btnRecord"), lang = $("lang");
  if (s) {
    s.disabled = CallState.busy;
    s.textContent = CallState.mode === "idle" ? "Start"
      : CallState.mode === "searching" ? "Searching… stop"
      : "End";
    s.classList.toggle("primary", CallState.mode !== "active");
    s.classList.toggle("quiet", CallState.mode === "active");
  }
  if (r) { r.hidden = CallState.mode !== "active"; }
  if (lang) lang.disabled = CallState.mode !== "idle";
  const st = $("stage"), tt = $("stageTitle");
  if (st) st.dataset.mode = CallState.mode;
  if (tt) tt.textContent = CallState.mode === "idle" ? "Ready"
    : CallState.mode === "searching" ? "Searching" : "On air";
  micPaint();
}
function callMode(m) { CallState.mode = m; CallState.busy = false; callPaint(); }
// Talk button + mic banner reflect mic state only. Hidden unless in a call.
function micPaint() {
  const t = $("btnTalk"), b = $("micBanner");
  if (t) {
    t.hidden = CallState.mode !== "active";
    t.textContent = rtc.micState === "live" ? "Mute" : rtc.micState === "muted" ? "Unmute" : "Talk";
    t.classList.toggle("on", rtc.micState === "live");
  }
  if (b) b.hidden = !rtc.micDenied;
}
