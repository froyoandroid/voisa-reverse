"use strict";
// Relay recordings list.

// recordings list from browser storage: one row per file, blob URLs for
// play/download straight out of OPFS — the server never sees these bytes
let recUrls = [];
async function recListRefresh() {
  const box = $("recList");
  if (!box) return;
  recUrls.forEach((u) => URL.revokeObjectURL(u));
  recUrls = [];
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) {
      box.innerHTML = '<div class="empty">Browser storage not supported here.</div>';
      return;
    }
    const root = await recRoot();
    const files = [];
    for await (const name of await root.keys()) {
      if (!/^relay-[AB]-.+\.webm$/.test(name)) continue;
      const fh = await root.getFileHandle(name);
      const f = await fh.getFile();
      files.push({ name, f, url: URL.createObjectURL(f) });
      recUrls.push(files[files.length - 1].url);
    }
    files.sort((x, y) => y.f.lastModified - x.f.lastModified);
    if (!files.length) {
      box.innerHTML = '<div class="empty">No recordings yet.</div>';
      return;
    }
    box.innerHTML = files.map(({ name, f, url }) => {
      const m = name.match(/^relay-([AB])-(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})\.webm$/);
      const leg = m ? m[1] : "?";
      const when = m ? `${m[2]} ${m[3].replace(/-/g, ":")}` : name;
      const kb = (f.size / 1024).toFixed(0);
      return `<div class="recrow">
        <span class="legtag">${escapeHtml(leg)}</span>
        <span class="fname">${escapeHtml(when)}</span>
        <span class="meta">${kb} KB</span>
        <button class="mini play" data-play="${escapeHtml(name)}">Play</button>
        <a class="mini" href="${url}" download="${escapeHtml(name)}">Download</a>
        <button class="mini" data-del="${escapeHtml(name)}">Remove</button>
      </div>
      <div class="recplayer" data-player="${escapeHtml(name)}" hidden>
        <audio controls preload="none" src="${url}"></audio>
      </div>`;
    }).join("");

    // one player at a time: opening another pauses and closes the previous, so
    // two recordings can never play over each other
    box.querySelectorAll("[data-play]").forEach((btn) => {
      btn.onclick = () => {
        const name = btn.dataset.play;
        const mine = box.querySelector(`[data-player="${CSS.escape(name)}"]`);
        const open = !mine.hidden;
        box.querySelectorAll(".recplayer").forEach((pl) => {
          pl.hidden = true;
          const a = pl.querySelector("audio");
          if (a) { a.pause(); a.currentTime = 0; }
        });
        if (!open) {
          mine.hidden = false;
          const a = mine.querySelector("audio");
          if (a) {
            a.play().catch((e) => logLine(`Could not play: ${e.message}`, "warn"));
            a.onerror = () => logLine(`Could not play ${name}.`, "err");
          }
        }
      };
    });

    box.querySelectorAll("[data-del]").forEach((btn) => {
      btn.onclick = () => { safeLoad(async () => {
        const root2 = await recRoot();
        await root2.removeEntry(btn.dataset.del);
        logLine(`Removed ${btn.dataset.del}.`, "sys");
        recListRefresh();
      }); };
    });
  } catch (e) {
    box.innerHTML = '<div class="empty">No recordings yet.</div>';
  }
}
$("btnRecRefreshMitm")?.addEventListener("click", recListRefresh);
