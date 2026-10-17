"use strict";
// Voisa local client — frontend. Talks to the Python backend over one WebSocket.

const $ = (id) => document.getElementById(id);
const logEl = $("log");

const SERVER_EVENTS = [
  "start-search", "stop-search", "sync-call-state", "start-dialog",
  "close-dialog", "webrtc", "set-search-language", "shuffle-username", "update-avatar",
];

let ws = null;
let currentMatchId = null;
// This browser's Voisa identity. Each session holds its OWN, persisted here,
// so several tabs/relays never share (and fight over) one account, and so a
// reload keeps the same identity instead of grabbing a shared global one.
//
// This is the fix for "identity exists globally": the server no longer hands
// back a shared voisa_account.json default — the browser remembers its own
// identity and supplies it on every connect.
const ID_KEY = "voisa:identity";

function loadIdentity() {
  try {
    const j = JSON.parse(localStorage.getItem(ID_KEY) || "null");
    return j && j.cookie ? j : null;
  } catch (_) { return null; }
}

function saveIdentity(id) {
  tabIdentity = id && id.cookie ? { deviceId: id.deviceId || "", cookie: id.cookie } : null;
  tabCookie = tabIdentity ? tabIdentity.cookie : null;
  try {
    if (tabIdentity) localStorage.setItem(ID_KEY, JSON.stringify(tabIdentity));
    else localStorage.removeItem(ID_KEY);
  } catch (_) {}
}

let tabIdentity = loadIdentity();
let tabCookie = tabIdentity ? tabIdentity.cookie : null;
// short label shown in the header, so two open tabs are told apart at a glance
let tabLabel = "";
let myGen = 0;          // bumped on every (re)connect; stale messages are dropped

// account panel
// One place builds this HTML. Every handler writes into `acct` and calls
// renderAcct(), so the panel can never accumulate duplicate rows.
const acct = { deviceId: null, cookie: null, username: null, premium: false };
let lastUsername = null;

function renderAcct() {
  // deviceId and the session cookie are deliberately NOT rendered: the cookie
  // is a bearer credential (whoever reads it owns the account) and this page is
  // reachable over the network. Only the display name lands in the header.
  const head = $("acctHead");
  if (head) head.textContent = acct.username ? `Signed in as ${acct.username}` : "";
  const el = $("acct");
  if (!el) return;
  const row = (k, v) => v == null ? "" :
    `<span>${k}</span><b>${escapeHtml(String(v))}</b>`;
  el.innerHTML =
    row("username", acct.username) +
    (acct.username ? `<span>premium</span><b>${acct.premium ? "yes" : "no"}</b>` : "");
}

// live incoming-audio waveform
// Fed from the server's `call` messages with phase:"level" (one per ~50ms).
// If the line stays flat you are receiving no audio, whatever the logs say.
const WAVE = (() => {
  const HIST = 180;                 // ~9s of history at 20 msg/s
  const levels = new Array(HIST).fill(0);
  let peak = 0, peakHold = 0, peakAt = 0, lastMsg = 0, drawn = 0, got = 0;

  const cv = () => document.getElementById("wave");
  const ctx = () => cv().getContext("2d");

  function fit() {
    const c = cv();
    if (!c) return 0;
    const w = c.clientWidth || 380;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(80 * dpr);
    }
    return dpr;
  }

  let stEl = null;
  function els() {
    if (!stEl) stEl = document.getElementById("wavestate");
  }
  function push(level, samples) {
    got++;
    lastMsg = performance.now();
    levels.push(level); levels.shift();
    peak = level;
    if (level >= peakHold - 0.001) { peakHold = level; peakAt = lastMsg; }
    els();
    if (stEl) {
      stEl.textContent = level > 0.001 ? "Receiving audio" : "Silent";
      stEl.className = level > 0.001 ? "live" : "idle";
    }
  }
  function reset(label) {
    levels.fill(0); peak = 0; peakHold = 0; got = 0;
    els();
    if (stEl) { stEl.textContent = label || "No audio"; stEl.className = "idle"; }
  }

  function draw() {
    const c = cv(); if (!c) return;
    const dpr = fit();
    const g = ctx();
    const W = c.width, H = c.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    // grid: centre line + quarters
    g.strokeStyle = "rgba(255,255,255,.07)"; g.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(f => {
      g.beginPath(); g.moveTo(0, H * f); g.lineTo(W, H * f); g.stroke();
    });

    const barW = W / HIST;
    const mid = H / 2;
    levels.forEach((v, i) => {
      const h = Math.max(1, v * mid * 0.95);
      const x = i * barW;
      // fresh messages bright, stale history dimmed
      const age = (i / HIST);
      g.fillStyle = v > 0.001
        ? `rgba(255,255,68,${0.85 - age * 0.55})`
        : "rgba(120,130,140,.25)";
      g.fillRect(x, mid - h, Math.max(1, barW - 1), h * 2);
    });

    // peak-hold line, decays after 1.2s
    if (peakAt && performance.now() - peakAt < 1200 && peakHold > 0.001) {
      g.strokeStyle = "rgba(255,255,68,.9)"; g.lineWidth = 1.5;
      const y = mid - peakHold * mid * 0.95;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.beginPath(); g.moveTo(0, H - y); g.lineTo(W, H - y); g.stroke();
    }

    // stale: no level message for 2s -> say so explicitly
    if (lastMsg && performance.now() - lastMsg > 2000) {
      els();
      if (stEl) { stEl.textContent = "No audio"; stEl.className = "dead"; }
    }
    requestAnimationFrame(draw);
  }

  reset();
  window.addEventListener("resize", fit);
  requestAnimationFrame(draw);
  return { push, reset };
})();

