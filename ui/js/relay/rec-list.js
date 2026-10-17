"use strict";
// Relay recordings list (server, kind "relay"): one row per file, A, B and
// the A+B mix.

async function recListRefresh() {
  const box = $("recList");
  if (!box) return;
  try {
    const j = await recFetch();
    const now = Date.now() + j.skew;
    const files = j.files.filter((f) => f.kind === "relay");
    const sum = $("recListSum");
    if (sum) {
      const groups = new Set(files.map((f) => f.group || f.name)).size;
      const mix = files.filter((f) => f.track === "mix");
      const total = (mix.length ? mix : files).reduce((n, f) => n + (f.durationMs || 0), 0);
      sum.textContent = files.length
        ? `${groups} session${groups > 1 ? "s" : ""} · ${fmtDur(total)} recorded · kept ${j.ttl_hours} h`
        : `Saved on the server for ${j.ttl_hours} hours.`;
    }
    if (!files.length) {
      box.innerHTML = '<div class="empty">No recordings yet.</div>';
      recPoll(false);
      return;
    }
    box.innerHTML = recRowsHtml(files, now, { tag: (f) => (f.track === "mix" ? "A+B" : f.track) });
    recRowsWire(box, recListRefresh);
    recPoll(files.some((f) => f.live));
  } catch (e) {
    box.innerHTML = '<div class="empty">Unavailable.</div>';
  }
}
$("btnRecRefreshMitm")?.addEventListener("click", recListRefresh);
