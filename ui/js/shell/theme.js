"use strict";
// Dark / light theme switch.

// theme (dark / light), switch at the bottom of the sidebar
// The <head> script applies the saved theme before CSS loads, so there is no
// flash; this wires the buttons and keeps them in sync.
const THEME = (() => {
  const KEY = "voisa:theme";
  const root = document.documentElement;
  const SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  const MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  const get = () => root.getAttribute("data-theme") === "light" ? "light" : "dark";
  function set(t) {
    root.setAttribute("data-theme", t);
    try { localStorage.setItem(KEY, t); } catch (_) {}
    paint();
  }
  function paint() {
    const t = get();
    $("themeDark") && $("themeDark").setAttribute("aria-pressed", String(t === "dark"));
    $("themeLight") && $("themeLight").setAttribute("aria-pressed", String(t === "light"));
    const i = $("themeIcon");
    if (i) { i.innerHTML = t === "dark" ? SUN : MOON; i.title = t === "dark" ? "Light mode" : "Dark mode"; }
    const m = document.querySelector('meta[name="theme-color"]');
    if (m) m.content = t === "dark" ? "#000000" : "#EAECF0";
  }
  $("themeDark") && ($("themeDark").onclick = () => set("dark"));
  $("themeLight") && ($("themeLight").onclick = () => set("light"));
  $("themeIcon") && ($("themeIcon").onclick = () => set(get() === "dark" ? "light" : "dark"));
  paint();
  return { get, set };
})();