// logging
function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}
const LOG_KEY = "voisa.log.v1";
const LOG_MAX = 800;
let logHist = null;
let logSaveT = 0;
function logHistLoad() {
  if (logHist) return logHist;
  try { logHist = JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); }
  catch (_) { logHist = []; }
  return logHist;
}
function logHistSave() {
  const now = Date.now();
  if (now - logSaveT < 800) return;
  logSaveT = now;
  try { localStorage.setItem(LOG_KEY, JSON.stringify(logHist.slice(-LOG_MAX))); }
  catch (_) {}
}
function logLine(text, cls = "sys", persist = true) {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  // collapse reconnect storms: one line, not one per attempt
  const last = logEl.lastElementChild;
  if (last && last.dataset.logText === text) return last;
  const el = document.createElement("span");
  el.dataset.logText = text;
  el.className = "l " + cls;
  const t = stamp();
  el.innerHTML = `<span class="t">${t}</span>${escapeHtml(text)}`;
  logEl.appendChild(el);
  while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  if (!persist) return;
  logHistLoad().push({ t, text, cls });
  if (logHist.length > LOG_MAX) logHist.splice(0, logHist.length - LOG_MAX);
  logHistSave();
  try { if (ws && ws.readyState === 1) send({ cmd: "logline", text, level: cls }); }
  catch (_) {}
}

