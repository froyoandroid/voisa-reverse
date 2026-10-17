"use strict";
// Activity log: on-page lines and persisted history.

// logging
function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}
const LOG_KEY = "voisa.log.v1";
const LOG_MAX = 300;        // lines kept on screen and in this tab's history
const LOG_TEXT_MAX = 2000;  // one line's stored text; longer payloads are cut
let logHist = null;
let logSaveT = 0;
function logHistLoad() {
  if (logHist) return logHist;
  try { logHist = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]"); }
  catch (_) { logHist = []; }
  return logHist;
}
function logHistSave() {
  const now = Date.now();
  if (now - logSaveT < 800) return;
  logSaveT = now;
  try { sessionStorage.setItem(LOG_KEY, JSON.stringify(logHist.slice(-LOG_MAX))); }
  catch (_) {}
}
function logLine(text, cls = "sys", persist = true) {
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  // collapse reconnect storms: one line, not one per attempt
  const last = logEl.lastElementChild;
  if (last && last.dataset.logText === text) return last;
  const el = document.createElement("div");
  el.dataset.logText = text;
  // level classes are prefixed: a bare .match / .in clashed with other components
  el.className = "l l-" + cls;
  const t = stamp();
  const body = text.length > LOG_TEXT_MAX ? text.slice(0, LOG_TEXT_MAX) + " …" : text;
  el.innerHTML = `<span class="t">${t}</span><span class="x">${escapeHtml(body)}</span>`;
  // long lines are clamped to two rows; click one to read all of it
  el.onclick = () => { if (!getSelection().toString()) el.classList.toggle("open"); };
  logEl.appendChild(el);
  while (logEl.children.length > LOG_MAX) logEl.removeChild(logEl.firstChild);
  if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  if (!persist) return;
  logHistLoad().push({ t, text: text.slice(0, LOG_TEXT_MAX), cls });
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
// jump to the newest line (used when the Logs view opens)
function logToBottom() {
  requestAnimationFrame(() => { logEl.scrollTop = logEl.scrollHeight; });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
$("btnClear").onclick = () => {
  logEl.innerHTML = "";
  logHist = [];
  try { sessionStorage.removeItem(LOG_KEY); } catch (e) {}
};
