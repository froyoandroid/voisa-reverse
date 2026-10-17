#!/usr/bin/env python3
"""
Voisa web UI backend — localhost-only.

Wraps the standalone Voisa protocol client (voisa.py / voisa_call.py) in an HTTP +
WebSocket API and serves a small vanilla-JS frontend.

  * Binds 127.0.0.1 only (no external interface).
  * Static UI: ui/index.html  (+ app.js / style.css)
  * REST  : accounts, state
  * WS    : /ws  — live socket events, emits, and call control (aiortc media)

Run:
    .venv/bin/python webui.py --port 8765
    # open http://127.0.0.1:8765
"""
import argparse, asyncio, json, os, socket, subprocess, sys, threading, time, uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import voisa
from voisa_pkg.account import saved_add, saved_remove, saved_status, saved_take

HERE = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(HERE, "ui")

LOG_FILE = os.path.join(HERE, "voisa.log")
_log_lock = threading.Lock()


# A day of logs is the useful window: long enough to reconstruct a session that
# ran overnight, short enough that the file never grows without bound.
LOG_MAX_AGE_S = 24 * 3600


def logfile(msg: str, level: str = "sys", cid: str = "") -> None:
    """Append one line to voisa.log. Never raises — logging must not break a call.

    `cid` identifies the client session. Several tabs (or a second browser) can
    be connected at once and each mirrors its own view of events, so without the
    tag the file looks like everything happened twice.
    """
    try:
        tag = f"({cid})" if cid else "(--)"
        with _log_lock:
            _trim_log()
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {tag} [{level}] {msg}\n")
    except Exception:
        pass


def _trim_log() -> None:
    """Drop lines older than LOG_MAX_AGE_S. Caller holds _log_lock.

    Checked at most once a minute, so the read is amortised across writes rather
    than done per line. The file is rewritten only when something is actually
    dropped, and the rewrite is atomic so a crash cannot lose the whole log.
    """
    global _log_trimmed
    now = time.time()
    if now - _log_trimmed < 60:
        return
    _log_trimmed = now
    try:
        cutoff = now - LOG_MAX_AGE_S
        with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        keep = []
        for ln in lines:
            # "2026-10-13 21:16:35 (ab12) [sys] ..."
            try:
                ts = time.mktime(time.strptime(ln[:19], "%Y-%m-%d %H:%M:%S"))
            except Exception:
                keep.append(ln)      # unparseable: keep rather than discard
                continue
            if ts >= cutoff:
                keep.append(ln)
        if len(keep) != len(lines):
            tmp = LOG_FILE + ".trim"
            with open(tmp, "w", encoding="utf-8") as f:
                f.writelines(keep)
            os.replace(tmp, LOG_FILE)
    except FileNotFoundError:
        pass
    except Exception:
        pass


_log_trimmed = 0.0


app = FastAPI(title="Voisa Local", docs_url=None, redoc_url=None, openapi_url=None)


# static frontend
def _asset_version() -> str:
    """mtime stamp of the newest UI asset; busts the browser cache on edit."""
    try:
        newest = max(os.path.getmtime(os.path.join(UI_DIR, f))
                     for f in ("style.css", "app.js", "index.html")
                     if os.path.exists(os.path.join(UI_DIR, f)))
        return str(int(newest))
    except Exception:
        return "0"


# No web auth: localhost-only service, open access. The master switch is the gate.

# Signing key for the session cookie.
#
# This MUST be stable across restarts. Generating a fresh key per boot
# invalidated every cookie, so each restart (and every `systemctl restart`)
# forced you to log in again. It is persisted next to the app, mode 600, and
# created on first use. VOISA_SECRET overrides it.
SECRET = b""


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(UI_DIR, "index.html")) as f:
        html = f.read()
    # stamp the asset URLs so an edited style.css/app.js is never served stale
    v = _asset_version()
    html = html.replace("/static/style.css", f"/static/style.css?v={v}")
    html = html.replace("/static/app.js", f"/static/app.js?v={v}")
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})

if os.path.isdir(UI_DIR):
    app.mount("/static", StaticFiles(directory=UI_DIR), name="static")