function restoreLog() {
  try {
    const hist = logHistLoad().filter(h =>
      h.text !== "Starting workspace…" &&
      h.text !== "Connection lost. Retrying…");
    if (!hist.length) return;
    hist.forEach(h => logLine(h.text, h.cls, false));
    logEl.scrollTop = logEl.scrollHeight;
  } catch (_) {}
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
$("btnClear").onclick = () => {
  logEl.innerHTML = "";
  logHist = [];
  try { localStorage.removeItem(LOG_KEY); } catch (e) {}
};

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

// socket
let wsFails = 0;

function connectWS() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  try { if (ws) ws.close(); } catch (_) {}
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    wsFails = 0;
    setConn("on", CallState.mode === "idle" ? "Ready" : "Connected");
    myGen++;
    // reconnect with THIS session's own remembered identity (if any); when
    // there is none the server mints a fresh one and we persist it below.
    send({ cmd: "connect", gen: myGen,
           deviceId: tabIdentity ? tabIdentity.deviceId : null,
           cookie: tabCookie || null });
  };
  ws.onclose = () => {
    setConn("off", "Connecting…");
    wsFails = (wsFails || 0) + 1;
    setConn("off", "Connecting…");
    setTimeout(connectWS, Math.min(2000 * wsFails, 15000));
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

// Socket state. The label is ALWAYS explicit: every caller says exactly
// what to show (Connecting, Connected, Offline) so a default can never
// overwrite a real state with a stale guess.
function setConn(state, label) {
  const on = state === "on";
  const hd = $("headDot");
  if (hd) hd.className = "dot " + (on ? "on" : "off");
  const hs = $("headState");
  if (hs && label != null) hs.textContent = label;
}

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
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
      if (m.cookie) saveIdentity({ deviceId: m.deviceId, cookie: m.cookie });
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

// Strip credentials before anything reaches the on-page log.
//
// fetch-initial-data carries the session cookie, the device id and the TURN
// username/credential in one payload. Dumping it raw printed the whole
// credential set on screen — and this page is served over the network.
function redact(o, inIce) {
  if (o == null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map((x) => redact(x, inIce));
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    // `username` is the visible display name in userData but a TURN secret in
    // iceServers, so it is only hidden inside an ICE server entry.
    const iceSecret = inIce && /^username$/i.test(k);
    if (iceSecret || /^(cookie|credential|token|secret|password|deviceid)$/i.test(k)) {
      out[k] = "‹redacted›";
    } else {
      // recurse into EVERY nested object/array, not just known keys. Only
      // handling a hard-coded "userData" left iceServers untouched, and that
      // array carries the TURN username + credential.
      const childIce = inIce || /^iceservers$/i.test(k);
      out[k] = (v && typeof v === "object") ? redact(v, childIce) : v;
    }
  }
  return out;
}

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
    send({ cmd: "accept", matchId: payload.matchId });
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

// who you are connected to
// Kept visible through the whole call so you can see the partner's name, not
// just a transient "connected" line. start-dialog gives us
// {initiate, matchId, username, premium, avatar{color,id,eyesId}}.
let peerInfo = null;

function showPeer(dialog, phase) {
  const el = $("peer");
  if (!el) return;
  const name = dialog && (dialog.username || dialog.peer);
  if (!name) { el.classList.add("hidden"); el.innerHTML = ""; return; }

  peerInfo = {
    name,
    matchId: dialog.matchId || peerInfo?.matchId || "",
    premium: !!dialog.premium,
    avatar: dialog.avatar || peerInfo?.avatar || null,
  };

  const color = (peerInfo.avatar && peerInfo.avatar.color) || "#ffff44";
  const initial = name.trim()[0] || "?";
  const tag = phase === "live"
    ? '<span class="tag live">In call</span>'
    : phase === "pending"
      ? '<span class="tag wait">Incoming</span>'
      : '<span class="tag done">Ended</span>';

  el.classList.remove("hidden");
  el.innerHTML = `
    <div class="face" style="background:${escapeHtml(color)}">${escapeHtml(initial)}</div>
    <div class="who">
      <div class="nm">${escapeHtml(name)}${peerInfo.premium ? ' <span class="star">⭐</span>' : ""}</div>
      <div class="sub">${escapeHtml(peerInfo.matchId || "")}</div>
    </div>
    ${tag}`;
}

function clearPeer() {
  peerInfo = null;
  const el = $("peer");
  if (el) { el.classList.add("hidden"); el.innerHTML = ""; }
  // no peer now, so the status line becomes visible again
  const st = $("match");
  if (st) st.classList.remove("hidden");
}

// Single status line. It only ever shows CALL STATE (searching / no match /
// waiting) — the partner's identity lives in the peer card above, so the two
// never repeat each other. When a peer is known, this line stays quiet and is
// hidden entirely.
function showMatch(dialog, state, label) {
  const el = $("match");
  if (!el) return;
  const hasPeer = !!(peerInfo && peerInfo.name);
  if (state === "empty") {
    el.className = "match empty";
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  if (state === "searching") {
    el.className = "match searching";
    el.textContent = label || "Searching…";
    el.classList.remove("hidden");
    return;
  }
  // active: the peer card already shows who + matchId, so hide this line
  if (hasPeer) { el.classList.add("hidden"); el.textContent = ""; return; }
  el.className = "match " + state;
  el.classList.remove("hidden");
  el.textContent = dialog && (dialog.username || dialog.peer) || "In call";
}

// controls
$("btnConnect").onclick = () => {
  const id = $("deviceId").value.trim();
  myGen++;
  // send THIS tab's cookie so concurrent tabs keep separate identities
  send({ cmd: "connect", deviceId: id || null, cookie: tabCookie || null, gen: myGen });
};
$("btnNew").onclick = async () => {
  try {
    const r = await fetch("/api/new", { method: "POST" });
    const j = await r.json();
    $("deviceId").value = j.deviceId;
    acct.deviceId = j.deviceId;
    acct.cookie = j.cookie;
    acct.username = null;
    acct.premium = false;
    saveIdentity({ deviceId: j.deviceId, cookie: j.cookie });
    renderAcct();
    logLine(`New identity: ${j.deviceId}`, "match");
    myGen++;
    send({ cmd: "connect", deviceId: j.deviceId, cookie: j.cookie, gen: myGen });
    setConn("off", "Connecting…");
  } catch (e) {
    logLine(`Could not create identity: ${e.message}`, "err");
  }
};

// saved identities: switch back to one you used before
async function renderSaved() {
  const box = $("savedList");
  if (!box) return;
  try {
    const j = await (await fetch("/api/saved")).json();
    if (!j.entries.length) { box.innerHTML = '<div class="empty">No saved identities.</div>'; return; }
    box.innerHTML = j.entries.map((e) => {
      const sub = e.username ? `${e.username} · used ${e.uses} time${e.uses === 1 ? "" : "s"}` : `used ${e.uses} time${e.uses === 1 ? "" : "s"}`;
      return `<div class="savedrow">
        <span class="who"><span class="sid">${escapeHtml(e.deviceId)}</span><span class="sub">${escapeHtml(sub)}</span></span>
        <button class="mini" data-use="${escapeHtml(e.deviceId)}">Use</button>
        <button class="mini" data-delid="${escapeHtml(e.deviceId)}">Remove</button>
      </div>`;
    }).join("");
    box.querySelectorAll("[data-use]").forEach((b) => {
      b.onclick = async () => {
        try {
          const j = await (await fetch("/api/saved/use", { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ deviceId: b.dataset.use }) })).json();
          saveIdentity({ deviceId: j.deviceId, cookie: j.cookie });
          acct.deviceId = j.deviceId; acct.cookie = j.cookie; acct.username = j.username || null;
          acct.premium = false;
          $("deviceId").value = j.deviceId;
          renderAcct();
          myGen++;
          send({ cmd: "connect", deviceId: j.deviceId, cookie: j.cookie, gen: myGen });
          setConn("off", "Connecting…");
        } catch (e) { logLine(`Could not switch: ${e.message}`, "err"); }
      };
    });
    box.querySelectorAll("[data-delid]").forEach((b) => {
      b.onclick = async () => {
        try {
          await fetch(`/api/saved/${encodeURIComponent(b.dataset.delid)}`, { method: "DELETE" });
          logLine(`Removed ${b.dataset.delid}.`, "sys");
        } catch (e) { logLine(`Could not remove: ${e.message}`, "err"); }
        renderSaved();
      };
    });
  } catch (_) { box.innerHTML = '<div class="empty">Unavailable.</div>'; }
}
$("btnIdSave").onclick = async () => {
  if (!acct.deviceId || !acct.cookie) return logLine("No identity to save yet.", "warn");
  try {
    await fetch("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: acct.deviceId, cookie: acct.cookie, username: acct.username }) });
    logLine(`Saved ${acct.deviceId}.`, "match");
  } catch (e) { logLine(`Could not save: ${e.message}`, "err"); }
  renderSaved();
};

$("btnLogin").onclick = async () => {
  const id = $("deviceId").value.trim();
  if (!id) return logLine("Enter a device ID first.", "err");
  try {
    const r = await fetch("/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: id }),
    });
    const j = await r.json();
    if (!j || !j.cookie) return logLine("Could not use that ID.", "err");
    saveIdentity({ deviceId: j.deviceId, cookie: j.cookie });
    logLine("Identity ready.", "sys");
    myGen++;
    send({ cmd: "connect", deviceId: j.deviceId, cookie: j.cookie, gen: myGen });
  } catch (e) {
    logLine(`Could not connect: ${e.message}`, "err");
  }
};
$("btnSearch").onclick = () => {
  if (CallState.busy) return;
  if (CallState.mode === "idle" || CallState.mode === "searching") {
    if (CallState.mode === "searching") { stopSearch(); callEnd("stopcall"); }
    else { searchN = 0; startSearch(); }
  }
  else callEnd("stopcall");
};
// First press keeps hunting until a partner connects. Any idle/closed
// with no match re-fires automatically; only an explicit stop (or a real
// call ending) goes idle. Toggle searchAuto=false to restore one-shot.
let searchAuto = true;
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
// recordings
function safeLoad(fn) {
  try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) {}
}
async function loadRecs() {
  // hoisted so the catch can reach them — declaring these inside the try made
  // the catch throw a ReferenceError (box/info undefined) on any fetch failure
  const box = $("recs");
  const info = $("recInfo");
  try {
    const r = await fetch("/api/recordings");
    const j = await r.json();
    if (info) {
      info.textContent = j.files.length
        ? `${j.files.length} file(s), ${(j.total_bytes / 1048576).toFixed(1)} MB`
        : "Nothing yet. Record during a call.";
    }
    if (!j.files.length) {
      box.innerHTML = '<div class="empty">No recordings yet.</div>';
      return;
    }
    box.innerHTML = j.files.map(f => `
      <div class="rec">
        <span class="nm">${escapeHtml(f.name.replace(/^incoming-/, ""))}</span>
        <span class="sz">${(f.bytes / 1024).toFixed(0)}K</span>
        ${f.kind === "audio"
          ? `<audio controls preload="none" src="/api/recordings/${encodeURIComponent(f.name)}"></audio>`
          : `<a href="/api/recordings/${encodeURIComponent(f.name)}" download>download</a>`}
        <button data-del="${escapeHtml(f.name)}">Remove</button>
      </div>`).join("");
    box.querySelectorAll("button[data-del]").forEach(b => {
      b.onclick = async () => {
        await fetch("/api/recordings/" + encodeURIComponent(b.dataset.del), { method: "DELETE" });
        loadRecs();
      };
    });
  } catch (e) {
    if (info) info.textContent = "Unavailable.";
    if (box) box.innerHTML = '<div class="empty">Unavailable.</div>';
  }
}
$("btnRecRefresh").onclick = loadRecs;
$("btnRecClear").onclick = async () => {
  try {
    const r = await fetch("/api/recordings", { method: "DELETE" });
    const j = await r.json();
    logLine(`Removed ${j.deleted} recordings.`, "sys");
    loadRecs();
  } catch (e) {
    logLine(`Could not clear: ${e.message}`, "err");
  }
};

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
// Mute flips track.enabled only; the sender stays so no renegotiation needed.
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
  await micAttachRenegotiate();
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

