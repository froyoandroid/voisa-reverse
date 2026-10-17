#!/usr/bin/env python3
"""
voisa_call.py — full standalone Voisa caller: matchmaking + WebRTC media.

Implements the real protocol captured from the app:

  start-search {searchLanguage}
    -> start-dialog {initiate, matchId, username, premium, avatar}     (server picks peer)
       if initiate==true  : we are the OFFERER  -> create offer
       if initiate==false : we are the ANSWERER -> wait for offer
    -> webrtc {matchId, offer:{type,sdp}}
    <- webrtc {matchId, answer:{type,sdp}}
    <-> webrtc {matchId, iceCandidate:{candidate,sdpMid,sdpMLineIndex}}
    -> sync-call-state {matchId}
    -> close-dialog {matchId}   (hang up)

Media: aiortc peer connection. Audio is a synthetic tone / the mic from a wav;
video is a generated test pattern (or your own frames). Incoming media is dumped
to disk so you can confirm a real stream arrived.

Run:
    python voisa_call.py --lang en --seconds 30 --out ./media
"""
import argparse, asyncio, io, json, os, sys, time, fractions, logging

import requests, socketio, aiohttp
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaRecorder
from aiortc.mediastreams import AudioStreamTrack, VideoStreamTrack, MediaStreamError
import av
import numpy as np

# split-out concerns
# LivePlayer / SafeRecorder live in voisa_pkg.audio, the synthetic outgoing
# tracks in voisa_pkg.media, ICE helpers in voisa_pkg.webrtc, and identity in
# voisa_pkg.account. Re-exported here so existing callers keep working.
from voisa_pkg.audio import LivePlayer, SafeRecorder          # noqa: F401
from voisa_pkg.media import _ToneTrack, _TestPatternTrack      # noqa: F401
from voisa_pkg.webrtc import _gather_complete, parse_ice_candidate  # noqa: F401
# protocol constants and identity: imported directly rather than reaching
# through a `voisa` module reference, which is not available here
# module-level fallback logger used by VoisaCall (the blocking CLI path);
# BridgeCall reports through on_log instead
log = lambda *a: print(*a, flush=True)  # noqa: E731

from voisa_pkg.account import (  # noqa: F401
    SERVER as _SERVER, SOCK_PATH as _SOCK_PATH,
    APP_VERSION as _APP_VERSION, PLATFORM as _PLATFORM,
    ensure_account as _ensure_account,
)


