"use strict";
// Call recordings list (server, kind "call"; old server-engine files show as
// "Old").

function safeLoad(fn) {
  try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch (_) {}
}
async function loadRecs() {
  const box = $("recs");
  const info = $("recInfo");
  if (!box) return;
  try {
    const j = await recFetch();
    const now = Date.now() + j.skew;
    const files = j.files.filter((f) => f.kind === "call" || f.kind === "legacy");
    const total = files.reduce((n, f) => n + (f.durationMs || 0), 0);
    if (info) {
      info.textContent = files.length
        ? `${files.length} recording${files.length > 1 ? "s" : ""} · ${fmtDur(total)} total · kept ${j.ttl_hours} h`
        : "";
      info.hidden = !files.length;
    }
    if (!files.length) {
      box.innerHTML = '<div class="empty">Nothing yet. Record during a call.</div>';
      recPoll(false);
      return;
    }
    box.innerHTML = recRowsHtml(files, now, { tag: (f) => (f.kind === "legacy" ? "Old" : "Call") });
    recRowsWire(box, loadRecs);
    recPoll(files.some((f) => f.live));
  } catch (e) {
    if (info) { info.textContent = "Unavailable."; info.hidden = false; }
    box.innerHTML = '<div class="empty">Unavailable.</div>';
  }
}
$("btnRecRefresh").onclick = loadRecs;
$("btnRecClear").onclick = async () => {
  if (!confirm("Remove all call recordings?")) return;
  try {
    let n = 0;
    for (const kind of ["call", "legacy"]) {
      n += (await (await fetch(`/api/recordings?kind=${kind}`, { method: "DELETE" })).json()).deleted || 0;
    }
    logLine(`Removed ${n} recordings.`, "sys");
    loadRecs();
  } catch (e) {
    logLine(`Could not clear: ${e.message}`, "err");
  }
};