$("btnShuffle").onclick = () => {
  send({ cmd: "shuffle" });
  logLine("Requesting a new name…", "sys");
};
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

// populate raw-emit event list
const evtSel = $("evt");
SERVER_EVENTS.forEach((e) => {
  const o = document.createElement("option");
  o.value = o.textContent = e;
  evtSel.appendChild(o);
});

// boot
restoreLog();
connectWS();
setConn("off", "Connecting…");
safeLoad(loadRecs);
safeLoad(renderSaved);

// browser WebRTC peer
// The browser — not the server — terminates the call. Audio decodes straight to
// the local <audio> element, so there is no PCM relay, no resampler, and no
// host sound card: pitch is correct because nothing re-times the samples.
const rtc = {
  pc: null,
  matchId: null,
  rec: null,          // MediaRecorder
  chunks: [],
  micStream: null,
  micTrack: null,
  micState: "off",    // off | live | muted
  micDenied: false,
  pendingCandidates: [],
  waveCtx: null,
  waveSrc: null,
  waveAn: null,
  waveRaf: 0,
};

function rtcAttachAudio(stream) {
  const el = $("peerAudio");
  if (!el || !stream) return;
  el.srcObject = stream;
  const p = el.play();
  if (p && p.catch) p.catch((e) => logLine(`audio play blocked: ${e.message}`, "err"));
  logLine("rtc: partner audio -> playing on THIS device", "sys");
  waveStart(stream);
  if (rtc.recording) rtcRecordStart(stream);
}
// Local meter: the server never sends phase:"level" in browser-peer mode, so
// the wavebox reads the peer stream directly. No signalling change.
function waveStart(stream) {
  waveStop();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream.getAudioTracks().length) return;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    rtc.waveCtx = ctx; rtc.waveSrc = src; rtc.waveAn = an;
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (!rtc.waveAn) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      WAVE.push(Math.min(1, Math.sqrt(sum / buf.length) * 3), buf.length);
      rtc.waveRaf = requestAnimationFrame(tick);
    };
    WAVE.reset("Receiving audio");
    tick();
  } catch (_) {}
}
function waveStop() {
  if (rtc.waveRaf) cancelAnimationFrame(rtc.waveRaf);
  rtc.waveRaf = 0; rtc.waveAn = null; rtc.waveSrc = null;
  if (rtc.waveCtx) { try { rtc.waveCtx.close(); } catch (_) {} rtc.waveCtx = null; }
}

function rtcSend(obj) {
  if (ws && ws.readyState === 1) send(Object.assign({ cmd: "webrtc" }, obj));
}
// Mic capture with standard VoIP processing. Single track only.
async function micEnsure() {
  const live = rtc.micStream?.getAudioTracks()?.find((t) => t.readyState === "live");
  if (live) { rtc.micTrack = live; rtc.micDenied = false; return rtc.micStream; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    const tracks = stream.getAudioTracks();
    for (let i = 1; i < tracks.length; i++) tracks[i].stop();
    rtc.micStream = stream;
    rtc.micTrack = tracks[0] || null;
    if (rtc.micTrack) rtc.micTrack.enabled = true;
    rtc.micDenied = false;
    micPaint();
    return stream;
  } catch (e) {
    rtc.micStream = null; rtc.micTrack = null; rtc.micDenied = true; rtc.micState = "off";
    micPaint();
    logLine(`Mic blocked: ${e && e.name || e}`, "err");
    throw e;
  }
}
function micCleanup() {
  try { rtc.micStream?.getTracks()?.forEach((t) => t.stop()); } catch (_) {}
  rtc.micStream = null; rtc.micTrack = null; rtc.micState = "off";
  micPaint();
}
// Publish the mic mid-call via renegotiation. Keeps the working recvonly join
// path untouched; adds a send m-line only when the user taps Talk.
async function micAttachRenegotiate() {
  if (!rtc.pc || !rtc.micTrack || CallState.mode !== "active") return;
  if (rtc.pc.getSenders().find((s) => s.track === rtc.micTrack)) return;
  rtc.pc.addTrack(rtc.micTrack, rtc.micStream);
  const offer = await rtc.pc.createOffer();
  await rtc.pc.setLocalDescription(offer);
  await rtcGatherComplete(rtc.pc);
  rtcSend({ offer: { type: "offer", sdp: rtc.pc.localDescription.sdp } });
  logLine("mic: track published, renegotiated", "sys");
}