# REST
@app.get("/api/state")
async def state():
    # Identity is per-session now: each browser session holds its own identity
    # (in localStorage) and supplies it on connect. This endpoint deliberately
    # does NOT return a shared account cookie — serving one here is exactly what
    # made identity global, and on a network-reachable page it also handed the
    # bearer credential to anyone who asked.
    return {"has_account": False, "per_session": True}


@app.post("/api/new")
async def api_new():
    # Lease an identity from the pool rather than always minting a fresh one.
    #
    # A brand-new account created seconds before a call is the anomaly: no
    # history, createdAt clustered with the call, and previously stamped
    # "voisa-py-". An aged, reused account looks like a returning user.
    #
    # Not adopted as the stored default, for the same reason as api_login:
    # concurrent tabs and legs each need their own identity.
    # Never lease an identity another live session is already using — that is
    # exactly how two tabs ended up showing the same "new" identity.
    entry = voisa.pool_lease(log=lambda m: logfile(m, "pool"),
                             exclude=_cookies_in_use())
    return {"deviceId": entry["deviceId"], "cookie": entry["cookie"]}


# log file
# One file per recording SESSION, not per chunk.
#
# MediaRecorder emits one webm as a first chunk carrying the EBML header plus
# subsequent header-less clusters. Writing each chunk to its own file produced
# fragments that ffprobe rejects with "EBML header parsing failed" - which is
# exactly the broken download that was reported. So chunks are appended to a
# single open session file per leg.
_REC_SESSIONS = {}          # leg -> {"path", "started", "bytes", "chunks"}


@app.post("/api/mitm/rec/{leg}")
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


@app.post("/api/mitm/rec/{leg}/stop")
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


# Below this a recording cannot hold a decodable stream (an aborted start, or a
# peer that never sent audio). Stubs are deleted rather than listed, so the UI
# never offers a download that will not play.
REC_MIN_BYTES = 2048


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


@app.get("/api/mitm/rec")
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


@app.get("/api/mitm/rec/{name}")
async def api_rec_get(name: str):
    # no traversal: basename only, and only our own naming
    if os.path.basename(name) != name or not name.startswith("mitm-"):
        raise HTTPException(400, "bad name")
    p = os.path.join(REC_DIR, name)
    if not os.path.isfile(p):
        raise HTTPException(404, "not found")
    media = "audio/webm" if name.endswith(".webm") else "application/octet-stream"
    return FileResponse(p, filename=name, media_type=media)


@app.delete("/api/mitm/rec/{name}")
async def api_rec_del(name: str):
    if os.path.basename(name) != name or not name.startswith("mitm-"):
        raise HTTPException(400, "bad name")
    p = os.path.join(REC_DIR, name)
    try:
        os.remove(p)
    except FileNotFoundError:
        raise HTTPException(404, "not found")
    return {"deleted": name}


@app.get("/api/pool")
async def api_pool():
    """Identifier pool: aged identities reused across calls."""
    return {"entries": voisa.pool_status()}


@app.get("/api/saved")
async def api_saved_list():
    return {"entries": saved_status()}


@app.post("/api/saved")
async def api_saved_add(body: dict = None):
    b = body or {}
    did, cookie = str(b.get("deviceId", "")), str(b.get("cookie", ""))
    if not did or not cookie:
        return JSONResponse({"error": "deviceId and cookie required"}, status_code=400)
    saved_add(did, cookie, b.get("username"))
    logfile(f"[saved] identity {did} stored", "sys")
    return {"saved": did}


@app.post("/api/saved/use")
async def api_saved_use(body: dict = None):
    did = str((body or {}).get("deviceId", ""))
    e = saved_take(did)
    if not e:
        return JSONResponse({"error": "not saved"}, status_code=404)
    logfile(f"[saved] identity {did} adopted", "sys")
    return {"deviceId": e["deviceId"], "cookie": e["cookie"], "username": e.get("username")}


@app.delete("/api/saved/{device_id}")
async def api_saved_del(device_id: str):
    return {"removed": saved_remove(device_id)}


