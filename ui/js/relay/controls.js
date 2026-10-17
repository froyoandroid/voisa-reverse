"use strict";
// Relay deck: bridge and record controls.

// bridge + record controls
// The bridge can be muted live: gain -> 0 means each leg hears silence from the
// other, so you can cut the two strangers apart without dropping either call.
let bridgeOn = true;

$("btnMitmBridge")?.addEventListener("click", () => {
  bridgeOn = !bridgeOn;
  const btn = $("btnMitmBridge");
  btn.classList.toggle("on", bridgeOn);
  btn.setAttribute("aria-pressed", String(bridgeOn));
  bridgePaint();
  for (const leg of [LEGS.A, LEGS.B]) {
    if (leg.gain) leg.gain.gain.value = bridgeOn ? 1.0 : 0.0;
  }
  logLine(bridgeOn ? "Bridge on." : "Bridge muted.", bridgeOn ? "match" : "warn");
});

function recDeck(btn, on, live) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  // while recording the label is a live clock (data-since ticks every second)
  const lbl = btn.querySelector('[data-role="lbl"]');
  if (on && REC.since) lbl.innerHTML = `Recording <b class="rec-clock" data-since="${REC.since}">${fmtDur(Date.now() - REC.since)}</b>`;
  else lbl.textContent = on ? "Recording" : "Record";
  const sub = btn.querySelector('[data-role="sub"]');   // descriptions removed (user request)
  if (sub) sub.textContent = on ? (live ? "Tap to stop" : "Armed, waits for peers") : "";
}
$("btnMitmRec")?.addEventListener("click", () => {
  const btn = $("btnMitmRec");
  if (REC.on) {
    relayRecordStop();
    recDeck(btn, false);
    logLine("Recording stopped.", "sys");
    return;
  }
  relayRecordStart();
  const live = [LEGS.A, LEGS.B].filter((l) => l.peerStream).length;
  recDeck(btn, REC.on, live);
  logLine(`Recording ${live ? `${live} live leg(s)` : "started, waiting for peers"}.`, "sys");
});
