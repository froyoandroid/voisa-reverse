"use strict";
// Server -> browser message router.

// message handling
function handle(m) {
  // ignore anything tagged with a superseded session generation
  if (m.gen !== undefined && m.gen !== myGen) return;
  switch (m.kind) {
    case "log":
      logLine(m.text, classify(m.text));
      break;

    case "recording":
      rtc.recording = !!m.on;
      if (rtc.recording && rtc.pc) {
        const st = $("peerAudio").srcObject;
        if (st) rtcRecordStart(st);
      } else {
        rtcRecordStop();
      }
      setRecUI(!!m.on);
      break;

    case "webrtc":
      rtcHandle(m).catch((e) => logLine(e.message, "err"));
      break;

    case "mitm": {
      // one leg's event stream; `leg` says which relay it belongs to
      const leg = LEGS[m.leg] || (m.leg === "A" ? LEGS.A : LEGS.B);
      if (!leg) break;
      if (m.what === "call") legOnCall(leg, m);
      else if (m.what === "signal") legSignal(leg, m.payload || {}).catch((e) =>
        logLine(`Leg ${leg.key}: ${e.message}`, "err"));
      else if (m.what === "ice") {
        // this leg's own STUN/TURN servers, used by its next pc
        if (Array.isArray(m.iceServers)) leg.iceServers = m.iceServers;
      }
      else if (m.what === "identity") {
        // the first push can arrive before fetch-initial-data, carrying a null
        // name — never let it wipe a name we already learned
        if (m.username) leg.username = m.username;
        if (m.deviceId) leg.deviceId = m.deviceId;
        legInfo(leg);
        poolRefresh();
      } else if (m.what === "log") logLine(`Leg ${leg.key}: ${m.text}`, "sys");
      break;
    }

    case "status":
      setConn(m.state === "connected" ? "on" : "off",
        m.state === "connected" ? "Connected"
        : m.state === "connecting" ? "Connecting…"
        : m.state === "offline" ? "Offline" : m.state);
      break;

    case "account":
      acct.deviceId = m.deviceId;
      acct.cookie = m.cookie;
      acct.username = null;
      // persist this session's identity so a reload reuses it instead of
      // minting a new one (or grabbing a shared global account)
      if (m.cookie) saveIdentity({ deviceId: m.deviceId, cookie: m.cookie, since: m.since });
      renderAcct();
      logLine("Identity ready.", "sys");
      break;

    case "session": {
      // ICE servers come from the service; the browser needs them to negotiate.
      if (Array.isArray(m.iceServers)) rtc.iceServers = m.iceServers;
      const u = m.user || {};
      if (u.deviceId) acct.deviceId = u.deviceId;
      if (u.cookie) acct.cookie = u.cookie;
      if (u.username) acct.username = u.username;
      acct.premium = !!u.premium;
      acct.avatar = u.avatar || null;
      renderAcct();
      // only log when the identity actually changes — fetch-initial-data can
      // arrive repeatedly and used to stack a row per message
      if (u.username && u.username !== lastUsername) {
        lastUsername = u.username;
        autoSaveIdentity();
      }
      // The server tells us which search languages exist; build the dropdown
      // from its list so it can never drift from what the API accepts.
      const langs = m.searchLanguages;
      // build the option list from the server's payload for EVERY selector,
      // including the two relay ones — otherwise they keep a hardcoded list that
      // can drift from what the API actually accepts
      if (langs && Object.keys(langs).length) {
        for (const sel of document.querySelectorAll('select[data-role="lang"], #lang')) {
          const keep = sel.value;
          sel.innerHTML = Object.entries(langs)
            .map(([k, v]) => `<option value="${escapeHtml(k)}">${escapeHtml(String(v))}</option>`)
            .join("");
          if (keep && langs[keep]) sel.value = keep;
        }
      }
      break;
    }

    case "event":
      onEvent(m.event, m.payload);
      break;

    case "sent":
      logLine(`→ ${m.event} ${JSON.stringify(redact(m.payload || {}))}`, "out");
      break;

    case "call":
      if (m.phase === "level") { WAVE.push(m.peak || 0, m.samples || 0); break; }
      if (m.phase === "negotiate") {
        // server says whether we offer; the browser builds the SDP
        if (m.offer) rtcOffer().catch((e) => logLine(`rtc offer: ${e.message}`, "err"));
        else logLine("rtc: waiting for peer offer", "sys");
        break;
      }
      if (m.phase === "idle" || m.phase === "closed") setTimeout(loadRecs, 800);
      onCall(m);
      break;
  }
}

function classify(t) {
  if (/error|err:|failed/.test(t)) return "err";
  if (/\[media\]/.test(t)) return "med";
  if (/\[start-dialog\]|matchId=|peer=/.test(t)) return "match";
  if (/->/.test(t)) return "out";
  return "sys";
}
