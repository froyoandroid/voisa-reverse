"use strict";
// Shared state, DOM helper and this tab's identity (sessionStorage).

const $ = (id) => document.getElementById(id);
const logEl = $("log");

const SERVER_EVENTS = [
  "start-search", "stop-search", "sync-call-state", "start-dialog",
  "close-dialog", "webrtc", "set-search-language", "shuffle-username", "update-avatar",
];

let ws = null;
let currentMatchId = null;
// This browser's Voisa identity. Each session holds its OWN, persisted here,
// so several tabs/relays never share (and fight over) one account, and so a
// reload keeps the same identity instead of grabbing a shared global one.
//
// This is the fix for "identity exists globally": the server no longer hands
// back a shared voisa_account.json default — the browser remembers its own
// identity and supplies it on every connect.
const ID_KEY = "voisa:identity";

// sessionStorage, not localStorage: localStorage is shared by every tab of the
// browser, which made one identity show up everywhere. sessionStorage is per
// tab (and survives that tab's reload). A duplicated tab copies it, so the
// server also refuses an identity another live session holds and hands the
// newcomer its own.
try { localStorage.removeItem(ID_KEY); } catch (_) {}   // drop the old shared copy

function loadIdentity() {
  try {
    const j = JSON.parse(sessionStorage.getItem(ID_KEY) || "null");
    return j && j.cookie ? j : null;
  } catch (_) { return null; }
}

function saveIdentity(id) {
  tabIdentity = id && id.cookie ? { deviceId: id.deviceId || "", cookie: id.cookie } : null;
  tabCookie = tabIdentity ? tabIdentity.cookie : null;
  try {
    if (tabIdentity) sessionStorage.setItem(ID_KEY, JSON.stringify(tabIdentity));
    else sessionStorage.removeItem(ID_KEY);
  } catch (_) {}
}

let tabIdentity = loadIdentity();
let tabCookie = tabIdentity ? tabIdentity.cookie : null;
// short label shown in the header, so two open tabs are told apart at a glance
let tabLabel = "";
let myGen = 0;          // bumped on every (re)connect; stale messages are dropped
