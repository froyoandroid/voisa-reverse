"use strict";
// Identity sheet: New identity and remembered identities.

// saved identities: switch back to one you used before
const TONES = ["#FE7F2D", "#5BA4CF", "#E4C26B", "#7FC8A9", "#D98BB6", "#9AA7F2"];
function toneFor(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return TONES[h % TONES.length]; }
function initialOf(name) { const m = String(name).match(/[A-Za-z0-9]/); return m ? m[0].toUpperCase() : "?"; }
// every identity this tab ends up using is remembered automatically, so the
// list stays useful without a manual "save" button
async function autoSaveIdentity() {
  if (!acct.deviceId || !acct.cookie) return;
  try {
    await fetch("/api/saved", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: acct.deviceId, cookie: acct.cookie, username: acct.username }) });
  } catch (_) {}
  renderSaved();
}
async function renderSaved() {
  const box = $("savedList");
  if (!box) return;
  try {
    const j = await (await fetch("/api/saved")).json();
    if (!j.entries.length) { box.innerHTML = '<div class="empty">No saved identities.</div>'; return; }
    box.innerHTML = j.entries.map((e, i) => {
      const name = e.username || "Unnamed identity";
      const uses = e.uses ? `used ${e.uses}×` : "never used";
      const live = acct.deviceId && e.deviceId === acct.deviceId;
      return `<div class="idrow${live ? " live" : ""}" style="--tone:${toneFor(name)}">
        <span class="idmark" aria-hidden="true">${escapeHtml(initialOf(name))}</span>
        <span class="idtext"><b>${escapeHtml(name)}</b><small>${live ? "In use on this tab" : uses}</small></span>
        <span class="idact">${live ? '<span class="idlive">Live</span>' : `<button class="mini" data-use="${escapeHtml(e.deviceId)}">Use</button>`}
        <button class="idx-del" data-delid="${escapeHtml(e.deviceId)}" data-name="${escapeHtml(name)}" title="Remove" aria-label="Remove ${escapeHtml(name)}">×</button></span>
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
          logLine(`Removed ${b.dataset.name || "identity"}.`, "sys");
        } catch (e) { logLine(`Could not remove: ${e.message}`, "err"); }
        renderSaved();
      };
    });
  } catch (_) { box.innerHTML = '<div class="empty">Unavailable.</div>'; }
}