@app.post("/api/pool/add")
async def api_pool_add(body: dict = None):
    n = int((body or {}).get("n", 1))
    n = max(1, min(n, 20))
    made = voisa.pool_add(n, log=lambda m: logfile(m, "pool"))
    return {"added": [e["deviceId"] for e in made], "total": len(voisa.load_pool())}


@app.delete("/api/pool/{device_id}")
async def api_pool_remove(device_id: str):
    ok = voisa.pool_remove(device_id, log=lambda m: logfile(m, "pool"))
    if not ok:
        raise HTTPException(404, "no such identity")
    return {"removed": device_id, "total": len(voisa.load_pool())}


@app.post("/api/pool/clear")
async def api_pool_clear():
    n = voisa.pool_clear(log=lambda m: logfile(m, "pool"))
    return {"cleared": n}


@app.post("/api/pool/resolve_names")
async def api_pool_resolve_names():
    """Backfill missing nicknames: one short socket connection per entry."""
    resolved = await asyncio.get_event_loop().run_in_executor(
        None, lambda: voisa.pool_resolve_names(
            log=lambda m: logfile(m, "pool")))
    return {"resolved": resolved, "total": len(voisa.load_pool())}


@app.get("/api/log")
async def get_log(lines: int = 500):
    try:
        with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            data = f.readlines()
    except FileNotFoundError:
        data = []
    tail = data[-max(1, min(lines, 20000)):]
    return {"path": LOG_FILE,
            "total_lines": len(data),
            "bytes": os.path.getsize(LOG_FILE) if os.path.exists(LOG_FILE) else 0,
            "lines": [l.rstrip("\n") for l in tail]}


@app.delete("/api/log")
async def clear_log():
    try:
        os.remove(LOG_FILE)
    except FileNotFoundError:
        pass
    return {"cleared": True}


@app.get("/api/log/download")
async def download_log():
    if not os.path.exists(LOG_FILE):
        raise HTTPException(status_code=404, detail="no log yet")
    return FileResponse(LOG_FILE, filename="voisa.log", media_type="text/plain")


# recordings
MEDIA_DIR = os.path.join(HERE, "media")
REC_DIR = os.path.join(HERE, "recordings")


def _rec_entry(name: str) -> dict:
    p = os.path.join(MEDIA_DIR, name)
    st = os.stat(p)
    return {"name": name, "bytes": st.st_size, "mtime": int(st.st_mtime),
            "kind": "audio" if name.endswith(".wav") else "video"}


@app.get("/api/recordings")
async def recordings():
    try:
        names = [n for n in os.listdir(MEDIA_DIR)
                 if n.startswith("incoming-") and n.endswith((".wav", ".ivf"))]
    except FileNotFoundError:
        names = []
    out = []
    for n in names:
        try:
            out.append(_rec_entry(n))
        except OSError:
            pass
    out.sort(key=lambda e: e["mtime"], reverse=True)
    # deliberately no "dir": this endpoint is reachable over the public site and
    # the absolute path leaked the server's filesystem layout. The UI does not
    # need it; recordings are fetched by name from /api/recordings/{name}.
    return {"files": out, "total_bytes": sum(e["bytes"] for e in out)}


@app.get("/api/recordings/{name}")
async def recording_file(name: str):
    # no path traversal: only the basename, only our own naming
    if os.path.basename(name) != name or not name.startswith("incoming-"):
        raise HTTPException(status_code=400, detail="bad name")
    p = os.path.join(MEDIA_DIR, name)
    if not os.path.isfile(p):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, filename=name,
                        media_type="audio/wav" if name.endswith(".wav") else "video/x-ivf")


@app.delete("/api/recordings/{name}")
async def recording_delete(name: str):
    if os.path.basename(name) != name or not name.startswith("incoming-"):
        raise HTTPException(status_code=400, detail="bad name")
    p = os.path.join(MEDIA_DIR, name)
    try:
        os.remove(p)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": name}


@app.delete("/api/recordings")
async def recordings_clear():
    n = 0
    try:
        for name in os.listdir(MEDIA_DIR):
            if name.startswith("incoming-") and name.endswith((".wav", ".ivf")):
                os.remove(os.path.join(MEDIA_DIR, name))
                n += 1
    except FileNotFoundError:
        pass
    return {"deleted": n}