class VoisaCall:
    def __init__(self, cookie, lang="en", outdir="media", send_media=True,
                 audio_file=None, record=False):
        self.cookie = cookie
        self.lang = lang
        self.outdir = outdir
        self.send_media = send_media
        self.record = record          # save incoming media to outdir/
        self.audio_file = audio_file
        self.sio = None
        self.pc = None
        self.match_id = None
        self.is_offerer = None
        self.ice_servers = []
        self.peer = None
        # our own display name, and the names of every OTHER leg we run. A match
        # whose peer name is one of ours means two of our relays found each other.
        self.username = None
        self.own_names = set()
        self.on_reconcile = None     # callable(): a leg learned its name
        # addresses the peer advertised, for the ICE-level check
        self.peer_addrs = set()
        self.on_peer_addr = None     # callable(addr): a peer address arrived
        self.on_loopback = None      # callable(peer_name) -> handled?
        self.recorders = []
        os.makedirs(outdir, exist_ok=True)

    # socket
    def build(self):
        sio = socketio.Client(reconnection=True, request_timeout=30)
        self.sio = sio

        @sio.event
        def connect():
            log(f"[socket] connected sid={sio.sid}")

        @sio.event
        def disconnect(reason=None):
            log(f"[socket] disconnected: {reason}")

        sio.on("check-version", lambda *a: None)
        sio.on("fetch-initial-data", self._on_initial)
        sio.on("start-dialog", self._on_start_dialog)
        sio.on("close-dialog", self._on_close_dialog)
        sio.on("webrtc", self._on_webrtc)
        sio.on("buffer-dialog", self._on_buffer)
        sio.on("ban-update", lambda *a: log(f"[event] ban-update {a}"))
        return sio

    def _on_initial(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        self.ice_servers = d.get("iceServers", [])
        u = d.get("userData", {})
        log(f"[session] user={u.get('username')} id={u.get('deviceId')} premium={u.get('premium')}")
        log(f"[session] iceServers={len(self.ice_servers)}")

    def _on_buffer(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        log(f"[buffer-dialog] {json.dumps(d)[:200]}")

    def _on_close_dialog(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        log(f"[close-dialog] {json.dumps(d)[:200]} — peer left / match closed")
        asyncio.run_coroutine_threadsafe(self._teardown(), self.loop)

    def _on_start_dialog(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        self.match_id = d.get("matchId")
        self.is_offerer = bool(d.get("initiate"))
        log(f"[start-dialog] matchId={self.match_id} initiate={self.is_offerer} "
            f"peer={d.get('username')} avatar={d.get('avatar')}")
        # confirm we accept the dialog
        self.sio.emit("start-dialog", {"initiate": True, "matchId": self.match_id})
        log("[client] -> start-dialog {initiate:true}")
        asyncio.run_coroutine_threadsafe(self._after_match(), self.loop)

    def _on_webrtc(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        asyncio.run_coroutine_threadsafe(self._handle_webrtc(d), self.loop)

    # webrtc
    async def _pc(self):
        cfg = RTCConfiguration(iceServers=[
            RTCIceServer(urls=s["urls"], username=s.get("username"), credential=s.get("credential"))
            for s in self.ice_servers
        ]) if self.ice_servers else None
        pc = RTCPeerConnection(cfg)
        self.pc = pc

        # outgoing media
        # Audio: a real 440 Hz sine via aiortc's MediaPlayer over a generated wav.
        # Video: a live test pattern. Both are needed or the peer drops the call.
        if self.send_media:
            try:
                from aiortc.contrib.media import MediaPlayer
                from aiortc.mediastreams import AudioStreamTrack, VideoStreamTrack
                import numpy as np
                import av

                # No synthetic tone or test pattern. Either a real audio file
                # is sent, or we send no media at all and only receive.
                if self.audio_file and os.path.exists(self.audio_file):
                    player = MediaPlayer(self.audio_file)
                    if player.audio:
                        pc.addTrack(player.audio)
                        log(f"[media] out audio <- {self.audio_file}")
                else:
                    log("[media] out: nothing (no audio file)")
            except Exception as e:
                log(f"[media] outgoing setup failed: {e}")

        @pc.on("icecandidate")
        async def on_ice(cand):
            if cand and self.match_id:
                self.sio.emit("webrtc", {"matchId": self.match_id, "iceCandidate": {
                    "candidate": cand.candidate, "sdpMid": cand.sdpMid,
                    "sdpMLineIndex": cand.sdpMLineIndex}})
                log("[client] -> iceCandidate")

        @pc.on("track")
        def on_track(track):
            log(f"[media] incoming track: {track.kind}")
            # live speaker output for the partner's voice
            if track.kind == "audio":
                player = LivePlayer(log=log)
                player.open()
                self.player = player

                async def _pump():
                    try:
                        while True:
                            player.write(await track.recv())
                    except Exception:
                        pass
                    finally:
                        player.close()
                asyncio.ensure_future(_pump())
                log("[play] partner audio -> live speaker output")
            if self.record:
                # record incoming media to disk (opt-in)
                path = os.path.join(self.outdir, f"incoming-{track.kind}-{int(time.time())}.{'wav' if track.kind=='audio' else 'ivf'}")
                rec = SafeRecorder(path)
                self.recorder = rec
                rec.addTrack(track)
                asyncio.ensure_future(rec.start())
                log(f"[media] recording -> {path}")

        @pc.on("connectionstatechange")
        async def on_state():
            log(f"[pc] state={pc.connectionState}")
            if pc.connectionState == "failed":
                await self._teardown()

        return pc

    async def _after_match(self):
        if not self.pc:
            await self._pc()
        if self.is_offerer:
            # request their media too (recvonly transceivers) so tracks arrive
            if self.send_media:
                try:
                    from aiortc import RTCRtpTransceiver
                    self.pc.addTransceiver("audio", direction="recvonly")
                    self.pc.addTransceiver("video", direction="recvonly")
                except Exception as e:
                    log(f"[media] transceiver err: {e}")
            offer = await self.pc.createOffer()
            await self.pc.setLocalDescription(offer)
            await _gather_complete(self.pc)
            sdp = self.pc.localDescription.sdp
            log("[ice] offer carries "
                f"{sum(1 for l in sdp.splitlines() if l.startswith('a=candidate'))}"
                " candidate(s)")
            self.sio.emit("webrtc", {"matchId": self.match_id,
                                     "offer": {"type": offer.type, "sdp": sdp}})
            log("[client] -> webrtc offer (with media)")
        self.sio.emit("sync-call-state", {"matchId": self.match_id})
        log("[client] -> sync-call-state")

    async def _handle_webrtc(self, d):
        if not self.pc:
            await self._pc()
        if "offer" in d:
            log("[client] <- webrtc offer")
            offer = RTCSessionDescription(sdp=d["offer"]["sdp"], type=d["offer"]["type"])
            await self.pc.setRemoteDescription(offer)
            answer = await self.pc.createAnswer()
            await self.pc.setLocalDescription(answer)
            self.sio.emit("webrtc", {"matchId": self.match_id,
                                     "answer": {"type": answer.type, "sdp": answer.sdp}})
            log("[client] -> webrtc answer")
        elif "answer" in d:
            log("[client] <- webrtc answer")
            ans = RTCSessionDescription(sdp=d["answer"]["sdp"], type=d["answer"]["type"])
            await self.pc.setRemoteDescription(ans)
        elif "iceCandidate" in d:
            c = d["iceCandidate"]
            cand = parse_ice_candidate(c.get("candidate", ""), c.get("sdpMid"),
                                       c.get("sdpMLineIndex"))
            if cand is None:
                log("[client] <- iceCandidate (unparseable, skipped)")
            else:
                log(f"[client] <- iceCandidate {cand.ip}:{cand.port} {cand.type}")
                try:
                    await self.pc.addIceCandidate(cand)
                except Exception as e:
                    log(f"[client] addIceCandidate err: {e}")

    async def _teardown(self):
        if self.recorder:
            try: await self.recorder.stop()
            except Exception: pass
        if self.pc:
            await self.pc.close()
        self.pc = None
        log("[call] torn down")

    # run
    def run(self, seconds=30):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        sio = self.build()
        q = (f"?cookie={self.cookie}&version={_APP_VERSION}&platform={_PLATFORM}"
             f"&rawLanguage=en-GB&language=en&currentTheme=system")
        sio.connect(_SERVER + "/" + q, transports=["websocket"],
                    wait_timeout=20, socketio_path=_SOCK_PATH)
        time.sleep(1)
        sio.emit("set-search-language", {"searchLanguage": self.lang})
        log(f"[client] -> set-search-language {self.lang}")
        time.sleep(0.15)
        sio.emit("start-search", {})
        log("[client] -> start-search {}")
        try:
            self.loop.run_until_complete(asyncio.sleep(seconds))
        except KeyboardInterrupt:
            pass
        if self.match_id:
            sio.emit("close-dialog", {"matchId": self.match_id})
            log("[client] -> close-dialog")
        self.loop.run_until_complete(self._teardown())
        sio.disconnect()


class BridgeCall:
    """asyncio-native wrapper around the call logic, with log/state hooks for the web UI.

    Unlike VoisaCall (which owns its own loop and blocks), BridgeCall runs on the
    caller's event loop and reports progress through on_log / on_state callbacks.
    """

    def __init__(self, cookie, lang="en", seconds=None, send_media=True,
                 audio_file=None, outdir="media", play_audio=True,
                 record=False, browser_peer=False):
        self.cookie = cookie
        # browser_peer=True: do NOT terminate WebRTC here. The browser is the
        # peer; this process only carries signalling between the browser and
        # the Voisa server, so decoded audio never touches a local sound card.
        self.browser_peer = browser_peer
        self.lang = lang
        self.seconds = seconds
        self.send_media = send_media
        self.audio_file = audio_file
        self.outdir = outdir
        # play the partner's voice out the local speaker as frames arrive
        self.play_audio = play_audio
        # Save incoming media to outdir/ (media/incoming-*.wav|ivf).
        # OFF by default: it captures the other person's voice. Live playback is
        # always on, so leaving this off costs nothing audible.
        self.record = record          # save incoming media to outdir/
        self.sio = None
        self.pc = None
        self.match_id = None
        self.is_offerer = None
        self.ice_servers = []
        self.peer = None
        self.recorders = []
        self.recording = record       # recording active right now (can toggle)
        self._live_tracks = []        # tracks seen this call, for late recording
        self.players = []            # (track, LivePlayer) for live speaker output
        # loopback guard
        # Our own display name, and the names of every OTHER leg we run. The
        # server discloses no peer account id — start-dialog carries only
        # {avatar, initiate, matchId, premium, username} — so the peer's NAME is
        # the only field a relay can be matched against.
        self.username = None
        self.own_names = set()
        self.on_reconcile = None     # callable(): this leg learned its name
        self.peer_addrs = set()
        self.on_peer_addr = None     # callable(addr): a peer address arrived
        self.on_loopback = None      # callable(peer_name): we met our own leg
        self._lvl_last = 0.0         # level-message throttle
        self._rec_started = set()
        self._timer = None
        self._reader = None
        self.on_log = lambda m: None
        self.on_state = lambda **kw: None
        self._closing = False
        self._loop = None      # main event loop, captured in start()
        os.makedirs(outdir, exist_ok=True)

    # thread-safe scheduling
    # socket.io invokes handlers on a worker thread; asyncio primitives must be
    # scheduled on the loop that created them.
    def _schedule(self, coro):
        try:
            asyncio.run_coroutine_threadsafe(coro, self._loop)
        except Exception as e:
            self.on_log(f"[sched] {e}")

    def _log(self, m):
        """Emit a log line. Callbacks may be sync or async and may be invoked
        from socket.io's worker thread, so route through the captured loop."""
        try:
            r = self.on_log(str(m))
            if asyncio.iscoroutine(r):
                self._schedule(r)
        except Exception:
            pass

    def _state(self, **kw):
        try:
            r = self.on_state(**kw)
            if asyncio.iscoroutine(r):
                self._schedule(r)
        except Exception:
            pass

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

    async def start(self):
        """Connect AND search. The normal path (the `full call` button)."""
        await self._connect_socket()
        # The app sends the language as its OWN event, then start-search with NO
        # payload. Passing searchLanguage to start-search put us in the default
        # pool instead of the chosen language -> we never met the other device.
        self.sio.emit("set-search-language", {"searchLanguage": self.lang})
        self._log(f"[client] -> set-search-language {self.lang}")
        await asyncio.sleep(0.15)
        self.sio.emit("start-search", {})
        self._log("[client] -> start-search {}")
        self._state(phase="searching", matchId=None)
        self._timer = asyncio.create_task(self._timeout())

    async def start_listen(self):
        """Connect WITHOUT searching.

        Used by the manual path (start search, then accept dialog): the dialog is
        already pending server-side, so emitting start-search would queue a
        *second* search. We just listen and negotiate when start-dialog arrives.
        """
        await self._connect_socket()
        self._log("[client] attached to pending dialog (not searching)")
        self._state(phase="waiting", matchId=self.match_id)
        self._timer = asyncio.create_task(self._timeout())

    async def _timeout(self):
        # Call window. The UI no longer sets this: calls run until stopped, so
        # seconds defaults to None meaning "no limit". A positive value is still
        # honoured for the CLI, which wants a bounded run.
        if not self.seconds or self.seconds <= 0:
            return
        await asyncio.sleep(self.seconds)
        self._log(f"[client] call window ({self.seconds}s) elapsed")
        await self.stop()

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

    def start_recording(self, outdir=None):
        """Begin recording whatever tracks are already live.

        Recording is independent of the receive loop: the same frames are played
        and, if recording is on, also muxed to a file.
        """
        import os as _os, time as _t
        if self.recording:
            return False
        self.record = True
        self.recording = True
        outdir = outdir or self.outdir
        _os.makedirs(outdir, exist_ok=True)
        n = 0
        for track in list(self._live_tracks):
            path = _os.path.join(outdir,
                                 f"incoming-{track.kind}-{int(_t.time())}."
                                 + ("wav" if track.kind == "audio" else "ivf"))
            try:
                rec = SafeRecorder(path)
                rec.addTrack(track)
                self.recorders.append((track, rec))
                self._rec_started.add(rec)
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self._run_recorder(rec))
                except RuntimeError:
                    self._schedule(self._run_recorder(rec))
                self._log(f"[rec] started -> {path}")
                n += 1
            except Exception as e:
                self._log(f"[rec] cannot start: {type(e).__name__}: {e}")
        if n == 0:
            self._log("[rec] no live tracks yet (recording will start when media arrives)")
        return True

    async def stop_recording(self):
        """Finalise and close every open recorder."""
        if not self.recorders:
            self.recording = False
            return 0
        n = len(self.recorders)
        for rec in list(self._rec_started):
            try:
                await rec.stop()
                self._log(f"[rec] saved (frames={getattr(rec,'frames',0)})")
            except Exception as e:
                self._log(f"[rec] stop error: {e}")
            finally:
                self._rec_started.discard(rec)
        self.recorders = []
        self.recording = False
        return n

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

    async def _teardown_pc(self):
        """Drop just the peer connection; keep the socket and the bridge bus."""
        if self.pc:
            try:
                await self.pc.close()
            except Exception:
                pass
            self.pc = None

    def _on_webrtc(self, data=None, *a):
        d = data if isinstance(data, dict) else (a[0] if a else {})
        self._schedule(self._handle_webrtc(d))

    async def _pc(self):
        # The app builds the peer connection exactly like this:
        #   { iceServers: JSON.parse(JSON.stringify(state.iceServers)),
        #     iceCandidatePoolSize: 10 }
        # i.e. it passes EVERY server through untouched (no STUN/TURN filtering)
        # and pre-gathers candidates. Mirror that.
        servers = []
        for s in self.ice_servers:
            kw = {"urls": s["urls"]}
            if s.get("username"):
                kw["username"] = s["username"]
            if s.get("credential"):
                kw["credential"] = s["credential"]
            servers.append(RTCIceServer(**kw))
        cfg = RTCConfiguration(iceServers=servers) if servers else None
        self._log(f"[ice] {len(servers)} servers (unfiltered, as the app does)")
        pc = RTCPeerConnection(cfg)
        self.pc = pc

        if self.send_media:
            # one audio source: a file if given, otherwise a synthetic tone
            sent_file = False
            if self.audio_file and os.path.exists(self.audio_file):
                try:
                    from aiortc.contrib.media import MediaPlayer
                    pl = MediaPlayer(self.audio_file)
                    if pl.audio:
                        pc.addTrack(pl.audio)
                        self._log(f"[media] out audio <- {self.audio_file}")
                        sent_file = True
                except Exception as e:
                    self._log(f"[media] audio-file err: {e}")
            if not sent_file:
                # send nothing rather than a synthetic tone: the tone was harsh
                # and, connected to yourself, unbearable
                self._log("[media] out: nothing (no audio file)")

        @pc.on("icecandidate")
        async def on_ice(cand):
            if cand and self.match_id:
                self.sio.emit("webrtc", {"matchId": self.match_id, "iceCandidate": {
                    "candidate": cand.candidate, "sdpMid": cand.sdpMid,
                    "sdpMLineIndex": cand.sdpMLineIndex}})

        @pc.on("track")
        def on_track(track):
            path = os.path.join(self.outdir,
                                f"incoming-{track.kind}-{int(time.time())}.")
            path += "wav" if track.kind == "audio" else "ivf"

            # Incoming AUDIO goes to the speaker live. Without this the partner
            # is recorded to disk but never heard — the frames must hit the
            # audio device as they arrive, not just be muxed to a file.
            if track.kind == "audio" and self.play_audio:
                player = LivePlayer(log=self._log, on_level=self._on_level)
                player.open()
                self.players.append((track, player))
                self._log("[play] partner audio -> live speaker output")
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self._run_player(track, player))
                except RuntimeError:
                    self._schedule(self._run_player(track, player))

            # remember every incoming track so the record button can attach to
            # it mid-call (recording may start long after the track arrived)
            self._live_tracks.append(track)

            if self.record:
                rec = SafeRecorder(path)
                rec.addTrack(track)
                self.recorders.append((track, rec))
                self._rec_started.add(rec)  # _finalise_recorders() stops these
                self._log(f"[media] <- incoming {track.kind} (recording) -> {path}")
                # pc "track" is emitted by aiortc on the event-loop thread, so
                # schedule directly with ensure_future there;
                # run_coroutine_threadsafe is only valid from other threads.
                try:
                    loop = asyncio.get_running_loop()
                    loop.create_task(self._run_recorder(rec))
                except RuntimeError:
                    self._schedule(self._run_recorder(rec))
            else:
                # nothing is written, but the UI still needs to know media arrived
                self._log(f"[media] <- incoming {track.kind} (playback only)")
            self._state(phase="media", matchId=self.match_id, peer=self.peer,
                        track=track.kind, path=path if self.record else None)

        @pc.on("connectionstatechange")
        async def on_state_change():
            st = pc.connectionState
            self._log(f"[pc] {st}")
            self._state(phase=st, matchId=self.match_id, peer=self.peer)
            # The app restarts ICE when the connection drops:
            #   if (iceConnectionState === 'failed'|'disconnected') restartIce()
            if st in ("failed", "disconnected") and not self._closing:
                self._log(f"[pc] {st} -> restarting ICE")
                await self._restart_ice()

        return pc

    def _on_level(self, peak, samples):
        """Forward the audio level to the UI, throttled to ~20 msgs/sec."""
        import time as _t
        now = _t.time()
        if now - getattr(self, "_lvl_last", 0) < 0.05:
            return
        self._lvl_last = now
        try:
            self._state(phase="level", matchId=self.match_id, peak=round(peak, 4),
                        samples=samples)
        except Exception:
            pass

    async def _run_player(self, track, player):
        """Consume frames and write each to the audio device as it arrives."""
        try:
            while True:
                frame = await track.recv()
                player.write(frame)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            self._log(f"[play] ended: {type(e).__name__}: {e}")
        finally:
            n = player.close()
            self._log(f"[play] stopped after {player.samples} samples "
                      f"({(player.samples or 0)/48000:.1f}s) "
                      f"peak={player.peak_max:.3f} silent={player.silent_frames}")

    async def _run_recorder(self, rec):
        """Start the recorder and keep it running until the call ends.

        NOTE: MediaRecorder.stop() must run *before* the peer connection closes;
        once pc.close() ends the track, stop() raises and the container is never
        finalised (the file is left partial/zero-length).
        """
        try:
            await rec.start()
            self._rec_started.add(rec)
            while self.pc is not None and not self._closing:
                await asyncio.sleep(0.5)
        except Exception as e:
            self._log(f"[media] recorder err: {type(e).__name__}: {e}")
        # finalisation is done by stop(); do not stop here (ordering matters)

    async def _finalise_recorders(self):
        """Stop every recorder/player while the tracks are still live, before pc.close()."""
        # close live players first so no frame is written to a dying device
        for track, player in list(self.players):
            try:
                n = player.close()
                self._log(f"[play] closed ({player.samples} samples)")
            except Exception as e:
                self._log(f"[play] close err: {e}")
        self.players.clear()
        for rec in list(self._rec_started):
            try:
                await rec.stop()
                self._log(f"[media] recording finalised (frames={getattr(rec,'frames',0)})")
            except Exception as e:
                self._log(f"[media] recorder stop err: {e}")
            finally:
                self._rec_started.discard(rec)

    async def _after_match(self):
        if not self.pc:
            await self._pc()
        if self.is_offerer:
            # The app's offer is AUDIO-FIRST:
            #   createOffer({offerToReceiveAudio:true, offerToReceiveVideo:false,
            #                voiceActivityDetection:true, iceRestart})
            # aiortc: adding a track already creates a sendrecv transceiver, and
            # the remote track arrives on that transceiver's receiver. Adding an
            # extra transceiver here would bind the incoming media to a *second*
            # transceiver whose track nothing reads -> on_track fires but no
            # frames ever arrive. So: do not add one when we already sent audio.
            # We must always ask for their audio, whether or not we send any.
            # With no outgoing track the offer would otherwise contain no
            # m-lines at all and the peer would have nothing to send us.
            if not self.pc.getTransceivers():
                self.pc.addTransceiver("audio", direction="recvonly")
                self._log("[media] audio transceiver recvonly (receive-only)")
            elif self.send_media:
                self._log("[media] using the sendrecv transceiver from our track")
            offer = await self.pc.createOffer()
            await self.pc.setLocalDescription(offer)
            await _gather_complete(self.pc)
            sdp = self.pc.localDescription.sdp
            self._log("[ice] offer carries "
                      f"{sum(1 for l in sdp.splitlines() if l.startswith('a=candidate'))}"
                      " candidate(s)")
            self.sio.emit("webrtc", {"matchId": self.match_id,
                                     "offer": {"type": offer.type, "sdp": sdp}})
            self._log("[client] -> webrtc offer (audio-first)")
        self.sio.emit("sync-call-state", {"matchId": self.match_id})
        self._log("[client] -> sync-call-state")

    async def _restart_ice(self):
        """Answer the peer's renegotiation (ICE restart) with a fresh offer.

        The app does: pc.restartIce() then
        createOffer({offerToReceiveAudio:true, ..., iceRestart:true})
        and re-emits it over `webrtc`. Without this a long call dies on any
        network change or TURN maintenance.
        """
        if not self.pc or not self.match_id:
            return
        try:
            self._log("[ice] restarting ICE")
            await self.pc.setLocalDescription(await self.pc.createOffer(ice_restart=True))
            await _gather_complete(self.pc)
            offer = self.pc.localDescription
            self.sio.emit("webrtc", {"matchId": self.match_id,
                                     "offer": {"type": offer.type, "sdp": offer.sdp}})
            self._log("[client] -> webrtc offer (ICE restart)")
        except Exception as e:
            self._log(f"[ice] restart failed: {e}")

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

    async def stop(self):
        if self._closing:
            return
        self._stopped = True
        self._closing = True
        try:
            if self._timer:
                self._timer.cancel()
            if self.match_id and self.sio:
                self.sio.emit("close-dialog", {"matchId": self.match_id})
                self._log("[client] -> close-dialog")
            # Order matters: stop the recorders while the tracks are still live,
            # THEN close the peer connection. Closing pc first kills the tracks and
            # MediaRecorder.stop() throws, leaving an unfinalised file.
            await self._finalise_recorders()
            if self.pc:
                await self.pc.close()
                self.pc = None
            # Tell the peer we are done, then leave the Voisa socket CONNECTED.
            #
            # This used to disconnect sio and set it to None, which killed the
            # session for good: a second start-search had no socket to use and a
            # second stop was a silent no-op, so the call looked like it never
            # stopped. A "stop" should end the call, not the session.
            if self.match_id and self.sio:
                try:
                    self.sio.emit("close-dialog", {"matchId": self.match_id})
                except Exception:
                    pass
            self.match_id = None
            self._abort_searches()
        finally:
            self._closing = False          # allow the next call on this bridge
            self._live_tracks = []
            self.player = None
            self.recorder = None
            self.recorders = []
            self.recording = False
            self._log("[call] stopped")
            self._state(phase="idle", matchId=None)

    def _abort_searches(self):
        """Clear any in-flight matchmaking so a stop really stops matching."""
        if not self.sio:
            return
        try:
            self.sio.emit("stop-search", {})
            self._log("[client] -> stop-search")
        except Exception:
            pass


def _webrtc_dir(d):
    """Which SDP the browser must handle, and whether it creates the offer."""
    if "offer" in d:
        return {"sdpRole": "answer", "sdp": d["offer"]}
    if "answer" in d:
        return {"sdpRole": "settle", "sdp": d["answer"]}
    return {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--device-id")
    ap.add_argument("--lang", default="en")
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--out", default="media")
    ap.add_argument("--no-media", action="store_true", help="signaling only, no tracks")
    ap.add_argument("--audio-file", default=None, help="wav/mp3 to send instead of a tone")
    ap.add_argument("--record", action="store_true",
                    help="save the partner's audio to media/ (off by default)")
    a = ap.parse_args()
    acct = _ensure_account(a.device_id)
    log(f"[account] {acct['deviceId']} cookie={acct['cookie']}")
    VoisaCall(acct["cookie"], a.lang, a.out,
              send_media=not a.no_media, audio_file=a.audio_file,
              record=getattr(a, "record", False)).run(a.seconds)


if __name__ == "__main__":
    main()
