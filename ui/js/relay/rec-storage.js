"use strict";
// Per-leg recording into browser storage (OPFS).

// per-leg recording: each leg captured separately, so the two sides stay
// distinguishable without unmixing
// The bytes go to the SERVER, not to a download.
//
// A browser-side download produced a broken file: MediaRecorder only writes a
// valid container header on stop, so a reload or a torn-down leg left chunks
// that were never assembled and the .webm would not open. Uploading each chunk
// as it is produced means the server always holds everything received so far,
// and the file is fetched deliberately from the recordings list.
function legRecMime() {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

// browser storage (OPFS)
// Recordings live in the browser's Origin Private File System, not on the
// server. Each 1s chunk is appended at an explicit offset with its own
// writable + close, so every chunk is flushed to disk as it lands: a reload
// mid-recording leaves a playable file (header in the first chunk, clusters
// appended in order), which is what the old server-side session file bought.
async function recRoot() {
  return navigator.storage.getDirectory();
}
function recStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}
async function recWriteChunk(handle, offset, blob) {
  const w = await handle.createWritable({ keepExistingData: true });
  await w.write({ type: "write", position: offset, data: blob });
  await w.close();
}

function legRecordStart(leg, stream) {
  try {
    if (!stream || !stream.getAudioTracks().length) {
      logLine(`[mitm] leg ${leg.key}: nothing to record yet`, "warn");
      return;
    }
    const mime = legRecMime();
    leg.rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const name = `relay-${leg.key}-${recStamp()}.webm`;

    leg.rec.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return;
      // serialise writes: a slow flush must never interleave with the next chunk
      leg.recChain = (leg.recChain || Promise.resolve()).then(async () => {
        try {
          if (!leg.recHandle) {
            const root = await recRoot();
            leg.recHandle = await root.getFileHandle(name, { create: true });
            leg.recOffset = 0;
          }
          await recWriteChunk(leg.recHandle, leg.recOffset, e.data);
          leg.recOffset += e.data.size;
        } catch (err) {
          logLine(`[mitm] leg ${leg.key} chunk write failed: ${err.message}`, "err");
        }
      });
    };
    leg.rec.onstop = async () => {
      try {
        await (leg.recChain || Promise.resolve());
        const f = leg.recHandle ? await leg.recHandle.getFile() : null;
        if (f && f.size) logLine(`[mitm] leg ${leg.key} recording saved: ${name} (${(f.size / 1024).toFixed(0)} KB, in browser)`, "match");
        else logLine(`[mitm] leg ${leg.key}: nothing recorded`, "warn");
      } catch (e) {
        logLine(`[mitm] leg ${leg.key} stop failed: ${e.message}`, "err");
      }
      leg.recHandle = null; leg.recOffset = 0; leg.recChain = null;
      recListRefresh();
    };
    // 1s slices: frequent enough that a crash loses at most a second
    leg.rec.start(1000);
    leg.recording = true;
    logLine(`[mitm] leg ${leg.key}: recording to browser storage`, "sys");
  } catch (e) {
    logLine(`[mitm] leg ${leg.key} record failed: ${e.message}`, "err");
  }
}

function legRecordStop(leg) {
  leg.recording = false;
  try { if (leg.rec && leg.rec.state !== "inactive") leg.rec.stop(); } catch (_) {}
  leg.rec = null;
}