@app.post("/api/login")
async def api_login(body: dict):
    did = (body or {}).get("deviceId")
    if not did:
        raise HTTPException(400, "deviceId required")
    acct = voisa.create_account(did)
    # Do NOT overwrite the stored account here. Logging a second tab in would
    # otherwise hijack the first tab's identity — two relays would collapse onto
    # one account and fight over the same match. The cookie is returned so the
    # caller can adopt it for its own session only. Use the "make default"
    # action if you actually want to change what a fresh page load uses.
    return {"deviceId": did, "cookie": acct["cookie"]}


# websocket bridge
# Every live browser session, so an admin action can reach all of them. Without
# this there is no way to find the other tabs: each Session is created inline in
# the websocket handler and dropped when that socket closes.
_SESSIONS = set()


def _cookies_in_use(exclude: "Session | None" = None) -> set:
    """Every Voisa identity currently held by a live browser session — its
    main identity and both relay legs. Identity is per session, so nothing on
    this list may be handed to another session."""
    used = set()
    for s in _SESSIONS:
        if s is exclude:
            continue
        if s.cookie:
            used.add(s.cookie)
        for b in s.legs.values():
            c = getattr(b, "cookie", None)
            if c:
                used.add(c)
    return used


class Session:
    """One browser tab <-> one Voisa socket connection."""

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.sio = None
        self.cookie = None
        self.match_id = None
        self.gen = 0               # client session generation, echoed on every msg
        self.cid = uuid.uuid4().hex[:4]   # short id so parallel tabs are separable
        self._ice_counts = {}      # candidate type -> count, for log summarising
        self._ice_total = 0
        self._ice_last = 0.0
        self.loop = asyncio.get_event_loop()
        self.call = None          # voisa_call.VoisaCall when a call is active
        # MITM relays. Each leg is its OWN BridgeCall with its OWN cookie, so
        # two legs never share an account or a match. Kept separate from
        # self.call so the client view and the MITM view cannot disturb
        # each other.
        self.legs = {}            # "A"/"B" -> BridgeCall
        self.detached = False     # browser ws gone but the call may still run

    async def send(self, kind: str, **kw):
        if self.detached:
            return
        try:
            await self.ws.send_json({"kind": kind, "t": time.time(),
                                     "gen": self.gen, **kw})
        except Exception:
            pass


    async def log(self, msg: str, level: str = "sys"):
        logfile(msg, level, cid=self.cid)   # persist to voisa.log
        await self.send("log", text=str(msg), level=level)

    # new socket.io client     # noqa: E301
    def make_client(self):
        import socketio
        sio = socketio.Client(reconnection=True, request_timeout=30)

        def _schedule(coro):
            self.loop.call_soon_threadsafe(asyncio.ensure_future, coro)

        @sio.event
        def connect():
            _schedule(self.send("status", state="connected", sid=sio.sid))

        @sio.event
        def disconnect(reason=None):
            _schedule(self.send("status", state="disconnected", reason=str(reason)))

        def mk(ev):
            def h(*a):
                _schedule(self._on_event(ev, a[0] if a else None))
            return h

        for ev in voisa.SERVER_EVENTS:
            sio.on(ev, mk(ev))
        return sio


    async def _on_event(self, ev, payload):
        if ev == "fetch-initial-data" and isinstance(payload, dict):
            self.ice_servers = payload.get("iceServers", [])
            await self.send("event", event=ev, payload=payload)
            await self.send("session", user=payload.get("userData", {}),
                            searchLanguages=payload.get("searchLanguages", {}),
                            banStatus=payload.get("banStatus"),
                            # the browser is the WebRTC peer, so it needs these
                            iceServers=payload.get("iceServers", []))
            return
        if ev == "start-dialog" and isinstance(payload, dict):
            self.match_id = payload.get("matchId")
        if ev == "close-dialog":
            # ignore a close for a match we are not in (stale replay). Compare
            # unconditionally: requiring self.match_id to be set made this fail
            # open right after start-search, which is when the replay arrives.
            closed = (payload or {}).get("matchId") if isinstance(payload, dict) else None
            if closed != self.match_id:
                return
            self.match_id = None

        # `webrtc` now carries SDP and ICE that the BROWSER must handle: it owns
        # the peer connection, so these go through untouched. Only the log gets
        # a summary, to keep 20+ candidates per dialog from burying the feed.
        if ev == "webrtc" and isinstance(payload, dict) and payload.get("iceCandidate"):
            cand = payload["iceCandidate"].get("candidate", "")
            typ = next((t for t in ("relay", "srflx", "prflx", "host")
                        if f"typ {t}" in cand), "?")
            self._ice_counts[typ] = self._ice_counts.get(typ, 0) + 1
            self._ice_total += 1
            now = time.time()
            if now - self._ice_last >= 5.0:
                self._ice_last = now
                summ = " ".join(f"{k}={v}" for k, v in sorted(self._ice_counts.items()))
                await self.send("log", level="sys",
                                text=f"[ice] peer candidates: {self._ice_total} ({summ})")

        # pass SDP and ICE to the browser verbatim; it is the WebRTC peer now
        if ev == "webrtc":
            await self.send("webrtc", payload=payload, matchId=self.match_id)
            return

        await self.send("event", event=ev, payload=payload)

    async def connect(self, cookie: str):
        self.cookie = cookie
        self.sio = self.make_client()
        q = (f"?cookie={cookie}&version={voisa.APP_VERSION}&platform={voisa.PLATFORM}"
             f"&rawLanguage=en-GB&language=en&currentTheme=system")
        # socket.io blocks; run in a thread
        await self.loop.run_in_executor(None, lambda: self.sio.connect(
            voisa.SERVER + "/" + q, transports=["websocket", "polling"],
            wait_timeout=20, socketio_path=voisa.SOCK_PATH))
        # no account identifier here: this line is streamed to the browser and
        # persisted in its log history, and the cookie prefix is the account's
        # public handle
        await self.log("connected")

    async def emit(self, event: str, payload: dict):
        if not self.sio:
            await self.log("not connected")
            return
        await self.loop.run_in_executor(None, lambda: self.sio.emit(event, payload or {}))
        await self.send("sent", event=event, payload=payload)

    async def hangup(self):
        if self.match_id:
            await self.emit("close-dialog", {"matchId": self.match_id})
        self.match_id = None

    async def stop_call(self):
        if self.call:
            await self.call.stop()

    async def detach(self):
        """Drop the browser WS without touching a running call."""
        self.detached = True
        if self.call:
            # keep the call alive; just stop forwarding events to a dead socket
            self.call.on_log = lambda m: logfile(m, "sys", cid=self.cid)
            self.call.on_state = lambda **kw: None
            logfile("browser ws closed; call continues", "sys", cid=self.cid)
        else:
            await self.close()

    async def close(self):
        await legs_stop_all(self)
        await self.stop_call()
        if self.sio:
            await self.loop.run_in_executor(None, self.sio.disconnect)
            self.sio = None