async function rtcStart(matchId) {
  await rtcStop();
  rtc.matchId = matchId;
  const pc = new RTCPeerConnection({ iceServers: rtc.iceServers || [] });
  rtc.pc = pc;

  // Receive-only: we want the partner's audio. We publish no mic by default,
  // so no permission prompt appears.
  //
  // BOTH audio and video m-lines are required. The server-side path added the
  // same pair; with audio alone the peer completes ICE and DTLS but then tears
  // the call down because its video leg has nowhere to go.
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    // only audio plays; video arrives so the dialog stays alive
    if (ev.track.kind !== "audio") {
      ev.track.enabled = false;
      return;
    }
    rtcAttachAudio(ev.streams[0]);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      rtcSend({ iceCandidate: {
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      } });
    }
  };

  pc.onconnectionstatechange = () =>
    logLine(`rtc: ${pc.connectionState}`, pc.connectionState === "connected" ? "sys" : "warn");
  pc.oniceconnectionstatechange = () =>
    logLine(`rtc ice: ${pc.iceConnectionState}`, "sys");

  return pc;
}

// The server tells us who offers. If it is us, create the offer.
// Wait for ICE gathering to finish, then return the SDP with every candidate
// inlined. The server-side path did the same (non-trickle). Sending an SDP with
// no candidates and relying on trickle made some peers complete ICE and then
// drop the call, because their video leg never got a usable candidate pair.
function rtcGatherComplete(pc, ms = 4000) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); resolve(); }, ms);
  });
}

async function rtcOffer() {
  const pc = rtc.pc || (await rtcStart(currentMatchId));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await rtcGatherComplete(pc);
  const sdp = pc.localDescription.sdp;
  const n = sdp.split("\n").filter((l) => l.startsWith("a=candidate")).length;
  rtcSend({ offer: { type: "offer", sdp } });
  logLine(`rtc: offer -> server (${n} candidate(s))`, "sys");
}

// Handle a `webrtc` message relayed from the peer.
async function rtcHandle(m) {
  const p = m.payload || {};
  if (p.matchId && !rtc.matchId) await rtcStart(p.matchId);

  if (p.offer) {
    const pc = rtc.pc || (await rtcStart(p.matchId));
    await pc.setRemoteDescription({ type: "offer", sdp: p.offer.sdp });
    await rtcFlushCandidates();
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await rtcGatherComplete(pc);
    const asdp = pc.localDescription.sdp;
    const an = asdp.split("\n").filter((l) => l.startsWith("a=candidate")).length;
    rtcSend({ answer: { type: "answer", sdp: asdp } });
    logLine(`rtc: answer -> server (${an} candidate(s))`, "sys");
  } else if (p.answer) {
    if (rtc.pc && rtc.pc.signalingState !== "stable") {
      await rtc.pc.setRemoteDescription({ type: "answer", sdp: p.answer.sdp });
      await rtcFlushCandidates();
      logLine("rtc: remote answer applied", "sys");
    }
  } else if (p.iceCandidate) {
    // Candidates can arrive BEFORE the offer/answer is applied (trickle ICE).
    // addIceCandidate then throws "remote description was null" and the
    // candidate is lost, which stalls ICE on a slow or TURN-only path. Queue
    // them and drain once a remote description exists.
    const cand = {
      candidate: p.iceCandidate.candidate,
      sdpMid: p.iceCandidate.sdpMid,
      sdpMLineIndex: p.iceCandidate.sdpMLineIndex,
    };
    if (!rtc.pc || !rtc.pc.remoteDescription) {
      rtc.pendingCandidates.push(cand);
      return;
    }
    await rtcAddCandidate(cand);
  }
}

async function rtcAddCandidate(cand) {
  try {
    await rtc.pc.addIceCandidate(cand);
  } catch (e) {
    logLine(`rtc addIceCandidate: ${e.message}`, "warn");
  }
}

async function rtcFlushCandidates() {
  const q = rtc.pendingCandidates.splice(0);
  if (q.length) logLine(`rtc: applying ${q.length} queued candidate(s)`, "sys");
  for (const c of q) await rtcAddCandidate(c);
}

// recording (browser-side, replaces the server recorder)
function rtcRecordStart(stream) {
  try {
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus" : "";
    rtc.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    rtc.chunks = [];
    rtc.rec.ondataavailable = (e) => { if (e.data.size) rtc.chunks.push(e.data); };
    rtc.rec.onstop = () => {
      const blob = new Blob(rtc.chunks, { type: rtc.rec.mimeType || "audio/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `voisa-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      logLine(`recording saved (${(blob.size / 1024).toFixed(1)} KB)`, "sys");
    };
    rtc.rec.start(1000);
    logLine("recording started (browser)", "sys");
  } catch (e) {
    logLine(`record failed: ${e.message}`, "err");
  }
}

function rtcRecordStop() {
  try { if (rtc.rec && rtc.rec.state !== "inactive") rtc.rec.stop(); } catch (_) {}
  rtc.rec = null;
}

async function rtcStop() {
  micCleanup();
  waveStop();
  WAVE.reset();
  rtcRecordStop();
  rtc.pendingCandidates = [];
  if (rtc.pc) {
    try { rtc.pc.close(); } catch (_) {}
    rtc.pc = null;
  }
  const el = $("peerAudio");
  if (el) el.srcObject = null;
  rtc.matchId = null;
}

// views (sidebar)
// Only the layout switches. Both views share one /ws socket and one session, so
// the client view keeps working while the MITM view is open.
function showView(name) {
  const views = { client: document.querySelector("main"), mitm: $("view-mitm"), logs: $("view-logs"), settings: $("view-settings") };
  if (!views.client || !views.mitm || !views.logs || !views.settings) return;
  for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
  document.querySelectorAll(".nav[data-view]").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === name));
}
document.querySelectorAll(".nav[data-view]").forEach((b) => {
  b.onclick = () => {
    showView(b.dataset.view);
    if (b.dataset.view === "mitm") { poolRefresh(); recListRefresh(); }
    const tt = $("topbarTitle");
    if (tt) tt.textContent = b.dataset.label || b.textContent.trim();
    if (SB.phone()) SB.close();          // a pick on the phone drawer closes it
  };
});

