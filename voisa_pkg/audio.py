"""Audio I/O for the Voisa client.

Two independent consumers of the same incoming track:

  LivePlayer   — writes frames to the speaker as they arrive (live playback)
  SafeRecorder — muxes frames to a file (opt-in)

Both hand the blocking encode/mux work to a worker thread. Doing it inline on
the asyncio loop stalled RTP delivery, which sounded like delay + crackle.

`_gather_complete` lives in webrtc.py, not here.
"""
import asyncio, fractions, io, os, time

import av
import numpy as np

# WebRTC audio is always 48 kHz; use it when a frame does not say.
SR_DEFAULT = 48000


class LivePlayer:
    """Plays incoming RTP audio frames to the local speaker in real time.

    aiortc hands us each frame from ``track.recv()`` as it arrives (~50/s for
    Opus at 20 ms ptime). We encode and mux straight to an ALSA output, which on
    PipeWire systems is bridged by libasound_module_pcm_pipewire.so — the same
    path a browser uses, so it lands on the active sink (e.g. xrdp-sink).

    Writing to a file here would be recording, not playback: the partner would
    still be inaudible. Each frame must reach the device as it arrives.
    """

    def __init__(self, device="default", log=None, on_level=None):
        self.device = device
        self._log = log or (lambda m: None)
        # called with (rms, peak, samples) for every incoming audio frame, so the
        # UI can draw a live waveform and prove audio is really arriving
        self._on_level = on_level
        self.container = None
        self.stream = None
        self.rate = None
        self.samples = 0            # SOURCE samples received
        self.out_samples = 0        # samples actually written to the device
        self._rs_layout = None      # layout the current resampler was built for
        self.peak = 0
        self.peak_max = 0
        self.silent_frames = 0
        self.ok = False
        # Frames are handed to a dedicated writer thread. mux()/ALSA writes are
        # blocking, and doing them on the asyncio loop stalled RTP delivery:
        # frames arrived in bursts, which is heard as delay + crackle.
        self._q = None
        self._thread = None
        self._stop = None
        self.dropped = 0

    def _sink_rate(self, fallback=48000):
        """Query the default sink's rate.

        The xrdp sink here runs at 44100 Hz. Opening the ALSA stream at 48000
        forced a live resample of every frame — a classic source of crackle,
        dropouts and pitch wobble, i.e. the "broken" sound. Match the sink.
        """
        try:
            import subprocess
            out = subprocess.run(["pactl", "list", "sinks"],
                                 capture_output=True, text=True, timeout=3).stdout
            for line in out.splitlines():
                if "Sample Specification:" in line:
                    for tok in line.replace(":", " ").split():
                        if tok.endswith("Hz"):
                            return int(tok[:-2])
        except Exception:
            pass
        return fallback

    def open(self, rate=None):
        # PyAV ships its own ALSA build; point it at the system config and the
        # distro's plugin directory or it cannot resolve "default".
        os.environ.setdefault("ALSA_CONFIG_PATH", "/usr/share/alsa/alsa.conf")
        os.environ.setdefault("ALSA_PLUGIN_DIR",
                              "/usr/lib/x86_64-linux-gnu/alsa-lib")
        os.environ.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
        if rate is None:
            rate = self._sink_rate()
        try:
            self.container = av.open(self.device, format="alsa", mode="w")
            self.stream = self.container.add_stream("pcm_s16le", rate=rate)
            # Default to stereo; write() re-declares the stream layout to match
            # whatever the peer actually sends. WebRTC audio is commonly stereo,
            # and mislabelling it mono halves the playback speed.
            self.stream.layout = "stereo"
            self.rate = rate
            # ffmpeg's swresample, NOT numpy interpolation. Linear interpolation
            # has no anti-alias filter (down 48k->44.1k folds high frequencies
            # back as harshness) and restarting it every 20 ms frame put a phase
            # discontinuity at each boundary — 50 clicks per second. A
            # persistent resampler filters properly and keeps state.
            self._resampler = None
            self.ok = True
            self._log(f"[play] live output open -> {self.device} @ {rate}Hz")
            self._start_writer()
        except Exception as e:
            self.ok = False
            self._log(f"[play] cannot open {self.device}: "
                      f"{type(e).__name__}: {e}")

    def _start_writer(self):
        import queue as _q
        import threading as _t
        self._q = _q.Queue(maxsize=64)      # ~1.3 s of 20 ms frames
        self._stop = _t.Event()

        def run():
            while not self._stop.is_set():
                try:
                    frame = self._q.get(timeout=0.2)
                except _q.Empty:
                    continue
                if frame is None:
                    break
                self._encode(frame)
            # drain anything left, then flush
            while True:
                try:
                    frame = self._q.get_nowait()
                except _q.Empty:
                    break
                if frame is not None:
                    self._encode(frame)
            try:
                for pkt in self.stream.encode(None):
                    self.container.mux(pkt)
            except Exception:
                pass

        self._thread = _t.Thread(target=run, daemon=True, name="live-player")
        self._thread.start()

    def write(self, frame):
        """Enqueue a frame. Never blocks the event loop."""
        if not self.ok:
            return
        # metering happens here, on the loop, because it is cheap and the UI
        # wants it promptly
        try:
            self._meter(frame)
        except Exception:
            pass
        try:
            self._q.put_nowait(frame)
        except Exception:
            # queue full: the writer is behind. Drop the OLDEST so we stay near
            # live rather than building an ever-growing delay.
            try:
                self._q.get_nowait()
                self._q.put_nowait(frame)
                self.dropped += 1
            except Exception:
                self.dropped += 1

    def _meter(self, frame):
        try:
            arr = frame.to_ndarray()
        except Exception:
            return
        a = np.abs(arr)
        peak = float(a.max()) / 32768.0
        self.peak = peak
        if peak > self.peak_max:
            self.peak_max = peak
        if peak < 0.0005:
            self.silent_frames += 1
        if self._on_level:
            try:
                self._on_level(peak, self.samples)
            except Exception:
                pass

    def _encode(self, frame):
        """Runs on the writer thread. Blocking ALSA/PyAV work lives here."""
        try:
            arr = frame.to_ndarray()
        except Exception:
            return
        if arr.dtype != np.int16:
            arr = arr.astype(np.int16)

        # Read the layout from the FRAME, never guess it from the array shape.
        # to_ndarray() returns a flat interleaved (1, samples*channels) buffer,
        # so shape[0] is always 1 and a stereo frame is indistinguishable from
        # a mono frame with twice the samples. Guessing mono there played 960
        # stereo frames as 1920 mono samples: audio at half speed, an octave
        # low — the "very low pitch" heard on live calls.
        frame_layout = getattr(frame, "layout", None)
        try:
            channels = len(frame_layout.channels) if frame_layout else 1
        except Exception:
            channels = 1
        layout = "mono" if channels <= 1 else "stereo"
        try:
            # Determine the frame's TRUE rate.
            #
            # WebRTC/Opus audio is 48 kHz, but a fresh av.AudioFrame reports
            # sample_rate == 0, and some decoders leave it unset. The old code
            # fell back to self.rate (44100), which made src_rate == self.rate,
            # skipped the resampler, and fed 48 kHz samples to a 44.1 kHz device
            # — audio played 8.8% slow and sounded low-pitched.
            #
            # So: trust a sensible non-zero rate, otherwise assume 48 kHz (the
            # WebRTC standard) rather than the sink rate.
            src_rate = int(getattr(frame, "sample_rate", 0) or 0)
            if src_rate <= 0:
                src_rate = SR_DEFAULT
            # one-shot diagnostic so we stop guessing about the real rate
            if not getattr(self, "_rate_logged", False):
                self._rate_logged = True
                self._log(f"[play] RATE src={src_rate} sink={self.rate} "
                          f"arr={arr.shape} frame_layout="
                          f"{getattr(frame,'layout',None)} frame_samples="
                          f"{getattr(frame,'samples',None)} guessed={layout}")

            f = av.AudioFrame.from_ndarray(arr, format="s16", layout=layout)
            f.sample_rate = src_rate
            f.pts = self.samples
            f.time_base = fractions.Fraction(1, src_rate)
            self.samples += arr.shape[-1]

            if src_rate != self.rate:
                # persistent swresample: proper anti-alias filtering and filter
                # state carried across frames (no boundary clicks)
                if self._resampler is None or self._rs_layout != layout:
                    self._resampler = av.AudioResampler(
                        format="s16", layout=layout, rate=self.rate)
                    self._rs_layout = layout
                out = self._resampler.resample(f)
                out = out if isinstance(out, list) else [out]
                if self.stream.layout.name != layout:
                    self.stream.layout = layout
                for rf in out:
                    if rf is None:
                        continue
                    rf.sample_rate = self.rate
                    rf.pts = None          # let the muxer time it
                    self.out_samples += rf.samples
                    for pkt in self.stream.encode(rf):
                        self.container.mux(pkt)
                return

            f.sample_rate = self.rate
            if self.stream.layout.name != layout:
                self.stream.layout = layout
            self.out_samples += f.samples
            for pkt in self.stream.encode(f):
                self.container.mux(pkt)
        except Exception as e:
            self._log(f"[play] write error: {type(e).__name__}: {e}")

    def close(self):
        if not self.ok:
            return None
        try:
            if self._q is not None:
                self._q.put_nowait(None)      # sentinel: flush and exit
            if self._thread is not None:
                self._thread.join(timeout=3.0)
        except Exception:
            pass
        try:
            if self._stop:
                self._stop.set()
        except Exception:
            pass
        try:
            self.container.close()
        except Exception:
            pass
        self.ok = False
        return self.samples


