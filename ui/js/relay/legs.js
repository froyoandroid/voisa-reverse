"use strict";
// Relay legs: identities, start/stop, languages.

// MITM: two isolated relays
// Each leg is a separate Voisa identity and a separate match. They must not
// share an account, or the second leg hijacks the first one's session and both
// collapse onto the same match. So each leg mints and adopts its OWN cookie.
function makeLeg(key, elId, audioId) {
  return {
    key, elId, audioId,
    cookie: null, deviceId: null, username: null,
    matchId: null, pc: null, pending: [],
    // bridge
    // The leg SENDS a track built from the OTHER leg's incoming audio, so the
    // two strangers hear each other. gain is a Level-1 mix point where you can
    // also fold in a local mic later without touching the routing.
    sendStream: null,        // MediaStream carrying our outbound audio
    sendTrack: null,
    gain: null,              // GainNode -> destination -> outbound track
    srcNodes: [],            // MediaStreamAudioSourceNode per incoming track
    peerStream: null,        // the peer's incoming audio (for recording/meter)
    recording: false,        // mirrors REC.on (see rec-storage.js)
  };
}

const LEGS = {
  A: makeLeg("A", "leg-A", "legA-audio"),
  B: makeLeg("B", "leg-B", "legB-audio"),
};
mitmSyncToggle();

function legEl(leg) { return $(leg.elId); }
function legState(leg, state, text) {
  const pill = legEl(leg)?.querySelector("[data-role=state]");
  if (pill) { pill.dataset.state = state; pill.textContent = text || state; }
  mitmSyncToggle();
}
// The toggle is derived, never stored: if both legs sit idle the button reads
// "start", otherwise "stop". A separate flag would drift the moment a leg died
// on its own (peer hangup, error, master-switch disconnect).
function mitmLegsIdle() {
  return [LEGS.A, LEGS.B].every((l) => {
    const st = legEl(l)?.querySelector("[data-role=state]")?.dataset.state;
    return !st || st === "idle";
  });
}
function mitmSyncToggle() {
  const start = $("btnMitmStart"), stop = $("btnMitmStop");
  if (!start || !stop) return;
  // one main control: Start while both legs are idle, Stop while either runs
  const idle = mitmLegsIdle();
  start.hidden = !idle; stop.hidden = idle;
  start.disabled = false; stop.disabled = false;
}
function legInfo(leg) {
  const box = legEl(leg)?.querySelector(".leginfo");
  if (!box) return;
  const row = (k, v) => v == null ? "" : `<span>${k}</span><b>${escapeHtml(String(v))}</b>`;
  // relay leg's own identity is a relay name; leg.peer is the REAL person it
  // matched, i.e. A on relay B and D on relay C
  const who = leg.key === "A" ? "Peer A" : "Peer B";
  box.innerHTML =
    row("Relay", leg.username || (leg.cookie ? "…" : "Not started")) +
    row(who, leg.peer || "—");   // Match id row removed (user request)
}

// Ask the server for a brand-new account for this leg (never a pool one).
async function legArm(leg) {
  const j = await (await fetch("/api/relay/fresh", { method: "POST" })).json();
  leg.cookie = j.cookie;
  leg.deviceId = j.deviceId;
  leg.username = null;
  leg.peer = null;
  leg.matchId = null;
  leg._offeredFor = null;
  leg._answering = false;
  leg._answeredFor = null;
  leg._offering = false;
  legState(leg, "idle", "Ready");
  legInfo(leg);
  poolRefresh();
  logLine(`Leg ${leg.key}: ${j.deviceId}`, "match");
}

// A relay's language: its own selector, else the client view's, else en.
// Two legs on the SAME language pool keep matching EACH OTHER (loopback: 15%
// of all matches refused). Auto-assign them different pools — A=English,
// B=Spanish — unless the user picked a language on a leg, which wins. A leg
// whose selector was touched keeps that choice; untouched legs auto-stagger.
function legLang(leg) {
  const sel = document.querySelector(`.leg#${leg.elId} [data-role=lang]`);
  if (sel && sel.dataset.userSet) return sel.value;
  // both legs default to the Indonesian pool; the loopback guard refuses any
  // self-match and requeues, so they keep hunting for real peers
  if (!leg._autoLang) leg._autoLang = "id";
  if (sel) sel.value = leg._autoLang;
  return leg._autoLang;
}
// a manual change marks the selector user-set and stops auto-staggering it
document.querySelectorAll(".leg [data-role=lang]").forEach((sel) => {
  sel.addEventListener("change", () => { sel.dataset.userSet = "1"; });
});

async function legStart(leg, lang, seconds) {
  try {
    // every relay start gets brand-new identities (user rule)
    await legArm(leg);
    send({ cmd: "mitm", leg: leg.key, act: "start",
           cookie: leg.cookie, deviceId: leg.deviceId,
           lang, seconds });
    legState(leg, "searching", "Searching");
    logLine(`Leg ${leg.key}: searching…`, "match");
  } catch (e) {
    logLine(`Leg ${leg.key}: ${e.message}`, "err");
  }
}
function legStop(leg) {
  send({ cmd: "mitm", leg: leg.key, act: "stop" });
  legTeardown(leg);
  legState(leg, "idle", "Stopped");
}

// Rebuild the outbound bus on a leg whose peer is still up. Needed because the
// OTHER leg connecting routes into it, and a teardown may have cleared it.
function legEnsureBridged(leg) {
  if (!leg.pc || leg.pc.connectionState === "closed") return false;
  legEnsureBus(leg);
  return !!leg.sendTrack;
}

function legTeardown(leg) {
  legClearBus(leg);
  recUnfeed(leg);
  leg.peerStream = null;
  if (leg.analyser) { try { leg.analyser.disconnect(); } catch (_) {} leg.analyser = null; }
  leg._lvl = 0;
  if (leg.pc) { try { leg.pc.close(); } catch (_) {} leg.pc = null; }
  const el = $(leg.audioId);
  if (el) el.srcObject = null;
  leg.matchId = null;
  leg._offeredFor = null;
  leg._answering = false;
  leg._answeredFor = null;
  leg._offering = false;
  leg.pending = [];
  leg.fedFrom = {};
  if (leg.rec && leg.rec.state !== "inactive") { try { leg.rec.stop(); } catch (_) {} }
  leg.rec = null;
  legInfo(leg);
  // full teardown means idle, whichever path got here (explicit stop, server
  // close, master-switch disconnect) — so the toggle follows automatically
  legState(leg, "idle", "stopped");
}
