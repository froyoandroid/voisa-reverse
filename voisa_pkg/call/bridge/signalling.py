"""BridgeCall part: Socket, matchmaking events and SDP/ICE relay."""
import asyncio

from aiortc import RTCSessionDescription

from voisa_pkg.webrtc import parse_ice_candidate
from voisa_pkg.protocol import SERVER as _SERVER, SOCK_PATH as _SOCK_PATH, APP_VERSION as _APP_VERSION, PLATFORM as _PLATFORM



class SignallingMixin:
    """Socket, matchmaking events and SDP/ICE relay. Mixed into BridgeCall; uses its state."""

    async def _connect_socket(self):
        """Wire up the socket.io client and connect. Shared by start() and
        start_listen()."""
        import socketio
        self._loop = asyncio.get_event_loop()
        sio = socketio.Client(reconnection=True, request_timeout=30)
        self.sio = sio

        @sio.event
        def connect():
            self._log(f"[socket] connected sid={sio.sid}")

        @sio.event
        def disconnect(reason=None):
            self._log(f"[socket] disconnected: {reason}")

        sio.on("check-version", lambda *a: None)
        sio.on("fetch-initial-data", self._on_initial)
        sio.on("start-dialog", self._on_start_dialog)
        sio.on("close-dialog", self._on_close_dialog)
        sio.on("webrtc", self._on_webrtc)
        sio.on("buffer-dialog", lambda *a: self._log(f"[buffer-dialog] {a}"))

        q = (f"?cookie={self.cookie}&version={_APP_VERSION}&platform={_PLATFORM}"
             f"&rawLanguage=en-GB&language=en&currentTheme=system")
        loop = asyncio.get_event_loop()
        # TLS handshakes to Voisa intermittently time out (server-side throttle
        # or network); a single failure used to kill the whole call request and
        # the UI sat on "Searching…" forever. Retry with backoff instead.
        last_err = None
        for attempt in range(3):
            try:
                await loop.run_in_executor(None, lambda: sio.connect(
                    _SERVER + "/" + q, transports=["websocket"],
                    wait_timeout=20, socketio_path=_SOCK_PATH))
                last_err = None
                break
            except Exception as e:
                last_err = e
                self._log(f"[socket] connect attempt {attempt + 1} failed: {e}")
                await asyncio.sleep(2 * (attempt + 1))
        if last_err is not None:
            raise last_err
        await asyncio.sleep(0.8)

    def _on_initial(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        self.ice_servers = d.get("iceServers", [])
        u = d.get("userData", {})
        if u.get("username") and u.get("username") != self.username:
            self.username = u.get("username")
            # tell the session so it can share this name with our other legs
            if self.on_reconcile:
                try:
                    self.on_reconcile()
                except Exception:
                    pass
        self._log(f"[session] user={u.get('username')} premium={u.get('premium')} "
                  f"ice={len(self.ice_servers)}")

    def _on_start_dialog(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        # loopback guard
        # If the peer's name is one of our OWN legs, the two relays have found
        # each other. Bridging them would feed each leg's audio into the other's
        # outbound — a closed loop that echoes and can run away. Refuse the
        # match and go back to searching instead of connecting.
        # log the full key set once per dialog: we need to know exactly what the
        # server discloses about the peer before relying on any of it
        self._log(f"[start-dialog] keys={sorted(d.keys())}")
        peer_name = d.get("username")
        if peer_name and peer_name in (self.own_names or ()):
            self._log(f"[loopback] refusing match with our own leg {peer_name!r} — "
                      "refusing to bridge a relay to itself")
            self.match_id = None
            self._state(phase="loopback", matchId=None, peer=peer_name)
            # decline this dialog, then look for someone else
            try:
                self.sio.emit("close-dialog", {"matchId": d.get("matchId")})
            except Exception:
                pass
            if self.on_loopback:
                try:
                    self.on_loopback(peer_name)
                except Exception:
                    pass
            self._schedule(self._requeue())
            return

        self.match_id = d.get("matchId")
        self.is_offerer = bool(d.get("initiate"))
        self.peer = d.get("username")
        self._log(f"[start-dialog] peer={d.get('username')} initiate={self.is_offerer}"
                  f" ({'we offer' if self.is_offerer else 'they offer'})")
        self._state(phase="matched", matchId=self.match_id, peer=d.get("username"),
                    avatar=d.get("avatar"), initiate=self.is_offerer)
        # Accept the dialog. This is required in BOTH directions: it tells the
        # server we are staying in the match.
        self.sio.emit("start-dialog", {"initiate": True, "matchId": self.match_id})
        if self.browser_peer:
            # The BROWSER owns the peer connection, so this process must not
            # create one: _after_match() -> _pc() would open a local audio
            # device and emit a competing server-side offer. Just tell the UI
            # who is offering; the browser builds the SDP itself.
            self._log("[rtc] browser peer owns negotiation"
                      f" ({'we offer' if self.is_offerer else 'they offer'})")
            self._state(phase="negotiate", matchId=self.match_id,
                        offer=bool(self.is_offerer))
        elif self.is_offerer:
            # the server made US the offerer -> build and send the SDP offer
            self._schedule(self._after_match())
        else:
            # THEY are the offerer -> we must NOT offer. Wait for their `webrtc`
            # offer and answer it in _handle_webrtc(). Offering here put both
            # sides in the offerer role, so no answer ever matched the offer and
            # the dialog timed out in 1-3 s -> the same peers kept re-queuing.
            self._log("[start-dialog] waiting for their offer (we are answerer)")
            self._schedule(self._after_match())

    def _on_close_dialog(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        closed = d.get("matchId")
        # Only a close for the match we are ACTUALLY in may stop us.
        #
        # The previous guard required self.match_id to be set before it would
        # check anything, so it failed open exactly when it mattered: on
        # start-search match_id is None, the server replays a close-dialog for
        # some earlier match, and we tore the new call down a second before the
        # peer arrived. Compare against the current id in both directions.
        if closed != self.match_id:
            self._log(f"[close-dialog] ignoring {closed} "
                      f"(we are in {self.match_id})")
            return
        self._log(f"[close-dialog] peer left ({closed})")
        self.match_id = None
        # A stop already in flight wins: stop() emits close-dialog itself,
        # and the server echoes it back. Without this the echo requeued a
        # leg the user just stopped — "press stop, it starts again later".
        if getattr(self, "_stopped", False):
            self._log("[close-dialog] ignoring echo (leg was stopped)")
            return
        # A relay leg must SURVIVE the peer hanging up. Stopping here emitted
        # `idle`, the UI tore the leg's audio bus down, and the OTHER leg lost
        # its feed — so one stranger leaving unbridged the whole setup. Instead
        # drop this match and go straight back to searching.
        if getattr(self, "requeue_on_close", False):
            self._state(phase="closed", matchId=None)
            self._schedule(self._requeue())
            return
        self._state(phase="closed", matchId=None)
        self._schedule(self.stop())

    async def _requeue(self):
        """Peer left: keep the leg alive and look for the next one."""
        # A requeue scheduled BEFORE stop() must die here: the close-dialog
        # passed the guard while match_id was still set, then stop() ran.
        # Without this the leg searches again seconds after the user stopped.
        if getattr(self, "_stopped", False):
            self._log("[requeue] cancelled (leg was stopped)")
            return
        try:
            await self._teardown_pc()
            if not self.sio:
                return
            self.sio.emit("start-search", {})
            self._log("[client] -> start-search (requeue after peer left)")
            self._state(phase="searching", matchId=None)
        except Exception as e:
            self._log(f"[requeue] failed: {type(e).__name__}: {e}")

    def _on_webrtc(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        self._schedule(self._handle_webrtc(d))

    async def _handle_webrtc(self, d):

        # browser-peer mode
        # The browser owns the RTCPeerConnection. This process is a relay: it
        # hands SDP and ICE straight to the UI and forwards the UI's replies
        # back to Voisa. Nothing is decoded here, so there is no local audio
        # device and no resampling step to get the pitch wrong.
        if self.browser_peer:
            await self._relay_webrtc(d)
            return

        if not self.pc:
            await self._pc()
        if "offer" in d:
            if self.pc.signalingState != "stable":
                # a second offer while negotiating is an ICE restart / renegotiation
                self._log("[ice] <- renegotiation offer (ICE restart)")
            await self.pc.setRemoteDescription(
                RTCSessionDescription(sdp=d["offer"]["sdp"], type=d["offer"]["type"]))
            ans = await self.pc.createAnswer()
            await self.pc.setLocalDescription(ans)
            self.sio.emit("webrtc", {"matchId": self.match_id,
                                     "answer": {"type": ans.type, "sdp": ans.sdp}})
            self._log("[client] -> webrtc answer")
        elif "answer" in d:
            # includes answers to our own ICE-restart offers
            await self.pc.setRemoteDescription(
                RTCSessionDescription(sdp=d["answer"]["sdp"], type=d["answer"]["type"]))
            self._log("[client] <- webrtc answer")
        elif "iceCandidate" in d:
            c = d["iceCandidate"]
            cand = parse_ice_candidate(c.get("candidate", ""), c.get("sdpMid"),
                                       c.get("sdpMLineIndex"))
            if cand:
                try:
                    await self.pc.addIceCandidate(cand)
                except Exception as e:
                    self._log(f"[client] addIceCandidate: {e}")

    # browser-peer relay
    async def _relay_webrtc(self, d):
        """Forward a Voisa webrtc message to the browser verbatim."""
        if "iceCandidate" in d:
            c = d["iceCandidate"]
            # remember where the peer says it is, for the loopback check
            try:
                from voisa_pkg.webrtc import candidate_addr
                a = candidate_addr(c.get("candidate", ""))
                if a:
                    self.peer_addrs.add(a)
                    if self.on_peer_addr:
                        self.on_peer_addr(a)
            except Exception:
                pass
            self._log(f"[ice] <- peer candidate {str(c.get('candidate'))[:60]}")
        elif "offer" in d:
            self._log("[rtc] <- peer offer -> browser")
        elif "answer" in d:
            self._log("[rtc] <- peer answer -> browser")
        self._state(phase="webrtc", matchId=self.match_id,
                    webrtc=d, **_webrtc_dir(d))

    def ui_webrtc(self, msg):
        """Called when the BROWSER sends an offer/answer/candidate upstream.

        Runs on the socket thread; hop onto the asyncio loop that owns self.sio.
        """
        if not self.sio or not self.match_id:
            return
        out = {"matchId": self.match_id}
        if "offer" in msg:
            out["offer"] = msg["offer"]
            self._log("[rtc] browser offer -> peer")
        elif "answer" in msg:
            out["answer"] = msg["answer"]
            self._log("[rtc] browser answer -> peer")
        elif "iceCandidate" in msg:
            out["iceCandidate"] = msg["iceCandidate"]
            self._log("[ice] browser candidate -> peer")
        else:
            return
        try:
            self.sio.emit("webrtc", out)
        except Exception as e:
            self._log(f"[rtc] emit failed: {e}")


def _webrtc_dir(d):
    """Which SDP the browser must handle, and whether it creates the offer."""
    if "offer" in d:
        return {"sdpRole": "answer", "sdp": d["offer"]}
    if "answer" in d:
        return {"sdpRole": "settle", "sdp": d["answer"]}
    return {}
