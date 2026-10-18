"use strict";
// Relay leg state and per-leg WebRTC.

// Server tells us a leg's state moved.
function legOnCall(leg, m) {
  const phase = m.phase;
  if (m.matchId) leg.matchId = m.matchId;
  if (m.peer) leg.peer = m.peer;
  if (phase === "negotiate") {
    if (m.offer) legOffer(leg).catch((e) => logLine(`Leg ${leg.key}: ${e.message}`, "err"));
  } else if (phase === "connected") {
    bridgePaint();
  } else if (phase === "searching" || phase === "matched") {
    legState(leg, "searching", "Searching");
  } else if (phase === "loopback") {
    legState(leg, "error", "Own relay refused");
    logLine(`Leg ${leg.key}: matched our own relay — refused.`, "err");
    legInfo(leg);
  } else if (phase === "closed") {
    // The stranger hung up; the leg requeues. Tear the pc DOWN: a second
    // negotiate on a reused pc issues a fresh offer whose m-line order no
    // longer matches the prior answer -> "order of m-lines ... doesn't match".
    // Rebuilding the pc per match is what makes the offer valid. The outbound
    // bus survives separately so the OTHER leg's feed is not unbridged.
    legState(leg, "searching", "Peer left");
    legWatchClear(leg);
    leg.peer = null;              // or the old name lingers next to "Searching"
    recUnfeed(leg);               // recording keeps running; the next peer plugs in
    leg.peerStream = null;
    leg.matchId = null;
    leg._offeredFor = null;
  leg._answering = false;
  leg._answeredFor = null;
    if (leg.pc) { try { leg.pc.close(); } catch (_) {} leg.pc = null; }
    if (leg.analyser) { try { leg.analyser.disconnect(); } catch (_) {} leg.analyser = null; }
    const otherLeg = leg.key === "A" ? LEGS.B : LEGS.A;
    if (otherLeg.fedFrom) delete otherLeg.fedFrom[leg.key];
    legInfo(leg);
    bridgePaint();
  } else if (phase === "idle") {
    // an explicit stop: full teardown
    legState(leg, "idle", "Stopped");
    legTeardown(leg);
    bridgePaint();
  }
  legInfo(leg);
}

// Bridge state, per leg: a leg whose own connection is up reads "Bridged".
// It does not wait for the other leg. The bridge is wired the moment either
// peer connects, and whether the other stranger stays is up to them.
function legLive(leg) { return !!(leg.pc && leg.pc.connectionState === "connected" && leg.peerStream); }
function bridgePaint() {
  for (const leg of [LEGS.A, LEGS.B]) {
    if (legLive(leg)) legState(leg, "connected", "Bridged");
  }
  const cap = $("bridgeCap");
  if (cap) cap.textContent = bridgeOn ? "Bridge on" : "Bridge muted";
}

// Watchdog: a match whose connection never comes up (or fails) is a stranger
// hearing dead air. Give it 15 s, then leave and search again.
const LEG_CONNECT_MS = 15000;
function legWatchClear(leg) { clearTimeout(leg._watch); leg._watch = 0; }
function legWatch(leg, pc) {
  legWatchClear(leg);
  leg._watch = setTimeout(() => {
    if (leg.pc !== pc || pc.connectionState === "connected") return;
    legGiveUp(leg, `no connection after ${LEG_CONNECT_MS / 1000} s (${pc.connectionState})`);
  }, LEG_CONNECT_MS);
}
function legGiveUp(leg, reason) {
  legWatchClear(leg);
  logLine(`Leg ${leg.key}: ${reason}; finding another peer.`, "warn");
  send({ cmd: "mitm", leg: leg.key, act: "next", reason });
}

