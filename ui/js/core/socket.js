"use strict";
// The /ws connection and connection status.

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
