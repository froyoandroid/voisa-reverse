"""Relay-leg recordings: chunked upload from the browser, verified on stop."""
import os, subprocess, time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from voisa_server.config import REC_DIR, REC_MIN_BYTES
from voisa_server.logs import logfile

router = APIRouter()


# log file
# One file per recording SESSION, not per chunk.
#
# MediaRecorder emits one webm as a first chunk carrying the EBML header plus
# subsequent header-less clusters. Writing each chunk to its own file produced
# fragments that ffprobe rejects with "EBML header parsing failed" - which is
# exactly the broken download that was reported. So chunks are appended to a
# single open session file per leg.
_REC_SESSIONS = {}          # leg -> {"path", "started", "bytes", "chunks"}


@router.post("/api/mitm/rec/{leg}")
async def api_rec_upload(leg: str, request: Request):
    leg = leg.upper()
    if leg not in ("A", "B"):
        raise HTTPException(400, "bad leg")
    body = await request.body()
    if not body:
        raise HTTPException(400, "empty body")

    os.makedirs(REC_DIR, exist_ok=True)
    # A recorder session is identified by (leg, token). Keying only by leg meant
    # a straggling chunk from a torn-down recorder landed in the file of the
    # NEXT one, mixing a second EBML header into a closed container — which is
    # what produced 4KB unplayable stubs next to good recordings. A chunk whose
    # token no longer matches the live session is discarded instead.
    token = request.headers.get("x-session") or "0"
    sess = _REC_SESSIONS.get(leg)
    if not sess or sess.get("token") != token:
        if sess and sess.get("chunks"):
            ok, note = _probe(sess["path"])
            logfile(f"[rec] leg {leg} superseded {os.path.basename(sess['path'])} "
                    f"({sess['bytes']} bytes) {'playable' if ok else 'BROKEN'}", "sys" if ok else "err")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        path = os.path.join(REC_DIR, f"mitm-leg{leg}-{stamp}.webm")
        sess = {"path": path, "started": time.time(), "bytes": 0, "chunks": 0,
                "token": token}
        _REC_SESSIONS[leg] = sess

    with open(sess["path"], "ab") as f:
        f.write(body)
    sess["bytes"] += len(body)
    sess["chunks"] += 1

    if sess["chunks"] == 1:
        logfile(f"[rec] leg {leg} -> {os.path.basename(sess['path'])} (session open)", "sys")
    return {"name": os.path.basename(sess["path"]), "bytes": sess["bytes"],
            "chunks": sess["chunks"]}


@router.post("/api/mitm/rec/{leg}/stop")
async def api_rec_stop(leg: str, request: Request):
    """Close the session and verify the container is actually readable."""
    leg = leg.upper()
    token = request.headers.get("x-session") or "0"
    sess = _REC_SESSIONS.get(leg)
    if not sess or sess.get("token") != token:
        # a newer session already replaced this one; do not close it
        return {"ok": True, "reason": "superseded"}
    _REC_SESSIONS.pop(leg, None)
    path = sess["path"]
    # Finalise: remux the container without touching the audio.
    #
    # A recorder that is torn down mid-chunk leaves a truncated tail, and the
    # streamed webm has no duration or cue. ffmpeg -c copy rewrites the
    # container so the file reports a duration and decodes cleanly instead of
    # "File ended prematurely". Audio is copied, never re-encoded.
    finalise = os.path.join(REC_DIR, os.path.basename(path) + ".fix")
    try:
        r = subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", path, "-c", "copy",
             "-f", "webm", finalise],
            capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and os.path.getsize(finalise) > REC_MIN_BYTES:
            os.replace(finalise, path)
        else:
            try:
                os.remove(finalise)
            except OSError:
                pass
    except Exception as e:
        logfile(f"[rec] finalise failed ({type(e).__name__}: {e}); keeping raw", "warn")

    ok, note = _probe(path)
    if not ok:
        # remove it: a stub that cannot be decoded is noise in the list
        try:
            os.remove(path)
        except OSError:
            pass
        logfile(f"[rec] leg {leg} discarded {os.path.basename(path)} "
                f"({sess['bytes']} bytes, {sess['chunks']} chunks): {note}", "warn")
        return {"ok": False, "discarded": True, "bytes": sess["bytes"], "note": note}
    logfile(f"[rec] leg {leg} closed {os.path.basename(path)} "
            f"({sess['bytes']} bytes, {sess['chunks']} chunks) playable", "sys")
    return {"ok": True, "name": os.path.basename(path), "bytes": sess["bytes"],
            "chunks": sess["chunks"], "note": note}


def _probe(path: str):
    """Is the file a readable container with an audio stream?"""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a:0",
             "-show_entries", "stream=codec_name,sample_rate,channels",
             "-of", "default=nw=1", path],
            capture_output=True, text=True, timeout=20)
        if r.returncode != 0 or "codec_name" not in r.stdout:
            return False, (r.stderr.strip().splitlines() or ["no audio stream"])[-1][:160]
        return True, r.stdout.strip().replace("\n", " ")
    except FileNotFoundError:
        return True, "ffprobe unavailable"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


@router.get("/api/mitm/rec")
async def api_rec_list():
    try:
        names = sorted(
            (n for n in os.listdir(REC_DIR) if n.startswith("mitm-")),
            key=lambda n: os.path.getmtime(os.path.join(REC_DIR, n)),
            reverse=True,
        )
    except FileNotFoundError:
        names = []
    out = []
    for n in names:
        p = os.path.join(REC_DIR, n)
        try:
            st = os.stat(p)
        except OSError:
            continue
        if st.st_size < REC_MIN_BYTES:
            continue          # unplayable stub; do not offer it for download
        out.append({"name": n, "bytes": st.st_size, "mtime": int(st.st_mtime),
                    "leg": "A" if "-legA-" in n else "B" if "-legB-" in n else "?"})
    return {"files": out, "total_bytes": sum(e["bytes"] for e in out)}


@router.get("/api/mitm/rec/{name}")
async def api_rec_get(name: str):
    # no traversal: basename only, and only our own naming
    if os.path.basename(name) != name or not name.startswith("mitm-"):
        raise HTTPException(400, "bad name")
    p = os.path.join(REC_DIR, name)
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    media = "audio/webm" if name.endswith(".webm") else "application/octet-stream"
    return FileResponse(p, filename=name, media_type=media)


@router.delete("/api/mitm/rec/{name}")
async def api_rec_del(name: str):
    if os.path.basename(name) != name or not name.startswith("mitm-"):
        raise HTTPException(400, "bad name")
    p = os.path.join(REC_DIR, name)
    try:
        os.remove(p)
    except FileNotFoundError:
        raise HTTPException(404, "not found")
    return {"deleted": name}
