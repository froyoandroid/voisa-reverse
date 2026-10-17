"use strict";
// Voisa events and call phases -> Call view.

function onEvent(name, payload) {
  const p = payload == null ? "" : JSON.stringify(redact(payload));
  let cls = "in";
  if (name === "start-dialog" || name === "buffer-dialog") cls = "match";
  // The call handler already logs a clean "incoming call from X" line, so don't
  // also dump the raw payload — it buried the useful output.
  const quiet = name === "buffer-dialog" ||
                (name === "start-dialog" && payload && payload.username);
  if (!quiet) logLine(`← ${name} ${p}`, cls);

  if (name === "start-dialog" && payload) {
    currentMatchId = payload.matchId;
    callMode("active");
    setConn("on", payload.initiate ? "Incoming call" : "Matched");
    showMatch(payload, "active");
    showPeer(payload, payload.initiate ? "pending" : "live");
    logLine(payload.initiate ? `Incoming: ${payload.username}` : `Matched: ${payload.username}`, "match");
    // the server accepts the dialog itself the moment it arrives
    rtcStart(payload.matchId)
      .catch((e) => logLine(e.message, "err"));
  }
  if (name === "close-dialog") {
    if (!currentMatchId && searchAuto && CallState.mode === "searching") {
      logLine(`No partner — still looking (${searchN + 1})…`, "warn");
      startSearch();
    } else {
      currentMatchId = null;
      rtcStop();
      callMode("idle");
      showMatch(null, "empty");
      // keep the peer card visible but mark it ended, so you can still read who
      // it was; clearPeer() runs when the next search starts
      if (peerInfo) showPeer(peerInfo, "ended");
    }
  }
}

function onCall(m) {
  if (m.phase === "searching") {
    clearPeer();
    CallState.mode = "searching"; CallState.busy = false; callPaint();
    showMatch(null, "searching", "Searching…");
  } else if (m.phase === "waiting") {
    CallState.mode = "searching"; CallState.busy = false; callPaint();
    showMatch(null, "searching", "Waiting…");
  } else if (m.phase === "matched") {
    setConn("on", "Matched");
    callMode("active");
    showMatch(m, "active");
    showPeer(m, "live");               // show WHO, immediately
  } else if (m.phase === "level") {
    // handled by the waveform
  } else if (m.phase === "media") {
    if (!currentMatchId) showMatch(m, "active");
    if (m.peer) showPeer(m, "live");
    logLine(m.path ? `${m.track} saved` : `${m.track} live (not saved)`, "med");
  } else if (m.phase === "connected") {
    callMode("active");
    setConn("on", "In call");
    showMatch(m, "active");
    showPeer(m, "live");
  } else if (m.phase === "idle" || m.phase === "closed") {
    // No match yet and the user never pressed stop: keep hunting.
    // A real call ending (currentMatchId set) goes idle instead.
    if (!currentMatchId && searchAuto && CallState.mode === "searching") {
      logLine(`No partner — still looking (${searchN + 1})…`, "warn");
      startSearch();
    } else {
      // The call is over: tear the browser peer down or it keeps the connection
      // open and the partner's audio keeps playing after "stop".
      rtcStop();
      currentMatchId = null;
      callMode("idle");
      setConn(ws && ws.readyState === 1 ? "on" : "off", ws && ws.readyState === 1 ? "Ready" : "Connecting…");
      showMatch(null, "empty");
      if (peerInfo) showPeer(peerInfo, "ended");
    }
  } else {
    // pc state names: connecting / failed / new …
    if (currentMatchId) showMatch(m, "active");
    if (m.peer) showPeer(m, "live");
  }
}
