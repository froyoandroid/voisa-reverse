"use strict";
// Recordings go to the server. The browser runs the MediaRecorder; each 1 s
// chunk is uploaded in order as it is produced (POST /api/rec/<name>/chunk),
// so the server holds everything up to the last second even if the tab
// closes or crashes. The server keeps a recording for 24 hours from its
// start. This replaced browser storage (OPFS), which lost and broke files.

function recMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// One recording of one stream. meta: {kind, track, group, peer}.
class ServerRec {
  constructor(stream, meta) {
    this.stream = stream;
    this.meta = meta || {};
    this.name = null;
    this.seq = 0;
    this.bytes = 0;
    this.t0 = 0;
    this.failed = false;
    this.chain = Promise.resolve();
    this.mr = null;
  }
  elapsed() { return this.t0 ? Date.now() - this.t0 : 0; }
  async start() {
    const mime = recMime();
    this.mr = new MediaRecorder(this.stream,
      Object.assign({ audioBitsPerSecond: 64000 }, mime ? { mimeType: mime } : {}));
    this.t0 = Date.now();
    // the name arrives before the first chunk is sent: every upload waits on it
    const ready = fetch("/api/rec/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ mime: this.mr.mimeType || mime }, this.meta)),
    }).then((r) => r.json()).then((j) => {
      if (!j.name) throw new Error(j.detail || "start refused");
      this.name = j.name;
    });
    this.chain = ready.catch((e) => {
      this.failed = true;
      logLine(`Recording could not start on the server: ${e.message}`, "err");
    });
    this.mr.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      const seq = this.seq++;
      // serialised: a slow upload never lets the next chunk overtake it
      this.chain = this.chain.then(() => this.upload(seq, e.data));
    };
    this.mr.start(1000);
    return this;
  }
  async upload(seq, blob) {
    if (this.failed || !this.name) return;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`/api/rec/${encodeURIComponent(this.name)}/chunk?seq=${seq}`, {
          method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob,
        });
        if (r.ok) { this.bytes += blob.size; return; }
        if (r.status === 410 || r.status === 404) { this.failed = true; return; }
      } catch (_) { /* network blip: retry */ }
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
    }
    this.failed = true;
    logLine(`Recording upload failed at ${Math.round(seq)} s; kept what reached the server.`, "err");
  }
  // Resolves once the last chunk is on the server and the file is closed.
  stop() {
    return new Promise((resolve) => {
      const finish = async () => {
        await this.chain;
        if (this.name) {
          try {
            await fetch(`/api/rec/${encodeURIComponent(this.name)}/stop`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ durationMs: this.elapsed() }),
            });
          } catch (_) {}
        }
        resolve(this);
      };
      if (!this.mr || this.mr.state === "inactive") { finish(); return; }
      this.mr.onstop = finish;
      try { this.mr.stop(); } catch (_) { finish(); }
    });
  }
}

// "2:05", "1:02:05"
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(x)}` : `${m}:${p(x)}`;
}
// "in 23 h", "in 40 min"
function fmtLeft(expires, now) {
  const ms = expires - now;
  if (ms <= 0) return "expiring";
  const min = Math.round(ms / 60000);
  return min >= 60 ? `${Math.round(min / 60)} h left` : `${min} min left`;
}
function fmtWhen(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// Live clocks: any element with data-since (ms epoch) shows the elapsed time,
// updated every second (record buttons and live list rows).
setInterval(() => {
  document.querySelectorAll("[data-since]").forEach((el) => {
    const t = +el.dataset.since;
    if (t) el.textContent = fmtDur(Date.now() - t);
  });
}, 1000);

// Fetch the owner's recordings (all kinds). Every list and the Storage
// settings read through here.
async function recFetch() {
  const j = await (await fetch("/api/recordings", { cache: "no-store" })).json();
  // align list clocks with the server's
  j.skew = (j.now || Date.now()) - Date.now();
  return j;
}

// One player at a time across the whole page.
document.addEventListener("play", (e) => {
  if (!(e.target instanceof HTMLAudioElement) || !e.target.closest("#recs, #recList")) return;
  document.querySelectorAll("#recs audio, #recList audio").forEach((a) => { if (a !== e.target) a.pause(); });
}, true);

// Rows for a recordings list. opts.tag(item) gives the badge text.
function recRowsHtml(files, now, opts) {
  return files.map((f) => {
    const url = `/api/recordings/${encodeURIComponent(f.name)}`;
    const dur = f.live
      ? `<span class="rec-live">Live <b data-since="${f.created}">${fmtDur(now - f.created)}</b></span>`
      : `<span class="rec-dur">${f.durationMs ? fmtDur(f.durationMs) : "—"}</span>`;
    const left = f.expires ? `<span class="rec-left">${fmtLeft(f.expires, now)}</span>` : "";
    const who = f.peer ? `<span class="rec-peer">${escapeHtml(f.peer)}</span>` : "";
    return `<div class="recrow${f.live ? " is-live" : ""}">
      <span class="legtag">${escapeHtml(opts.tag(f))}</span>
      <span class="rec-main"><span class="fname">${escapeHtml(fmtWhen(f.created))}</span>${who}</span>
      ${dur}
      <span class="meta">${(f.bytes / 1024).toFixed(0)} KB</span>${left}
      <span class="rec-acts">
        <button class="mini play" data-play="${escapeHtml(f.name)}">Play</button>
        <a class="mini" href="${url}?dl=1" download="${escapeHtml(f.name)}">Download</a>
        <button class="mini" data-del="${escapeHtml(f.name)}">Remove</button>
      </span>
    </div>
    <div class="recplayer" data-player="${escapeHtml(f.name)}" hidden><audio controls preload="none" data-src="${url}"></audio></div>`;
  }).join("");
}
// Wire Play (toggle the row's player) and Remove for a rendered list.
function recRowsWire(box, refresh) {
  box.querySelectorAll("[data-play]").forEach((btn) => {
    btn.onclick = () => {
      const pl = box.querySelector(`[data-player="${CSS.escape(btn.dataset.play)}"]`);
      const open = !pl.hidden;
      box.querySelectorAll(".recplayer").forEach((x) => {
        x.hidden = true; const a = x.querySelector("audio"); if (a) a.pause();
      });
      if (open) return;
      pl.hidden = false;
      const a = pl.querySelector("audio");
      // fresh URL each time: a live recording keeps growing
      a.src = `${a.dataset.src}?t=${Date.now()}`;
      a.play().catch((e) => logLine(`Could not play: ${e.message}`, "warn"));
    };
  });
  box.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/recordings/${encodeURIComponent(btn.dataset.del)}`, { method: "DELETE" });
      refresh();
    };
  });
}
// Lists poll while anything is live, so durations and new files appear.
let recPollT = 0;
function recPoll(anyLive) {
  clearTimeout(recPollT);
  if (anyLive) recPollT = setTimeout(recRefreshAll, 5000);
}
function recRefreshAll() {
  if (typeof loadRecs === "function") loadRecs();
  if (typeof recListRefresh === "function") recListRefresh();
  if (typeof storagePaint === "function") storagePaint();
}
