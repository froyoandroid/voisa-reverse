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
import argparse

from voisa_pkg.call.standalone import VoisaCall, log
from voisa_pkg.identity import ensure_account as _ensure_account


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
