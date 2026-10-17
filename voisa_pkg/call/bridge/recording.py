"""BridgeCall part: Recording of live tracks, toggled mid-call."""
import asyncio


from voisa_pkg.media import SafeRecorder


class RecordingMixin:
    """Recording of live tracks, toggled mid-call. Mixed into BridgeCall; uses its state."""

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
