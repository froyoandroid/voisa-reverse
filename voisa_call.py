#!/usr/bin/env python3
"""voisa_call.py: compatibility facade for the call engines, plus the call CLI.

VoisaCall and BridgeCall live in voisa_pkg.call.

    python voisa_call.py --lang en --seconds 30 --out ./media
"""
from voisa_pkg.call import VoisaCall, BridgeCall, _webrtc_dir   # noqa: F401
from voisa_pkg.media import LivePlayer, SafeRecorder, _ToneTrack, _TestPatternTrack  # noqa: F401
from voisa_pkg.webrtc import _gather_complete, parse_ice_candidate  # noqa: F401
from voisa_pkg.cli.call_cli import main

if __name__ == "__main__":
    main()