async function legEnsurePc(leg) {
  if (leg.pc) return leg.pc;
  // the leg's own ICE servers (sent with its session), else the tab's
  const ice = leg.iceServers && leg.iceServers.length ? leg.iceServers : (rtc.iceServers || []);
  const pc = new RTCPeerConnection({ iceServers: ice });
  leg.pc = pc;

  // The leg SENDS as well as receives now: its outbound track is the bridge bus,
  // carrying the other leg's peer. Without a track the connection would be
  // recvonly and the two strangers could never hear each other.
  legEnsureBus(leg);
  if (leg.sendTrack) {
    pc.addTrack(leg.sendTrack, leg.sendStream);
    logLine(`[mitm] leg ${leg.key}: outbound bridge track attached`, "sys");
  } else {
    logLine(`[mitm] leg ${leg.key}: no outbound track (voice will be silent)`, "err");
  }
  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    if (ev.track.kind !== "audio") { ev.track.enabled = false; return; }
    const stream = ev.streams[0] || new MediaStream([ev.track]);
    leg.peerStream = stream;
    legMeterAttach(leg, stream);
    const el = $(leg.audioId);
    if (el) { el.srcObject = stream; el.play().catch(() => {}); }
    // the bridge
    // This leg's peer feeds the OTHER leg's outbound bus, so the two strangers
    // hear each other through here. Only route while the other leg actually has
    // a live connection; routing into a torn-down bus silently does nothing and
    // leaves one direction dead.
    // bridgeRewire alone does the routing: calling legRouteIncoming here as
    // well fed the same stream into the other bus twice (double volume)
    const other = leg.key === "A" ? LEGS.B : LEGS.A;
    logLine(`[mitm] leg ${leg.key}: peer audio -> local + onto leg ${other.key}'s outbound`, "med");
    legState(leg, "searching", "Connecting");
    bridgeRewire();
    bridgePaint();
    recFeed(leg, stream);          // no-op unless recording is on
  };
  pc.onconnectionstatechange = () => {
    if (leg.pc !== pc) return;
    const st = pc.connectionState;
    if (st === "connected") {
      legWatchClear(leg);
      logLine(`[mitm] leg ${leg.key}: connected`, "match");
      bridgeRewire();
    } else if (st === "failed") {
      legGiveUp(leg, "connection failed");
    }
    bridgePaint();
  };
  legWatch(leg, pc);
  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    send({ cmd: "mitm", leg: leg.key, act: "signal",
           iceCandidate: { candidate: ev.candidate.candidate, sdpMid: ev.candidate.sdpMid,
                           sdpMLineIndex: ev.candidate.sdpMLineIndex } });
  };
  return pc;
}

function legGather(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((res) => {
    const done = () => { if (pc.iceGatheringState === "complete") { pc.removeEventListener("icegatheringstatechange", done); res(); } };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); res(); }, ms);
  });
}

async function legOffer(leg) {
  // Synchronous lock: two negotiate replays for the same match fire two
  // legOffer calls concurrently, and both would pass the signalingState check
  // below before either offers (TOCTOU). The flag is set before the first
  // await, so the second call never starts. Same-match dedup on top: a replay
  // for a match we already offered for is never a new negotiation.
  if (leg._offering) {
    logLine(`[mitm] leg ${leg.key} skipped concurrent offer`, "warn");
    return;
  }
  if (leg._offeredFor && leg._offeredFor === leg.matchId) {
    logLine(`[mitm] leg ${leg.key} skipped duplicate offer for ${String(leg.matchId).slice(0, 8)}`, "warn");
    return;
  }
  leg._offering = true;
  try {
  const pc = await legEnsurePc(leg);
  // duplicate start-dialog replays: the server can fire negotiate several
  // times for the same match. Re-offering while a local offer is already
  // pending produces a second offer whose m-line order no longer matches ->
  // "order of m-lines ... doesn't match". Only offer from a clean state.
  if (pc.signalingState !== "stable") {
    logLine(`[mitm] leg ${leg.key} skipped re-offer (state ${pc.signalingState})`, "warn");
    return;
  }
  leg._offeredFor = leg.matchId;
  await pc.setLocalDescription(await pc.createOffer());
  await legGather(pc);
  // a torn-down pc yields a null localDescription; bail rather than read .sdp
  if (!pc.localDescription || pc.signalingState === "closed") {
    logLine(`[mitm] leg ${leg.key} offer aborted (pc closed)`, "warn");
    return;
  }
  send({ cmd: "mitm", leg: leg.key, act: "signal",
         offer: { type: "offer", sdp: pc.localDescription.sdp } });
  logLine(`[mitm] leg ${leg.key} offered`, "sys");
  } finally {
    leg._offering = false;
  }
}