# call integration (aiortc)
async def start_call(sess: Session, lang: str, seconds, send_media: bool,
                     audio_file, record: bool = False, search: bool = True):
    import voisa_call
    if sess.call:
        await sess.call.stop()

    bridge = voisa_call.BridgeCall(sess.cookie, lang, seconds,
                                   send_media=send_media, audio_file=audio_file,
                                   outdir=os.path.join(HERE, "media"),
                                   play_audio=True, record=record,
                                   browser_peer=True)
    # BridgeCall may call these from any thread; hop back onto the UI loop.
    main_loop = asyncio.get_event_loop()

    def _fire(coro_factory):
        try:
            asyncio.run_coroutine_threadsafe(coro_factory(), main_loop)
        except Exception:
            pass

    sess._ice_counts = {}      # fresh counters per call
    sess._ice_total = 0
    sess._ice_last = 0.0
    bridge.on_log = lambda m: _fire(lambda: sess.log(m))
    bridge.on_state = lambda **kw: _fire(lambda: sess.send("call", **kw))
    sess.call = bridge
    if search:
        await bridge.start()
    else:
        # attach without emitting start-search: we are joining a dialog that is
        # already pending, so just listen and negotiate when it arrives
        await bridge.start_listen()


# MITM legs
async def leg_start(sess: Session, leg: str, cookie: str, device_id: str,
                    lang: str, seconds):
    """Start (or restart) one MITM relay leg with its own identity."""
    import voisa_call
    await leg_stop(sess, leg)

    if not cookie:
        await sess.send("mitm", leg=leg, what="log", text="no identity for leg")
        return

    bridge = voisa_call.BridgeCall(cookie, lang, seconds,
                                   send_media=False, audio_file=None,
                                   outdir=os.path.join(HERE, "media"),
                                   play_audio=False, record=False,
                                   browser_peer=True)
    bridge.device_id = device_id
    bridge.requeue_on_close = True
    main_loop = asyncio.get_event_loop()

    def _fire(coro_factory):
        try:
            asyncio.run_coroutine_threadsafe(coro_factory(), main_loop)
        except Exception:
            pass

    def _share_names():
        """Give every leg the names of all our legs, so any leg can spot a
        match with one of its own. Runs whenever a leg learns its name.

        Also the only point where a leg's server-assigned nickname becomes
        known: fetch-initial-data arrives over the socket after the entry was
        leased, so the pool entry has no username until now. Save it so the
        identities panel can show names, and push it to the browser so the
        leg's "relay identity" row fills in instead of sitting on "…".
        """
        for key, b in sess.legs.items():
            name = getattr(b, "username", None)
            if name:
                did = getattr(b, "device_id", None) or device_id
                try:
                    voisa.pool_set_username(
                        name, device_id=did,
                        cookie=getattr(b, "cookie", None),
                        log=lambda m: logfile(m, "pool"))
                except Exception:
                    pass
                _fire(lambda k=key, n=name, d=did: sess.send(
                    "mitm", leg=k, what="identity", deviceId=d, username=n))

        names = {getattr(b, "username", None) for b in sess.legs.values()}
        for b in sess.legs.values():
            b.own_names = names - {getattr(b, "username", None) or ""}
            if b.own_names:
                b._log(f"[loopback] know our other legs: {sorted(b.own_names)}")


    bridge.on_reconcile = _share_names
    bridge.on_log = lambda m: _fire(lambda: sess.send("mitm", leg=leg, what="log", text=m))

    def _leg_state(**kw):
        def emit():
            if kw.get("phase") == "webrtc":
                return sess.send("mitm", leg=leg, what="signal",
                                 payload=kw.get("webrtc") or {})
            return sess.send("mitm", leg=leg, what="call", **kw)
        _fire(emit)
    bridge.on_state = _leg_state

    sess.legs[leg] = bridge
    await bridge.start()
    await sess.send("mitm", leg=leg, what="identity", deviceId=device_id,
                    username=getattr(bridge, "username", None))


