"use strict";
// "You are …" identity panel.

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
  // no identity until the first Start/search
  if (head) head.textContent = acct.username || (acct.cookie ? "assigning…" : "not started");
  const core = $("orbCore");
  if (core && !core.classList.contains("has-peer"))
    core.textContent = (acct.username || "v").trim()[0] || "v";
  const el = $("acct");
  if (!el) return;
  const row = (k, v) => v == null ? "" :
    `<span>${k}</span><b>${escapeHtml(String(v))}</b>`;
  el.innerHTML =
    row("username", acct.username) +
    (acct.username ? `<span>premium</span><b>${acct.premium ? "yes" : "no"}</b>` : "");
}
