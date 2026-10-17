"""Voisa client, split by concern.

    account  — identity, cookies, the REST account API
    audio    — LivePlayer (speaker out) and SafeRecorder (wav out)
    media    — synthetic outgoing tracks (speech-like audio, test pattern)
    webrtc   — ICE helpers shared by the call classes
    call     — VoisaCall / BridgeCall (matchmaking + negotiation)

The originals (voisa.py, voisa_call.py, webui.py) remain as the entry points.
"""
__all__ = ["account", "audio", "media", "webrtc"]