// collapsible sidebar
// Desktop/tablet: docked, collapsible to an icon rail; the choice is remembered.
// Phone (<=720px): an off-canvas drawer, collapsed by default every time.
// Crossing the breakpoint re-applies the right default, so it stays dynamic
// on rotate / window resize.
const SB = (() => {
  const KEY = "voisa:sidebar";           // "collapsed" | "expanded" (desktop only)
  const mq = window.matchMedia("(max-width: 720px)");
  const tablet = window.matchMedia("(max-width: 1040px)");
  const body = document.body;
  const phone = () => mq.matches;

  // label every nav item so the rail can show a tooltip
  document.querySelectorAll(".nav[data-view]").forEach((b) => {
    if (!b.dataset.label) b.dataset.label = b.textContent.trim();
  });

  function paint() {
    const collapsed = body.classList.contains("sb-collapsed");
    const open = body.classList.contains("sb-open");
    const t = $("sbToggle"), o = $("sbOpen");
    if (t) {
      const expanded = phone() ? open : !collapsed;
      t.setAttribute("aria-expanded", String(expanded));
      t.setAttribute("aria-label", phone() ? "Close menu" : collapsed ? "Expand sidebar" : "Collapse sidebar");
    }
    if (o) o.setAttribute("aria-expanded", String(open));
  }
  function pref() {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }
  function apply() {
    body.classList.remove("sb-open");
    if (phone()) body.classList.add("sb-collapsed");           // drawer starts closed
    else {
      const p = pref();
      // no saved choice: expanded on desktop, rail on tablet widths
      const collapsed = p ? p === "collapsed" : tablet.matches;
      body.classList.toggle("sb-collapsed", collapsed);
    }
    paint();
  }
  function toggle() {
    if (phone()) { body.classList.contains("sb-open") ? close() : open(); return; }
    const c = body.classList.toggle("sb-collapsed");
    try { localStorage.setItem(KEY, c ? "collapsed" : "expanded"); } catch (_) {}
    paint();
  }
  function open()  { body.classList.add("sb-open"); paint(); }
  function close() { body.classList.remove("sb-open"); paint(); }

  $("sbToggle") && ($("sbToggle").onclick = toggle);
  $("sbOpen") && ($("sbOpen").onclick = open);
  $("sbScrim") && ($("sbScrim").onclick = close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && phone()) close(); });
  // swipe left on the open drawer to close it
  let x0 = null;
  const sb = $("sidebar");
  if (sb) {
    sb.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    sb.addEventListener("touchend", (e) => {
      if (x0 != null && phone() && e.changedTouches[0].clientX - x0 < -50) close();
      x0 = null;
    }, { passive: true });
  }
  (mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply));
  (tablet.addEventListener ? tablet.addEventListener("change", apply) : tablet.addListener(apply));
  apply();
  return { phone, open, close, toggle };
})();
showView("client");
callPaint();

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
    rec: null, recChunks: [],
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
  start.disabled = false;           // always pressable: re-press = restart
  stop.disabled = mitmLegsIdle();   // only means something while running
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
    row(who, leg.peer || "—") +
    row("Match", leg.matchId ? leg.matchId.slice(0, 8) : "—");
}

// Ask the server for a FRESH account for this leg and adopt it.
async function legArm(leg) {
  const j = await (await fetch("/api/new", { method: "POST" })).json();
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
    if (!leg.cookie) await legArm(leg);
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

// Server tells us a leg's state moved.
function legOnCall(leg, m) {
  const phase = m.phase;
  if (m.matchId) leg.matchId = m.matchId;
  if (m.peer) leg.peer = m.peer;
  if (phase === "negotiate") {
    if (m.offer) legOffer(leg).catch((e) => logLine(`Leg ${leg.key}: ${e.message}`, "err"));
  } else if (phase === "connected") {
    legState(leg, "connected", "In call");
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
  } else if (phase === "idle") {
    // an explicit stop: full teardown
    legState(leg, "idle", "Stopped");
    legTeardown(leg);
  }
  legInfo(leg);
}

async function legEnsurePc(leg) {
  if (leg.pc) return leg.pc;
  const pc = new RTCPeerConnection({ iceServers: rtc.iceServers || [] });
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
    const other = leg.key === "A" ? LEGS.B : LEGS.A;
    legRouteIncoming(other, stream);
    logLine(`[mitm] leg ${leg.key}: peer audio -> local + onto leg ${other.key}'s outbound`, "med");
    legState(leg, "connected", "bridged");
    bridgeRewire();
    if (leg.recording) legRecordStart(leg, stream);
  };
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
  await legStart(LEGS.A, legLang(LEGS.A), 0);
  await legStart(LEGS.B, legLang(LEGS.B), 0);
  if (h) h.textContent = restart ? "Restarted — searching fresh" : "Searching — both peers appear below";
  mitmSyncToggle();
});
$("btnMitmStop")?.addEventListener("click", () => {
  if (mitmLegsIdle()) return;
  legStop(LEGS.A); legStop(LEGS.B);
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

// per-leg recording: each leg captured separately, so the two sides stay
// distinguishable without unmixing
// The bytes go to the SERVER, not to a download.
//
// A browser-side download produced a broken file: MediaRecorder only writes a
// valid container header on stop, so a reload or a torn-down leg left chunks
// that were never assembled and the .webm would not open. Uploading each chunk
// as it is produced means the server always holds everything received so far,
// and the file is fetched deliberately from the recordings list.
function legRecMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// browser storage (OPFS)
// Recordings live in the browser's Origin Private File System, not on the
// server. Each 1s chunk is appended at an explicit offset with its own
// writable + close, so every chunk is flushed to disk as it lands: a reload
// mid-recording leaves a playable file (header in the first chunk, clusters
// appended in order), which is what the old server-side session file bought.
async function recRoot() {
  return navigator.storage.getDirectory();
}
function recStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
async function recWriteChunk(handle, offset, blob) {
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: "write", position: offset, data: blob });
  await w.close();
}

