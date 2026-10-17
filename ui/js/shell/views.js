"use strict";
// Sidebar view switching.

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
    if (b.dataset.view === "logs") logToBottom();
    const tt = $("topbarTitle");
    if (tt) tt.textContent = b.dataset.label || b.textContent.trim();
    if (SB.phone()) SB.close();          // a pick on the phone drawer closes it
  };
});
