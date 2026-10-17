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
  if ($("bridgeCap")) $("bridgeCap").textContent = bridgeOn ? "Bridge on" : "Bridge muted";
  for (const leg of [LEGS.A, LEGS.B]) {
    if (leg.gain) leg.gain.gain.value = bridgeOn ? 1.0 : 0.0;
  }
  logLine(bridgeOn ? "Bridge on." : "Bridge muted.", bridgeOn ? "match" : "warn");
});

function recDeck(btn, on, live) {
  btn.classList.toggle("on", on);
  btn.setAttribute("aria-pressed", String(on));
  btn.querySelector('[data-role="lbl"]').textContent = on ? "Recording" : "Record";
  const sub = btn.querySelector('[data-role="sub"]');   // descriptions removed (user request)
  if (sub) sub.textContent = on ? (live ? "Tap to stop" : "Armed, waits for peers") : "";
}
$("btnMitmRec")?.addEventListener("click", () => {
  const anyRec = LEGS.A.recording || LEGS.B.recording;
  const btn = $("btnMitmRec");
  if (anyRec) {
    legRecordStop(LEGS.A); legRecordStop(LEGS.B);
    recDeck(btn, false);
    logLine("Recording stopped.", "sys");
    return;
  }
  let started = 0;
  for (const leg of [LEGS.A, LEGS.B]) {
    if (leg.peerStream) { legRecordStart(leg, leg.peerStream); started++; }
    else leg.recording = true;   // arm it: starts when the peer connects
  }
  recDeck(btn, true, started);
  logLine(`Recording ${started ? `${started} live` : "armed"}.`, "sys");
});