function legRecordStart(leg, stream) {
  try {
    if (!stream || !stream.getAudioTracks().length) {
      logLine(`[mitm] leg ${leg.key}: nothing to record yet`, "warn");
      return;
    }
    const mime = legRecMime();
    leg.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const name = `relay-${leg.key}-${recStamp()}.webm`;

    leg.rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      // serialise writes: a slow flush must never interleave with the next chunk
      leg.recChain = (leg.recChain || Promise.resolve()).then(async () => {
        try {
          if (!leg.recHandle) {
            const root = await recRoot();
            leg.recHandle = await root.getFileHandle(name, { create: true });
            leg.recOffset = 0;
          }
          await recWriteChunk(leg.recHandle, leg.recOffset, e.data);
          leg.recOffset += e.data.size;
        } catch (err) {
          logLine(`[mitm] leg ${leg.key} chunk write failed: ${err.message}`, "err");
        }
      });
    };
    leg.rec.onstop = async () => {
      try {
        await (leg.recChain || Promise.resolve());
        const f = leg.recHandle ? await leg.recHandle.getFile() : null;
        if (f && f.size) logLine(`[mitm] leg ${leg.key} recording saved: ${name} (${(f.size / 1024).toFixed(0)} KB, in browser)`, "match");
        else logLine(`[mitm] leg ${leg.key}: nothing recorded`, "warn");
      } catch (e) {
        logLine(`[mitm] leg ${leg.key} stop failed: ${e.message}`, "err");
      }
      leg.recHandle = null; leg.recOffset = 0; leg.recChain = null;
      recListRefresh();
    };
    // 1s slices: frequent enough that a crash loses at most a second
    leg.rec.start(1000);
    leg.recording = true;
    logLine(`[mitm] leg ${leg.key}: recording to browser storage`, "sys");
  } catch (e) {
    logLine(`[mitm] leg ${leg.key} record failed: ${e.message}`, "err");
  }
}

function legRecordStop(leg) {
  leg.recording = false;
  try { if (leg.rec && leg.rec.state !== "inactive") leg.rec.stop(); } catch (_) {}
  leg.rec = null;
}

// recordings list from browser storage: one row per file, blob URLs for
// play/download straight out of OPFS — the server never sees these bytes
let recUrls = [];
async function recListRefresh() {
  const box = $("recList");
  if (!box) return;
  recUrls.forEach((u) => URL.revokeObjectURL(u));
  recUrls = [];
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      box.innerHTML = '<div class="empty">Browser storage not supported here.</div>';
      return;
    }
    const root = await recRoot();
    const files = [];
    for await (const name of await root.keys()) {
      if (!/^relay-[AB]-.+\.webm$/.test(name)) continue;
      const fh = await root.getFileHandle(name);
      const f = await fh.getFile();
      files.push({ name, f, url: URL.createObjectURL(f) });
      recUrls.push(files[files.length - 1].url);
    }
    files.sort((x, y) => y.f.lastModified - x.f.lastModified);
    if (!files.length) {
      box.innerHTML = '<div class="empty">No recordings yet.</div>';
      return;
    }
    box.innerHTML = files.map(({ name, f, url }) => {
      const m = name.match(/^relay-([AB])-(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.webm$/);
      const leg = m ? m[1] : "?";
      const when = m ? `${m[2]} ${m[3].replace(/-/g, ":")}` : name;
      const kb = (f.size / 1024).toFixed(0);
      return `<div class="recrow">
        <span class="legtag">${escapeHtml(leg)}</span>
        <span class="fname">${escapeHtml(when)}</span>
        <span class="meta">${kb} KB</span>
        <button class="mini play" data-play="${escapeHtml(name)}">Play</button>
        <a class="mini" href="${url}" download="${escapeHtml(name)}">Download</a>
        <button class="mini" data-del="${escapeHtml(name)}">Remove</button>
      </div>
      <div class="recplayer" data-player="${escapeHtml(name)}" hidden>
        <audio controls preload="none" src="${url}"></audio>
      </div>`;
    }).join("");

    // one player at a time: opening another pauses and closes the previous, so
    // two recordings can never play over each other
    box.querySelectorAll("[data-play]").forEach((btn) => {
      btn.onclick = () => {
        const name = btn.dataset.play;
        const mine = box.querySelector(`[data-player="${CSS.escape(name)}"]`);
        const open = !mine.hidden;
        box.querySelectorAll(".recplayer").forEach((pl) => {
          pl.hidden = true;
          const a = pl.querySelector("audio");
          if (a) { a.pause(); a.currentTime = 0; }
        });
        if (!open) {
          mine.hidden = false;
          const a = mine.querySelector("audio");
          if (a) {
            a.play().catch((e) => logLine(`Could not play: ${e.message}`, "warn"));
            a.onerror = () => logLine(`Could not play ${name}.`, "err");
          }
        }
      };
    });

    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = () => { safeLoad(async () => {
        const root2 = await recRoot();
        await root2.removeEntry(btn.dataset.del);
        logLine(`Removed ${btn.dataset.del}.`, "sys");
        recListRefresh();
      }); };
    });
  } catch (e) {
    box.innerHTML = '<div class="empty">No recordings yet.</div>';
  }
}
$("btnRecRefreshMitm")?.addEventListener("click", recListRefresh);

