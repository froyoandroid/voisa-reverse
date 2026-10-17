"use strict";
// Developer tools: raw event emitter.

// populate raw-emit event list
const evtSel = $("evt");
SERVER_EVENTS.forEach((e) => {
  const o = document.createElement("option");
  o.value = o.textContent = e;
  evtSel.appendChild(o);
});
