"use strict";
// Credential scrubbing before anything is logged.

// Strip credentials before anything reaches the on-page log.
//
// fetch-initial-data carries the session cookie, the device id and the TURN
// username/credential in one payload. Dumping it raw printed the whole
// credential set on screen — and this page is served over the network.
function redact(o, inIce) {
  if (o == null || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map((x) => redact(x, inIce));
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    // `username` is the visible display name in userData but a TURN secret in
    // iceServers, so it is only hidden inside an ICE server entry.
    const iceSecret = inIce && /^username$/i.test(k);
    if (iceSecret || /^(cookie|credential|token|secret|password|deviceid)$/i.test(k)) {
      out[k] = "‹redacted›";
    } else {
      // recurse into EVERY nested object/array, not just known keys. Only
      // handling a hard-coded "userData" left iceServers untouched, and that
      // array carries the TURN username + credential.
      const childIce = inIce || /^iceservers$/i.test(k);
      out[k] = (v && typeof v === "object") ? redact(v, childIce) : v;
    }
  }
  return out;
}
