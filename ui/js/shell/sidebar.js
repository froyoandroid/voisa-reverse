"use strict";
// Collapsible sidebar / phone drawer.

// collapsible sidebar
// Desktop/tablet: docked, collapsible to an icon rail; the choice is remembered.
// Phone (<=720px): an off-canvas drawer, collapsed by default every time.
// Crossing the breakpoint re-applies the right default, so it stays dynamic
// on rotate / window resize.
const SB = (() => {
  const KEY = "voisa:sidebar";           // "collapsed" | "expanded" (desktop only)
  const mq = window.matchMedia("(max-width: 720px)");
  const tablet = window.matchMedia("(max-width: 1040px)");
  const body = document.body;
  const phone = () => mq.matches;

  // label every nav item so the rail can show a tooltip
  document.querySelectorAll(".nav[data-view]").forEach((b) => {
    if (!b.dataset.label) b.dataset.label = b.textContent.trim();
  });

  function paint() {
    const collapsed = body.classList.contains("sb-collapsed");
    const open = body.classList.contains("sb-open");
    const t = $("sbToggle"), o = $("sbOpen");
    if (t) {
      const expanded = phone() ? open : !collapsed;
      t.setAttribute("aria-expanded", String(expanded));
      t.setAttribute("aria-label", phone() ? "Close menu" : collapsed ? "Expand sidebar" : "Collapse sidebar");
    }
    if (o) o.setAttribute("aria-expanded", String(open));
  }
  function pref() {
    try { return localStorage.getItem(KEY); } catch (_) { return null; }
  }
  function apply() {
    body.classList.remove("sb-open");
    if (phone()) body.classList.add("sb-collapsed");           // drawer starts closed
    else {
      const p = pref();
      // no saved choice: expanded on desktop, rail on tablet widths
      const collapsed = p ? p === "collapsed" : tablet.matches;
      body.classList.toggle("sb-collapsed", collapsed);
    }
    paint();
  }
  function toggle() {
    if (phone()) { body.classList.contains("sb-open") ? close() : open(); return; }
    const c = body.classList.toggle("sb-collapsed");
    try { localStorage.setItem(KEY, c ? "collapsed" : "expanded"); } catch (_) {}
    paint();
  }
  function open()  { body.classList.add("sb-open"); paint(); }
  function close() { body.classList.remove("sb-open"); paint(); }

  $("sbToggle") && ($("sbToggle").onclick = toggle);
  $("sbOpen") && ($("sbOpen").onclick = open);
  $("sbScrim") && ($("sbScrim").onclick = close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && phone()) close(); });
  // swipe left on the open drawer to close it
  let x0 = null;
  const sb = $("sidebar");
  if (sb) {
    sb.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    sb.addEventListener("touchend", (e) => {
      if (x0 != null && phone() && e.changedTouches[0].clientX - x0 < -50) close();
      x0 = null;
    }, { passive: true });
  }
  (mq.addEventListener ? mq.addEventListener("change", apply) : mq.addListener(apply));
  (tablet.addEventListener ? tablet.addEventListener("change", apply) : tablet.addListener(apply));
  apply();
  return { phone, open, close, toggle };
})();
showView("client");
callPaint();
