"use strict";
// Boot: runs last, after every module is defined.

// boot
restoreLog();
connectWS();
setConn("off", "Connecting…");
safeLoad(loadRecs);
safeLoad(renderSaved);
