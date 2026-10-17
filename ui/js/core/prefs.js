"use strict";
// Settings, kept per browser in localStorage (voisa:settings). Preferences
// only: identities and cookies never go here.

const PREFS_KEY = "voisa:settings";
const PREF_DEFAULTS = {
  micId: "",            // "" = system default
  speakerId: "",        // "" = system default
  echo: true,           // echo cancellation
  noise: true,          // noise suppression
  agc: true,            // auto gain
  startMuted: false,    // calls start with the mic muted
  lang: "",             // call language the deck opens on ("" = leave as is)
  keepSearching: true,  // re-search until a partner connects
  autoRecCall: false,   // record every call automatically
  autoRecRelay: false,  // record whenever the relay starts
};
let PREFS = (() => {
  try { return Object.assign({}, PREF_DEFAULTS, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}")); }
  catch (_) { return Object.assign({}, PREF_DEFAULTS); }
})();
function prefs() { return PREFS; }
function setPref(k, v) {
  PREFS[k] = v;
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS)); } catch (_) {}
}
