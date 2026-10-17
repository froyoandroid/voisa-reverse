"use strict";
// Settings view: audio devices and processing, call and relay behaviour,
// and recording storage. Values live in prefs (core/prefs.js).

// switches
document.querySelectorAll("#view-settings input.sw[data-pref]").forEach((el) => {
  const k = el.dataset.pref;
  el.checked = !!prefs()[k];
  el.addEventListener("change", () => {
    setPref(k, el.checked);
    if (k === "echo" || k === "noise" || k === "agc") micReopen();
    if (k === "keepSearching") searchAuto = el.checked;
    logLine(`Setting: ${el.closest(".set").querySelector(".set-k").firstChild.textContent.trim()} ${el.checked ? "on" : "off"}.`, "sys");
  });
});

// devices
const hasSink = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
if (!hasSink && $("setSpkRow")) $("setSpkRow").hidden = true;

async function setDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch (_) { return; }
  const fill = (sel, kind, want) => {
    if (!sel) return;
    const list = devs.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
    sel.innerHTML = '<option value="">System default</option>' + list.map((d, i) =>
      `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `${kind === "audioinput" ? "Microphone" : "Speaker"} ${i + 1}`)}</option>`).join("");
    sel.value = list.some((d) => d.deviceId === want) ? want : "";
  };
  fill($("setMic"), "audioinput", prefs().micId);
  fill($("setSpk"), "audiooutput", prefs().speakerId);
  const named = devs.some((d) => d.kind === "audioinput" && d.label);
  if ($("setMicHint")) $("setMicHint").textContent = named ? "Speak to see the meter move" : "Press Test to show device names";
}
$("setMic")?.addEventListener("change", (e) => {
  setPref("micId", e.target.value);
  logLine("Setting: microphone changed.", "sys");
  if (rtc.micStream) micReopen().then(setMeter); else setMeterStop();
});
$("setSpk")?.addEventListener("change", (e) => {
  setPref("speakerId", e.target.value);
  document.querySelectorAll("audio").forEach(applySink);
  logLine("Setting: speaker changed.", "sys");
});
navigator.mediaDevices?.addEventListener?.("devicechange", setDevices);

// mic level meter: runs on the session mic while Settings is open
const SETM = { ctx: null, an: null, src: null, raf: 0, stream: null };
function setMeterStop() {
  cancelAnimationFrame(SETM.raf); SETM.raf = 0;
  try { SETM.src && SETM.src.disconnect(); } catch (_) {}
  if (SETM.ctx) SETM.ctx.close().catch(() => {});
  SETM.ctx = SETM.an = SETM.src = SETM.stream = null;
  if ($("setMicLvl")) $("setMicLvl").style.width = "0";
}
function setMeter() {
  setMeterStop();
  if (!rtc.micStream) return;
  try {
    SETM.ctx = new AudioContext();
    if (SETM.ctx.state !== "running") SETM.ctx.resume().catch(() => {});
    SETM.src = SETM.ctx.createMediaStreamSource(rtc.micStream);
    SETM.an = SETM.ctx.createAnalyser(); SETM.an.fftSize = 1024;
    SETM.src.connect(SETM.an);
    SETM.stream = rtc.micStream;
    const buf = new Float32Array(SETM.an.fftSize), bar = $("setMicLvl");
    const tick = () => {
      if (!SETM.an || $("view-settings").hidden || SETM.stream !== rtc.micStream) { setMeterStop(); return; }
      SETM.an.getFloatTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const v = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      bar.style.width = `${Math.round(v * 100)}%`;
      bar.dataset.audible = v > 0.04 ? "1" : "0";
      SETM.raf = requestAnimationFrame(tick);
    };
    tick();
  } catch (_) {}
}
$("btnMicTest")?.addEventListener("click", async () => {
  try { await micEnsure(); } catch (_) { return; }
  await setDevices();
  setMeter();
});

// default language: mirrors the call deck's selector, both ways
(() => {
  const deck = $("lang"), sel = $("setLang");
  if (!deck || !sel) return;
  sel.innerHTML = deck.innerHTML;
  if (prefs().lang && [...deck.options].some((o) => o.value === prefs().lang)) deck.value = prefs().lang;
  sel.value = deck.value;
  deck.addEventListener("change", () => { setPref("lang", deck.value); sel.value = deck.value; });
  sel.addEventListener("change", () => { setPref("lang", sel.value); deck.value = sel.value; });
})();

// storage
async function storagePaint() {
  if (!$("stSummary")) return;
  try {
    const j = await recFetch();
    const part = (fs) => fs.length
      ? `${fs.length} · ${fmtDur(fs.reduce((n, f) => n + (f.durationMs || 0), 0))} · ${(fs.reduce((n, f) => n + f.bytes, 0) / 1048576).toFixed(1)} MB`
      : "None";
    const call = j.files.filter((f) => f.kind === "call" || f.kind === "legacy");
    const relay = j.files.filter((f) => f.kind === "relay");
    $("stSummary").textContent = j.files.length
      ? `${j.files.length} files · ${(j.total_bytes / 1048576).toFixed(1)} MB`
      : "None";
    $("stCall").textContent = part(call);
    $("stRelay").textContent = part(relay);
    $("btnStClearCall").disabled = !call.length;
    $("btnStClearRelay").disabled = !relay.length;
  } catch (_) {
    $("stSummary").textContent = "Unavailable";
  }
  // leftovers in browser storage (OPFS) from before the move to the server
  try {
    const root = await navigator.storage.getDirectory();
    const old = [];
    for await (const name of root.keys()) if (/^relay-(A|B|mix)-.+\.webm$/.test(name)) old.push(name);
    $("stOldRow").hidden = !old.length;
    $("stOld").textContent = `${old.length} file${old.length === 1 ? "" : "s"}`;
    $("btnStClearOld").onclick = async () => {
      if (!confirm(`Remove ${old.length} old recording(s) from this browser?`)) return;
      for (const n of old) { try { await root.removeEntry(n); } catch (_) {} }
      logLine(`Removed ${old.length} old browser recording(s).`, "sys");
      storagePaint();
    };
  } catch (_) { $("stOldRow").hidden = true; }
}
const stClear = (kind, label) => async () => {
  if (!confirm(`Remove all ${label} recordings?`)) return;
  let n = 0;
  for (const k of kind === "call" ? ["call", "legacy"] : [kind]) {
    n += (await (await fetch(`/api/recordings?kind=${k}`, { method: "DELETE" })).json()).deleted || 0;
  }
  logLine(`Removed ${n} ${label} recording(s).`, "sys");
  recRefreshAll();
};
$("btnStClearCall")?.addEventListener("click", stClear("call", "call"));
$("btnStClearRelay")?.addEventListener("click", stClear("relay", "relay"));

// opening Settings refreshes devices, storage, and the meter if the mic is open
function settingsOpen() {
  setDevices();
  storagePaint();
  if (rtc.micStream) setMeter();
}
