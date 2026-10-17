"use strict";
// Identity pool sheet.

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
      const name = e.username || "Unnamed identity";
      return `<div class="idrow poolrow" data-used="${used ? 1 : 0}" style="--tone:${toneFor(name)}">
        <span class="idmark" aria-hidden="true">${escapeHtml(initialOf(name))}</span>
        <span class="idtext"><b>${escapeHtml(name)}</b><small>${meta}</small></span>
        <span class="idact"><button class="idx-del delid" data-delid="${escapeHtml(e.deviceId)}" data-name="${escapeHtml(name)}"
                title="Remove from the pool" aria-label="Remove ${escapeHtml(name)}">×</button></span>
      </div>`;
    }).join("");

    list.querySelectorAll("[data-delid]").forEach((b) => {
      b.onclick = async () => {
        const id = b.dataset.delid;
        if (!confirm(`Remove ${b.dataset.name || "this identity"} from the pool?`)) return;
        safeLoad(async () => {
          await fetch(`/api/pool/${encodeURIComponent(id)}`, { method: "DELETE" });
          logLine(`Removed ${b.dataset.name || "identity"}.`, "sys");
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

// per-leg: a brand-new identity without touching the other leg
async function legNewIdentity(leg) {
  try {
    const j = await (await fetch("/api/relay/fresh", { method: "POST" })).json();
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
