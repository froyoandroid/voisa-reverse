"""Compatibility module: audio I/O now lives in voisa_pkg.media."""
from voisa_pkg.media.player import LivePlayer, SR_DEFAULT   # noqa: F401
from voisa_pkg.media.recorder import SafeRecorder          # noqa: F401