class SafeRecorder:
    """Drop-in replacement for aiortc's MediaRecorder that actually writes files.

    PyAV 17.1.0 on this build silently produces no output when given a *path*
    (av.open(path, mode="w") + close() leaves no file), while writing to a
    BytesIO works. So: record into memory, flush to the real path on stop().
    """

    def __init__(self, path: str, fmt: str | None = None):
        self.path = path
        self.fmt = fmt or ("wav" if path.endswith(".wav") else "ivf")
        self._buf = io.BytesIO()
        self._container = av.open(self._buf, mode="w", format=self.fmt)
        self._tracks = {}          # track -> stream
        self._tasks = {}           # track -> asyncio.Task

    def addTrack(self, track):
        if track.kind == "audio":
            codec = "pcm_s16le" if self.fmt in ("wav", "alsa", "pulse") else "aac"
            stream = self._container.add_stream(codec)
        else:
            if self.fmt == "image2":
                stream = self._container.add_stream("png", rate=30)
                stream.pix_fmt = "rgb24"
            elif self.fmt == "webm":
                stream = self._container.add_stream("libvpx", rate=30)
                stream.pix_fmt = "yuv420p"
            elif self.fmt == "ivf":
                stream = self._container.add_stream("vp8", rate=30)
                stream.pix_fmt = "yuv420p"
            else:
                stream = self._container.add_stream("libx264", rate=30)
                stream.pix_fmt = "yuv420p"
        self._tracks[track] = stream

    async def start(self):
        loop = asyncio.get_running_loop()
        for track, stream in self._tracks.items():
            if self._tasks.get(track) is not None:
                continue
            # create on THIS running loop; asyncio.ensure_future from a sync
            # context can bind to the wrong loop and the task never runs.
            self._tasks[track] = loop.create_task(self._pump(track, stream))
        if self._tasks:
            # yield so the pump can start before the caller moves on
            await asyncio.sleep(0)

    async def _pump(self, track, stream):
        """Pull frames and hand the (blocking) encoding to a worker thread.

        encode()/mux() are blocking; running them inline stalled the event loop
        that also has to deliver RTP, so frames arrived in bursts.
        """
        import queue as _q
        import threading as _t
        self.frames = 0
        q = _q.Queue(maxsize=128)
        done = _t.Event()

        def worker():
            while True:
                item = q.get()
                if item is None:
                    break
                try:
                    for packet in stream.encode(item):
                        self._container.mux(packet)
                except Exception:
                    pass
            done.set()

        th = _t.Thread(target=worker, daemon=True, name=f"rec-{track.kind}")
        th.start()
        try:
            while True:
                try:
                    frame = await track.recv()
                except Exception:
                    break
                self.frames += 1
                try:
                    q.put_nowait(frame)
                except Exception:
                    pass
        except asyncio.CancelledError:
            pass
        finally:
            try:
                q.put_nowait(None)
                await asyncio.get_running_loop().run_in_executor(None, th.join, 3.0)
            except Exception:
                pass

    async def stop(self):
        for track, task in list(self._tasks.items()):
            task.cancel()
            self._tasks.pop(track, None)
            stream = self._tracks.get(track)
            if stream is not None:
                for packet in stream.encode(None):
                    self._container.mux(packet)
        self._tracks = {}
        self._container.close()
        data = self._buf.getvalue()
        if data:
            with open(self.path, "wb") as f:
                f.write(data)


