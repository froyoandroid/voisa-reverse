"use strict";
// Call controls wiring.

// controls
$("btnNew").onclick = async () => {
  try {
    const r = await fetch("/api/new", { method: "POST" });
    const j = await r.json();
    acct.deviceId = j.deviceId;
    acct.cookie = j.cookie;
    acct.username = null;
    acct.premium = false;
    saveIdentity({ deviceId: j.deviceId, cookie: j.cookie });
    renderAcct();
    logLine(`New identity: ${j.deviceId}`, "match");
    myGen++;
    send({ cmd: "connect", deviceId: j.deviceId, cookie: j.cookie, gen: myGen });
    setConn("off", "Connecting…");
  } catch (e) {
    logLine(`Could not create identity: ${e.message}`, "err");
  }
};
