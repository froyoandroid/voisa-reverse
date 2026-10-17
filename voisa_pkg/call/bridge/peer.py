"""BridgeCall part: Server-side RTCPeerConnection (unused when the browser is the peer)."""
import asyncio, os, time

from aiortc import RTCPeerConnection, RTCConfiguration, RTCIceServer

from voisa_pkg.media import LivePlayer, SafeRecorder
from voisa_pkg.webrtc import _gather_complete


class PeerMixin:
    """Server-side RTCPeerConnection (unused when the browser is the peer). Mixed into BridgeCall; uses its state."""

    async def _teardown_pc(self):
        """Drop just the peer connection; keep the socket and the bridge bus."""
        if self.pc:
            try:
                await self.pc.close()
            except Exception:
                pass
            self.pc = None

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
