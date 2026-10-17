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
    // lazy: only tell the server which identity this tab remembers. Nothing
    // is created or connected until the first Start/search; then the server
    // uses this tab's identity, else the browser's (kept 24 h), else a new one.
    send({ cmd: "connect", gen: myGen, lazy: true,
           deviceId: tabIdentity ? tabIdentity.deviceId : null,
           cookie: tabCookie || null,
           since: tabIdentity ? tabIdentity.since : null });
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