async def leg_stop(sess: Session, leg: str):
    b = sess.legs.pop(leg, None)
    if b:
        try:
            await b.stop()
        except Exception:
            pass


async def legs_stop_all(sess: Session):
    for leg in list(sess.legs):
        await leg_stop(sess, leg)


async def leg_signal(sess: Session, leg: str, msg: dict):
    """SDP/ICE from the browser for one leg, forwarded to that leg's peer."""
    b = sess.legs.get(leg)
    if not b:
        await sess.send("mitm", leg=leg, what="log", text="no such leg")
        return
    b.ui_webrtc(msg)


def _shuffle(cookie: str):
    """Blocking nickname shuffle — runs off the event loop."""
    try:
        return voisa.shuffle_username(cookie, log=lambda *_: None)
    except Exception as e:
        return {"code": f"{type(e).__name__}: {e}"}


async def _dispatch(sess: "Session", msg: dict) -> None:
    """Handle one browser command. Split out of the socket loop so a single
    failing command (e.g. the Voisa server refusing a socket connect) is
    reported to the UI instead of crashing the whole session handler."""
    cmd = msg.get("cmd")

    if cmd == "connect":
        # bump generation first so stale events from the old socket are
        # dropped by the UI
        if msg.get("gen") is not None:
            sess.gen = int(msg["gen"])
        did = msg.get("deviceId")
        # An explicit cookie lets each browser tab hold its OWN identity
        # instead of everyone sharing the one stored account. This is
        # what makes two isolated relays possible: tab A is one Voisa
        # identity, tab B is another, and they never collide.
        cookie = msg.get("cookie")
        if cookie:
            # the browser session remembered its own identity — use it
            acct = {"deviceId": did or "", "cookie": cookie}
        elif did:
            # a remembered deviceId with no cookie: re-fetch it (does
            # not touch the shared global store)
            acct = voisa.register(did)
        else:
            # no identity at all: mint a FRESH one bound to this session,
            # never the global voisa_account.json default. The browser
            # persists what comes back on the `account` message, so a
            # reload keeps the same identity instead of minting again.
            acct = voisa.create_fresh()

        # Identity is PER SESSION. If the identity this tab asked for is
        # already held by another live session (a duplicated tab, a second
        # tab in the same browser, a stale copy), do not share it: give this
        # session its own fresh one instead.
        if acct.get("cookie") and acct["cookie"] in _cookies_in_use(exclude=sess):
            await sess.log("that identity is in use by another session — "
                           "this session gets its own", "warn")
            acct = voisa.create_fresh()

        # Only tear down when the identity is actually changing. A plain
        # page load also sends `connect`; closing unconditionally killed
        # a call that was already in progress (and a peer arriving one
        # second later found a dead session).
        same_identity = (sess.cookie == acct["cookie"])
        if (sess.call or sess.sio) and not same_identity:
            try:
                await sess.close()
            except Exception:
                pass
        elif same_identity and sess.sio:
            # already connected as this identity — don't reconnect and
            # don't disturb a live call
            await sess.send("account", **acct)
            await sess.log("already connected (identity unchanged)")
            return
        await sess.send("account", **acct)
        await sess.connect(acct["cookie"])

    elif cmd == "emit":
        await sess.emit(msg.get("event"), msg.get("payload") or {})

    elif cmd == "search":
        # language is its own event; start-search takes no payload.
        # We still need a bridge BEFORE matching starts: the browser
        # sends its SDP/ICE through sess.call, and by the time a
        # start-dialog arrives the offer is already in flight.
        lang = msg.get("lang", "en")
        if not sess.call:
            await start_call(sess, lang, int(msg.get("seconds") or 0),
                             False, None, False, search=False)
        await sess.emit("set-search-language", {"searchLanguage": lang})
        await sess.emit("start-search", {})

    elif cmd == "accept":
        # Accepting a pending dialog only makes sense if something can
        # negotiate the media. If no BridgeCall is attached, start one in
        # "accept-only" mode: it waits for the incoming start-dialog
        # instead of searching, then answers/offers as appropriate.
        mid = msg.get("matchId") or sess.match_id
        if sess.call:
            await sess.emit("start-dialog", {"initiate": True, "matchId": mid})
        else:
            await sess.log("accept: no call attached — starting one to "
                           "handle the pending dialog")
            await start_call(sess, msg.get("lang", "en"),
                             int(msg.get("seconds") or 0),
                             bool(msg.get("media", True)),
                             msg.get("audioFile"),
                             bool(msg.get("record", False)),
                             search=False)

    elif cmd == "hangup":
        await sess.hangup()

    elif cmd == "bufferdialog":
        # dialog ack: match | decline | accept
        await sess.emit("buffer-dialog",
                        {"event": msg.get("event", "match")})

    elif cmd == "shuffle":
        # server-assigned nickname change; premium accounts only
        ack = await sess.loop.run_in_executor(None, _shuffle, sess.cookie)
        if isinstance(ack, dict) and ack.get("code"):
            await sess.log(f"shuffle-username refused: {ack['code']}", "err")
        elif ack:
            await sess.log(f"new username: {ack}", "match")
        else:
            await sess.log("shuffle-username: no reply", "err")

    elif cmd == "call":
        await start_call(sess, msg.get("lang", "en"), int(msg.get("seconds") or 0),
                         bool(msg.get("media", True)), msg.get("audioFile"),
                         bool(msg.get("record", False)))

    elif cmd == "record":
        # toggle recording on a LIVE call (the record button)
        want = bool(msg.get("on", True))
        if not sess.call:
            await sess.log("no active call to record", "err")
        elif want:
            ok = sess.call.start_recording()
            await sess.send("recording", on=True, ok=bool(ok))
            await sess.log("recording started" if ok
                           else "already recording", "match")
        else:
            n = await sess.call.stop_recording()
            await sess.send("recording", on=False, files=n)
            await sess.log(f"recording stopped ({n} file(s))", "match")

    elif cmd == "mitm":
        # leg control for the MITM view: start/stop a leg, or hand a
        # leg the browser's SDP/ICE
        # accept "A"/"B" or a "leg-A"/"leg-B" element id, so a
        # frontend slip cannot silently reject every leg message
        leg = str(msg.get("leg") or "").upper().removeprefix("LEG-")
        act = msg.get("act")
        if leg not in ("A", "B"):
            await sess.log("mitm: bad leg", "err")
        elif act == "start":
            await leg_start(sess, leg, msg.get("cookie"),
                            msg.get("deviceId"), msg.get("lang", "en"),
                            msg.get("seconds") or 0)
        elif act == "stop":
            await leg_stop(sess, leg)
            await sess.send("mitm", leg=leg, what="call", phase="idle", matchId=None)
        elif act == "signal":
            await leg_signal(sess, leg, msg)
        else:
            await sess.log(f"mitm: bad act {act!r}", "err")

    elif cmd == "webrtc":
        # The BROWSER owns the peer connection, so its SDP/ICE goes
        # straight out to the Voisa peer.
        if not sess.call:
            await sess.log("webrtc: no active call", "err")
        else:
            sess.call.ui_webrtc(msg)

    elif cmd == "stopcall":
        await sess.stop_call()

    elif cmd == "logline":
        # the UI can persist its own client-side lines to the same file
        logfile(str(msg.get("text", "")), msg.get("level", "ui"), cid=sess.cid)

    elif cmd == "ping":
        await sess.send("pong")

    else:
        await sess.log(f"unknown cmd: {cmd}")


