"use strict";
// safeColor accepts only a plain CSS colour the peer's avatar may carry (a hex
// code or an rgb()/hsl() value). The colour comes from another Voisa user over
// the wire, so anything else (a url(), an expression) is dropped to the
// default, keeping attacker text out of our inline styles.
function safeColor(c) {
  c = String(c || "").trim();
  return /^#[0-9a-fA-F]{3,8}$|^rgba?\([\d.,\s%]+\)$|^hsla?\([\d.,\s%]+\)$|^[a-zA-Z]{3,20}$/.test(c) ? c : "";
}
// Partner card and match status line.

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

  const color = safeColor(peerInfo.avatar && peerInfo.avatar.color) || "#FE7F2D";
  const initial = name.trim()[0] || "?";
  const tag = phase === "live"
    ? '<span class="tag live">In call</span>'
    : phase === "pending"
      ? '<span class="tag wait">Incoming</span>'
      : '<span class="tag done">Ended</span>';

  const core = $("orbCore");
  if (core) { core.textContent = initial; core.style.setProperty("--peer", color); core.classList.add("has-peer"); }
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
  const core = $("orbCore");
  if (core) { core.textContent = "v"; core.style.removeProperty("--peer"); core.classList.remove("has-peer"); }
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