// bridge + record controls
// The bridge can be muted live: gain -> 0 means each leg hears silence from the
// other, so you can cut the two strangers apart without dropping either call.
let bridgeOn = true;

$("btnMitmBridge")?.addEventListener("click", () => {
  bridgeOn = !bridgeOn;
  const btn = $("btnMitmBridge");
  btn.textContent = `Bridge: ${bridgeOn ? "On" : "Muted"}`;
  btn.classList.toggle("on", bridgeOn);
  for (const leg of [LEGS.A, LEGS.B]) {
    if (leg.gain) leg.gain.gain.value = bridgeOn ? 1.0 : 0.0;
  }
  logLine(bridgeOn ? "Bridge on." : "Bridge muted.", bridgeOn ? "match" : "warn");
});

$("btnMitmRec")?.addEventListener("click", () => {
  const anyRec = LEGS.A.recording || LEGS.B.recording;
  const btn = $("btnMitmRec");
  if (anyRec) {
    legRecordStop(LEGS.A); legRecordStop(LEGS.B);
    btn.textContent = "Record both";
    logLine("Recording stopped.", "sys");
    return;
  }
  let started = 0;
  for (const leg of [LEGS.A, LEGS.B]) {
    if (leg.peerStream) { legRecordStart(leg, leg.peerStream); started++; }
    else leg.recording = true;   // arm it: starts when the peer connects
  }
  btn.textContent = "Stop";
  logLine(`Recording ${started ? `${started} live` : "armed"}.`, "sys");
});

// identity pool
// A brand-new account created seconds before a call is the anomaly: its
// createdAt clusters with the call and it has no history. The pool holds
// Human age: "3.5 days", "5 hr", "12 min" — the pool panel reads in words.
function ageWords(min) {
  if (min >= 1440) { const d = min / 1440; return `${d >= 10 ? Math.round(d) : +d.toFixed(1)} day${d >= 2 ? "s" : ""}`; }
  if (min >= 60)   { const h = min / 60;   return `${h >= 10 ? Math.round(h) : +h.toFixed(1)} hr`; }
  return `${Math.round(min)} min`;
}

// identities that simply exist and age, and legs lease from it.
async function poolRefresh() {
  const list = $("poolList"), sum = $("poolSummary");
  if (!list) return;
  try {
    const j = await (await fetch("/api/pool")).json();
    const es = (j.entries || []).slice().sort((a, b) => a.created - b.created);
    if (!es.length) {
      list.innerHTML = '<div class="empty">No identities yet.</div>';
      if (sum) sum.textContent = "0 identities";
      return;
    }
    const fresh = es.filter((e) => e.age_min < 10).length;
    if (sum) sum.textContent = `${es.length} identities · oldest ${ageWords(es[0].age_min)}`
      + (fresh === es.length ? " · all new" : "");
    list.innerHTML = es.map((e) => {
      const used = (e.uses || 0) > 0;
      const meta = `${ageWords(e.age_min)} · ${e.uses ? `used ${e.uses} time${e.uses === 1 ? "" : "s"}` : "never used"}`;
      return `<div class="poolrow" data-used="${used ? 1 : 0}">
        <span class="who"><span class="id" title="${escapeHtml(e.deviceId)}">${escapeHtml(e.username || e.deviceId)}</span><span class="sub" title="${escapeHtml(e.deviceId)}">${meta}</span></span>
        <button class="delid" data-delid="${escapeHtml(e.deviceId)}"
                title="Remove from the pool">Remove</button>
      </div>`;
    }).join("");

    list.querySelectorAll("[data-delid]").forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.delid;
        if (!confirm(`Remove ${id} from the pool?`)) return;
        safeLoad(async () => {
          await fetch(`/api/pool/${encodeURIComponent(id)}`, { method: "DELETE" });
          logLine(`Removed ${id}.`, "sys");
          poolRefresh();
        });
      };
    });
  } catch (e) {
    list.innerHTML = '<div class="empty">No identities yet.</div>';
    if (sum) sum.textContent = "—";
  }
}

$("btnPoolRefresh")?.addEventListener("click", poolRefresh);
$("btnPoolAdd")?.addEventListener("click", async () => {
  const n = Math.max(1, Math.min(parseInt($("poolCount")?.value, 10) || 1, 20));
  const btn = $("btnPoolAdd");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const j = await (await fetch("/api/pool/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ n }),
    })).json();
    logLine(`Added ${j.added.length} identities.`, "match");
  } catch (e) {
    logLine(`Could not add identities: ${e.message}`, "err");
  }
  btn.disabled = false; btn.textContent = "Add";
});

// per-leg: lease a different identity without touching the other leg
async function legNewIdentity(leg) {
  try {
    const j = await (await fetch("/api/new", { method: "POST" })).json();
    leg.cookie = j.cookie;
    leg.deviceId = j.deviceId;
    leg.username = null;
    legInfo(leg);
    logLine(`Leg ${leg.key}: ${j.deviceId}`, "match");
    poolRefresh();
  } catch (e) {
    logLine(`Leg ${leg.key}: ${e.message}`, "err");
  }
}


// pool clear
$("btnPoolClear")?.addEventListener("click", async () => {
  if (!confirm("Remove all pooled identities?")) return;
  const j = await (await fetch("/api/pool/clear", { method: "POST" })).json();
  logLine(`Removed ${j.cleared} identities.`, "sys");
  poolRefresh();
});

