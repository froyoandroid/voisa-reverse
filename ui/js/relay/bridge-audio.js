"use strict";
// Bridge audio graph and per-leg meters.

// bridge audio graph
// One shared AudioContext. Per leg, an outbound bus:
//
//   <peer track> --MediaStreamSource--> gainB --MediaStreamDestination--> sendTrack
//                                        ^
//                          (future: local mic mixes in here)
//
// Leg A's bus carries what leg B hears, and vice versa. That is what makes B
// and C hear each other: A's voice enters leg B's outbound track, C's voice
// enters leg A's.
const BridgeAudio = (() => {
  let ctx = null;
  function context() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    // Autoplay policy can start the context suspended until a user gesture.
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  return { context, get current() { return ctx; } };
})();

// Per-leg level meter: an analyser taps the peer's incoming stream and a rAF
// loop fills the bar. The fill is smoothed (fast attack, slow release) so
// speech reads as a steady glow instead of a flicker. Green while audio is
// actually audible, grey otherwise — the bar the CSS already laid out but
// nothing ever drove.
function legMeterAttach(leg, stream) {
  const ctx = BridgeAudio.context();
  if (leg.analyser) { try { leg.analyser.disconnect(); } catch (_) {} }
  const an = ctx.createAnalyser();
  an.fftSize = 256;
  an.smoothingTimeConstant = 0.65;
  try {
    ctx.createMediaStreamSource(stream).connect(an);
  } catch (e) {
    logLine(`[mitm] leg ${leg.key} meter: ${e.message}`, "warn");
    return;
  }
  leg.analyser = an;
  leg._meterData = new Uint8Array(an.frequencyBinCount);
  leg._meterEl = legEl(leg)?.querySelector(".meter i");
}
// Smoothing state per leg so the bar eases up on speech and drains on silence.
function legMeterTick() {
  for (const leg of [LEGS.A, LEGS.B]) {
    const el = leg._meterEl;
    if (!el) continue;
    if (leg.analyser && leg.peerStream) {
      leg.analyser.getByteFrequencyData(leg._meterData);
      let sum = 0;
      for (let i = 0; i < leg._meterData.length; i++) sum += leg._meterData[i];
      const level = Math.min(1, (sum / leg._meterData.length) / 90);
      // attack faster than decay: up in one frame, fade in ~0.3s
      leg._lvl = Math.max(level, (leg._lvl || 0) * 0.88);
      el.style.width = `${Math.round(leg._lvl * 100)}%`;
      legEl(leg)?.setAttribute("data-audible", leg._lvl > 0.06 ? "1" : "0");
    } else {
      leg._lvl = 0;
      el.style.width = "0%";
      legEl(leg)?.setAttribute("data-audible", "0");
    }
  }
  requestAnimationFrame(legMeterTick);
}
requestAnimationFrame(legMeterTick);

// Build (once) the outbound bus for a leg: a gain node whose output is a real
// MediaStreamTrack we can add to the peer connection.
function legEnsureBus(leg) {
  if (leg.sendTrack) return leg;
  const ctx = BridgeAudio.context();
  leg.gain = ctx.createGain();
  leg.gain.gain.value = 1.0;
  const dest = ctx.createMediaStreamDestination();
  leg.gain.connect(dest);
  leg.sendStream = dest.stream;
  leg.sendTrack = dest.stream.getAudioTracks()[0] || null;
  return leg;
}

// Feed one incoming track into a leg's outbound bus. Called for the OTHER leg.
// Rewire both directions from whatever each leg currently has. Idempotent, so
// it is safe to call on every state change: whichever leg connects second also
// completes the FIRST leg's feed, which a one-shot route at connect time missed.
function bridgeRewire() {
  for (const src of [LEGS.A, LEGS.B]) {
    const dst = src.key === "A" ? LEGS.B : LEGS.A;
    if (!src.peerStream || !dst.pc || dst.pc.connectionState === "closed") continue;
    legEnsureBus(dst);
    // already fed from this source? track nodes per source leg
    if (dst.fedFrom && dst.fedFrom[src.key]) continue;
    dst.fedFrom = dst.fedFrom || {};
    dst.fedFrom[src.key] = true;
    legRouteIncoming(dst, src.peerStream);
    logLine(`[mitm] bridge wired ${src.key} -> ${dst.key}`, "match");
  }
}

function legRouteIncoming(destLeg, stream) {
  // If the destination leg has no live connection there is nothing to feed;
  // feeding a closed pc's track would go nowhere.
  if (!destLeg.pc || destLeg.pc.connectionState === "closed") {
    logLine(`[mitm] leg ${destLeg.key} not connected; its bridge feed is deferred`, "warn");
    return;
  }
  const ctx = BridgeAudio.context();
  legEnsureBus(destLeg);
  for (const t of stream.getAudioTracks()) {
    const src = ctx.createMediaStreamSource(new MediaStream([t]));
    src.connect(destLeg.gain);
    destLeg.srcNodes.push(src);
  }
}

// Drop only the incoming feeds. The outbound bus survives, so the peer
// connection can be rebuilt without unbridging the other leg.
function legClearSources(leg) {
  for (const n of leg.srcNodes) { try { n.disconnect(); } catch (_) {} }
  leg.srcNodes = [];
  leg.fedFrom = leg.fedFrom || {};
}

function legClearBus(leg) {
  for (const n of leg.srcNodes) { try { n.disconnect(); } catch (_) {} }
  leg.srcNodes = [];
  if (leg.gain) { try { leg.gain.disconnect(); } catch (_) {} leg.gain = null; }
  leg.sendStream = null;
  leg.sendTrack = null;
}
