"""Voisa client library, one subpackage per subsystem.

    protocol   server endpoints, client version, wire event names
    paths      where data files live (project root)
    identity/  account (mint / re-register), saved shelf, relay pool
    client     blocking socket helpers for one-shot actions and the CLI
    call/      VoisaCall (standalone CLI) and BridgeCall (server relay legs)
    media/     live player, recorder, synthetic outgoing tracks
    webrtc     ICE helpers
    cli/       command-line entry points behind voisa.py and voisa_call.py

voisa.py, voisa_call.py and webui.py at the root are thin entry points and
compatibility facades. account.py and audio.py here are compatibility shims.
"""
