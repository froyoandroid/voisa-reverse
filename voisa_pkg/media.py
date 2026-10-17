"""Synthetic outgoing media tracks.

Used when no real camera/microphone is available. The audio track models speech
(envelope, syllable modulation, pauses) rather than a continuous test tone,
which was harsh enough to sound broken.
"""
import asyncio, fractions, time

import av
import numpy as np
from aiortc.mediastreams import AudioStreamTrack, VideoStreamTrack, MediaStreamError

class _ToneTrack(AudioStreamTrack):
    """Speech-like synthetic audio, 48 kHz mono.

    This used to be a *continuous 440 Hz sine at 0.25 amplitude* — a piercing
    monotone held for the entire call, which is what made the other side sound
    broken (and, when connected to yourself, unbearable).

    Now it models speech instead: an amplitude envelope with syllable-rate
    modulation and real pauses between "phrases", a formant-ish harmonic stack
    around 300 Hz, and a much lower peak. Still obviously synthetic, but it
    reads as someone talking rather than a test tone.
    """
    kind = "audio"

    def __init__(self, freq=300.0, rate=48000, peak=0.06):
        super().__init__()
        self.freq, self.rate, self.peak = freq, rate, peak
        self._samples = 0
        self._start = None
        self._phrase_until = 0.0     # when the current "phrase" ends
        self._silence_until = 0.0    # when the current gap ends

    def _envelope(self, t0, n):
        """Per-sample amplitude, 0 during gaps between phrases."""
        t = np.arange(t0, t0 + n) / float(self.rate)
        env = np.zeros(n, dtype=np.float64)
        # syllable-rate (≈4 Hz) modulation inside phrases
        syl = 0.5 + 0.5 * np.sin(2 * np.pi * 4.0 * t)
        syl *= 0.6 + 0.4 * np.sin(2 * np.pi * 1.3 * t + 0.7)
        # gate: silence except between _phrase_until and _silence_until
        now = t0 / float(self.rate)
        gate = 1.0 if (now < self._phrase_until or now >= self._silence_until) else 0.0
        env[:] = syl * gate
        return env

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        n = self.rate // 50  # 20 ms
        if self._start is None:
            self._start = time.time()
        else:
            self._samples += n
            wait = self._start + (self._samples / float(self.rate)) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)

        t0 = self._samples
        now = t0 / float(self.rate)

        # simple phrase/gap state machine: ~2-4 s of talking, ~0.5-1.5 s silence
        if now >= self._silence_until and now >= self._phrase_until:
            if self._phrase_until == 0.0:
                self._phrase_until = now + 2.5
            else:
                self._silence_until = now + 0.9
                self._phrase_until = now + 0.9 + 2.5

        t = np.arange(t0, t0 + n) / float(self.rate)
        # a few harmonics so it is not a bare sine
        sig = (np.sin(2 * np.pi * self.freq * t)
               + 0.4 * np.sin(2 * np.pi * 2 * self.freq * t)
               + 0.2 * np.sin(2 * np.pi * 3 * self.freq * t))
        env = self._envelope(t0, n)
        data = np.clip(sig * env * self.peak * 32767, -32767, 32767).astype(np.int16)

        frame = av.AudioFrame.from_ndarray(data.reshape(1, -1), format="s16", layout="mono")
        frame.rate = self.rate
        frame.pts = self._samples
        frame.time_base = fractions.Fraction(1, self.rate)
        return frame


class _TestPatternTrack(VideoStreamTrack):
    """Animated test pattern so the peer sees a live video track."""
    kind = "video"

    def __init__(self, w=320, h=240, fps=10):
        super().__init__()
        self.w, self.h, self.fps = w, h, fps
        self.i = 0
        self._start = None

    async def recv(self):
        if self.readyState != "live":
            raise MediaStreamError
        import asyncio, fractions
        if self._start is None:
            self._start = time.time()
            self._pts = 0
        else:
            self._pts += 1
            wait = self._start + (self._pts / float(self.fps)) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)

        img = np.zeros((self.h, self.w, 3), dtype=np.uint8)
        img[:, :, 0] = 20
        x = (self.i * 6) % self.w
        img[:, max(0, x - 8):x + 1, 1] = 220
        img[10:40, 10:40 + (self.i % 60) * 4, 2] = 180
        self.i += 1
        frame = av.VideoFrame.from_ndarray(img, format="rgb24")
        frame.pts = self._pts
        frame.time_base = fractions.Fraction(1, self.fps)
        return frame