async function legSignal(leg, p) {
  if (p.offer) {
    // Synchronous lock, same TOCTOU as the offer side: N duplicate offers for
    // one match race each other, and every one passes the signalingState check
    // before the first answer lands — then all N throw "wrong state: stable".
    // First call wins; the rest are ignored with a warn.
    if (leg._answering) {
      logLine(`[mitm] leg ${leg.key} skipped concurrent answer`, "warn");
      return;
    }
    const offerKey = (p.offer.sdp || "").slice(0, 64);
    if (leg._answeredFor === offerKey) {
      logLine(`[mitm] leg ${leg.key} skipped duplicate offer (already answered)`, "warn");
      return;
    }
    leg._answering = true;
    try {
    const pc = await legEnsurePc(leg);
    // glare: an offer arriving when we already have one in flight. Only answer
    // from a clean state; a settled or mid-negotiation pc must not re-answer,
    // or it throws "wrong state" and wedged the pair before.
    if (pc.signalingState !== "stable" && pc.signalingState !== "closed") {
      // already negotiating; the existing offer/answer wins
      logLine(`[mitm] leg ${leg.key} ignored duplicate offer (state ${pc.signalingState})`, "warn");
      return;
    }
    if (pc.signalingState === "closed") return;
    leg._answeredFor = offerKey;
    await pc.setRemoteDescription({ type: "offer", sdp: p.offer.sdp });
    for (const c of leg.pending.splice(0)) { try { await pc.addIceCandidate(c); } catch (_) {} }
    await pc.setLocalDescription(await pc.createAnswer());
    await legGather(pc);
    if (!pc.localDescription || pc.signalingState === "closed") {
      logLine(`[mitm] leg ${leg.key} answer aborted (pc closed)`, "warn");
      return;
    }
    send({ cmd: "mitm", leg: leg.key, act: "signal",
           answer: { type: "answer", sdp: pc.localDescription.sdp } });
    logLine(`[mitm] leg ${leg.key} answered`, "sys");
    } finally {
      leg._answering = false;
    }
  } else if (p.answer) {
    // replayed answers: the server sends the same answer 3-4x per match. The
    // first lands and settles the pc to stable; the rest must be skipped, or
    // each throws "wrong state: stable". Already stable means already answered.
    if (!leg.pc || leg.pc.signalingState === "stable") return;
    await leg.pc.setRemoteDescription({ type: "answer", sdp: p.answer.sdp });
    for (const c of leg.pending.splice(0)) { try { await leg.pc.addIceCandidate(c); } catch (_) {} }
  } else if (p.iceCandidate) {
    const c = p.iceCandidate;
    if (!leg.pc || !leg.pc.remoteDescription) { leg.pending.push(c); return; }
    try { await leg.pc.addIceCandidate(c); } catch (_) {}
  }
}

$("btnMitmStart")?.addEventListener("click", async () => {
  const h = $("mitmHint");
  // Re-press while running = restart: tear the browser sides down first, then
  // start fresh. The backend also stops its own bridge per leg on start.
  const restart = !mitmLegsIdle();
  if (restart) { legStop(LEGS.A); legStop(LEGS.B); }
  // Settings > Relay > Auto-record: started inside the click so the audio
  // context may run; it records each peer as it connects
  if (prefs().autoRecRelay && !REC.on) {
    relayRecordStart();
    recDeck($("btnMitmRec"), REC.on, 0);
  }
  await legStart(LEGS.A, legLang(LEGS.A), 0);
  await legStart(LEGS.B, legLang(LEGS.B), 0);
  if (h) h.textContent = restart ? "Restarted — searching fresh" : "Searching — both peers appear below";
  mitmSyncToggle();
});
$("btnMitmStop")?.addEventListener("click", () => {
  if (mitmLegsIdle()) return;
  legStop(LEGS.A); legStop(LEGS.B);
  // stopping the relay finalises its recordings, or they would keep
  // recording silence from the context
  if (REC.on) { relayRecordStop(); recDeck($("btnMitmRec"), false); }
  const h = $("mitmHint");
  if (h) h.textContent = "Stopped";
  mitmSyncToggle();
});

document.querySelectorAll(".leg").forEach((sec) => {
  const leg = sec.id === "leg-A" ? LEGS.A : LEGS.B;
  sec.querySelectorAll("[data-act]").forEach((b) => {
    b.onclick = () => {
      const secs = 0;
      if (b.dataset.act === "search") legStart(leg, legLang(leg), secs);
      else if (b.dataset.act === "newid") legNewIdentity(leg);
      else legStop(leg);
    };
  });
});
