"""VoisaCall: blocking, self-contained caller for the CLI.

It owns its event loop, terminates WebRTC itself with aiortc and dumps incoming
media to disk so you can confirm a real stream arrived.
"""
import asyncio, json, os, time

from aiortc import RTCPeerConnection, RTCSessionDescription, RTCConfiguration, RTCIceServer

from voisa_pkg.media import LivePlayer, SafeRecorder
from voisa_pkg.webrtc import _gather_complete, parse_ice_candidate
from voisa_pkg.protocol import SERVER as _SERVER, SOCK_PATH as _SOCK_PATH, APP_VERSION as _APP_VERSION, PLATFORM as _PLATFORM

import socketio

# module-level logger; BridgeCall reports through on_log instead
log = lambda *a: print(*a, flush=True)  # noqa: E731


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
