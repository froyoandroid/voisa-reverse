"""Browser sessions: one tab <-> one upstream Voisa signalling socket."""
import asyncio, time, uuid

from fastapi import WebSocket

import voisa
from voisa_server.logs import logfile
from voisa_server.relay import legs_stop_all

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
    """One browser tab <-> one upstream Voisa socket.

    The browser is the WebRTC peer, so this process is only a signalling relay:
    a single asyncio socket.io client per tab carries matchmaking events and the
    SDP/ICE between the browser and the Voisa server. There is deliberately no
    second socket per call: two sockets on one identity raced each other for
    start-dialog and could drop the browser's offer and candidates.
    """

    CONNECT_ATTEMPTS = 4

    def __init__(self, ws: WebSocket):
        self.ws = ws
        self.sio = None            # socketio.AsyncClient
        self.cookie = None
        self.match_id = None
        self._accepted = None      # matchId we already accepted
        self.gen = 0               # client session generation, echoed on every msg
        self.cid = uuid.uuid4().hex[:4]   # short id so parallel tabs are separable
        self._ice_counts = {}
        self._ice_total = 0
        self._ice_last = 0.0
        self.ice_servers = []
        self.loop = asyncio.get_event_loop()
        self.call = None           # server-side aiortc call (legacy `call` cmd only)
        # MITM relays: each leg is its OWN BridgeCall with its OWN identity
        self.legs = {}             # "A"/"B" -> BridgeCall
        self.detached = False
        self._send_lock = asyncio.Lock()

    async def send(self, kind: str, **kw):
        if self.detached:
            return
        try:
            async with self._send_lock:
                await self.ws.send_json({"kind": kind, "t": time.time(),
                                         "gen": self.gen, **kw})
        except Exception:
            pass

    async def log(self, msg: str, level: str = "sys"):
        logfile(msg, level, cid=self.cid)   # persist to voisa.log
        await self.send("log", text=str(msg), level=level)

    # upstream socket
    def _make_client(self):
        import socketio
        sio = socketio.AsyncClient(reconnection=True, reconnection_delay=1,
                                   reconnection_delay_max=8, request_timeout=20)

        @sio.event
        async def connect():
            await self.send("status", state="connected", sid=sio.sid)

        @sio.event
        async def disconnect(reason=None):
            # the peer connection cannot survive a lost signalling channel
            await self._drop_match("socket lost")
            await self.send("status", state="disconnected", reason=str(reason))

        def handler(ev):
            async def h(*a):
                try:
                    await self._on_event(ev, a[0] if a else None)
                except Exception as e:
                    logfile(f"[{ev}] handler: {type(e).__name__}: {e}", "err", cid=self.cid)
            return h

        for ev in voisa.SERVER_EVENTS:
            sio.on(ev, handler(ev))
        return sio

    async def connect(self, cookie: str):
        await self.disconnect()
        self.cookie = cookie
        q = (f"?cookie={cookie}&version={voisa.APP_VERSION}&platform={voisa.PLATFORM}"
             f"&rawLanguage=en-GB&language=en&currentTheme=system")
        await self.send("status", state="connecting")
        last = None
        for attempt in range(1, self.CONNECT_ATTEMPTS + 1):
            sio = self._make_client()
            try:
                await sio.connect(voisa.SERVER + "/" + q, transports=["websocket"],
                                  socketio_path=voisa.SOCK_PATH, wait_timeout=15)
                self.sio = sio
                await self.log("connected")
                return
            except Exception as e:
                last = e
                try:
                    await sio.disconnect()
                except Exception:
                    pass
                if self.cookie != cookie or self.detached:
                    return          # superseded while we were retrying
                await self.log(f"connect attempt {attempt} failed: "
                               f"{type(e).__name__}: {e}", "warn")
                await asyncio.sleep(min(1.5 * attempt, 5))
        await self.send("status", state="offline")
        raise ConnectionError(f"Voisa unreachable after {self.CONNECT_ATTEMPTS} attempts: {last}")

    async def disconnect(self):
        sio, self.sio = self.sio, None
        await self._drop_match(None)
        if sio:
            try:
                await sio.disconnect()
            except Exception:
                pass

    async def emit(self, event: str, payload: dict, quiet: bool = False):
        if not self.sio or not self.sio.connected:
            await self.log(f"{event}: not connected", "err")
            return False
        await self.sio.emit(event, payload or {})
        if not quiet:
            await self.send("sent", event=event, payload=payload)
        return True

    # upstream events
    async def _on_event(self, ev, payload):
        d = payload if isinstance(payload, dict) else {}

        if ev == "fetch-initial-data":
            self.ice_servers = d.get("iceServers", [])
            await self.send("event", event=ev, payload=payload)
            await self.send("session", user=d.get("userData", {}),
                            searchLanguages=d.get("searchLanguages", {}),
                            banStatus=d.get("banStatus"),
                            iceServers=self.ice_servers)
            return

        if ev == "start-dialog":
            mid = d.get("matchId")
            self.match_id = mid
            self._ice_counts, self._ice_total, self._ice_last = {}, 0, 0.0
            await self.send("event", event=ev, payload=payload)
            await self._accept(mid)
            await self.send("call", phase="matched", matchId=mid,
                            peer=d.get("username"), avatar=d.get("avatar"),
                            initiate=bool(d.get("initiate")))
            # the browser builds the SDP; tell it whether it offers
            await self.send("call", phase="negotiate", matchId=mid,
                            offer=bool(d.get("initiate")))
            return

        if ev == "close-dialog":
            # ignore a close for a match we are not in (a stale replay right
            # after start-search is common)
            if d.get("matchId") != self.match_id:
                return
            self.match_id = None
            self._accepted = None
            await self.send("event", event=ev, payload=payload)
            await self.send("call", phase="closed", matchId=None)
            return

        if ev == "webrtc":
            if d.get("matchId") and self.match_id and d["matchId"] != self.match_id:
                return              # signalling for a match we already left
            if d.get("iceCandidate"):
                self._count_ice(d["iceCandidate"].get("candidate", ""))
                if time.time() - self._ice_last >= 5.0:
                    self._ice_last = time.time()
                    summ = " ".join(f"{k}={v}" for k, v in sorted(self._ice_counts.items()))
                    await self.send("log", level="sys",
                                    text=f"[ice] peer candidates: {self._ice_total} ({summ})")
            await self.send("webrtc", payload=payload, matchId=self.match_id)
            return

        await self.send("event", event=ev, payload=payload)

    def _count_ice(self, cand: str):
        typ = next((t for t in ("relay", "srflx", "prflx", "host") if f"typ {t}" in cand), "?")
        self._ice_counts[typ] = self._ice_counts.get(typ, 0) + 1
        self._ice_total += 1

    async def _accept(self, mid):
        """Accept a dialog exactly once (the browser also asks, after its
        start-dialog event; a second accept is noise the server can misread)."""
        if not mid or self._accepted == mid:
            return
        self._accepted = mid
        await self.emit("start-dialog", {"initiate": True, "matchId": mid})

    # call control
    async def search(self, lang: str):
        await self._drop_match(None)
        if not await self.emit("set-search-language", {"searchLanguage": lang}):
            await self.send("call", phase="idle", matchId=None)
            return
        await self.emit("start-search", {})
        await self.send("call", phase="searching", matchId=None)

    async def browser_webrtc(self, msg: dict):
        """SDP/ICE from the browser -> the peer, tagged with the live match."""
        if not self.match_id:
            return                  # call already over; late candidate
        out = {"matchId": self.match_id}
        for k in ("offer", "answer", "iceCandidate"):
            if k in msg:
                out[k] = msg[k]
                break
        else:
            return
        await self.emit("webrtc", out, quiet=True)

    async def _drop_match(self, why):
        """Leave the current match (if any) without touching the socket."""
        mid, self.match_id, self._accepted = self.match_id, None, None
        if mid and self.sio and self.sio.connected and why is None:
            try:
                await self.sio.emit("close-dialog", {"matchId": mid})
            except Exception:
                pass

    async def hangup(self):
        await self._drop_match(None)
        await self.send("call", phase="idle", matchId=None)

    async def stop_call(self):
        if self.call:
            try:
                await self.call.stop()
            except Exception:
                pass
            self.call = None
        await self._drop_match(None)
        if self.sio and self.sio.connected:
            try:
                await self.sio.emit("stop-search", {})
            except Exception:
                pass
        await self.send("call", phase="idle", matchId=None)

    async def close(self):
        """Browser tab gone. Its RTCPeerConnections died with it, so nothing
        upstream is worth keeping: leave the match, close every socket."""
        self.detached = True
        await legs_stop_all(self)
        if self.call:
            try:
                await self.call.stop()
            except Exception:
                pass
            self.call = None
        await self.disconnect()