@app.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    sess = Session(websocket)
    _SESSIONS.add(sess)
    await sess.log("ready")
    try:
        while True:
            msg = await websocket.receive_json()
            if not isinstance(msg, dict):
                continue
            try:
                await _dispatch(sess, msg)
            except (WebSocketDisconnect, asyncio.CancelledError):
                raise
            except Exception as e:
                import traceback as _tb
                logfile(f"cmd {msg.get('cmd')!r} failed: " + _tb.format_exc(), "err", cid=sess.cid)
                await sess.log(f"{msg.get('cmd')} failed: {type(e).__name__}: {e}", "err")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        # starlette raises a distinct WebSocketDisconnected (trailing 'd') when
        # the socket closes mid-receive — a normal disconnect, not a crash.
        # Fall through to finally (detach), just don't log it as a crash.
        from starlette.websockets import WebSocketDisconnected as _WSD
        if not isinstance(e, _WSD):
            # log the FULL traceback to the file: a bare message like
            # "name 'x' is not defined" is useless without knowing where.
            import traceback as _tb
            logfile("WS HANDLER CRASH: " + _tb.format_exc(), "err", cid=sess.cid)
            try:
                await sess.send("log", text=f"error: {e}")
            except Exception:
                pass
    finally:
        _SESSIONS.discard(sess)
        # The socket.io connection is owned by the SERVER, not by this browser
        # tab. Closing the tab (or reloading it) must not tear down a call that
        # is in progress, so only the browser-facing WS is dropped here. The
        # call keeps running and is cleaned up by its own timer or by an
        # explicit `stopcall`.
        await sess.detach()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1", help="localhost only (do not change)")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()

    if a.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"refusing to bind {a.host}: this UI is localhost-only")
        sys.exit(2)

    import uvicorn
    print(f"Voisa local UI -> http://{a.host}:{a.port}  (localhost only)")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()
