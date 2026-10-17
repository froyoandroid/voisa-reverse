"""Relay (MITM) legs: two independent identities bridged in the browser.

Each leg is its own BridgeCall with its own cookie, so the legs never share an
account or a match.
"""
from __future__ import annotations

import asyncio, os
from typing import TYPE_CHECKING

import voisa
from voisa_pkg.call import BridgeCall
from voisa_server.config import HERE
from voisa_server.logs import logfile

if TYPE_CHECKING:
    from voisa_server.sessions import Session

# MITM legs
async def leg_start(sess: Session, leg: str, cookie: str, device_id: str,
                    lang: str, seconds):
    """Start (or restart) one MITM relay leg with its own identity."""
    await leg_stop(sess, leg)

    if not cookie:
        await sess.send("mitm", leg=leg, what="log", text="no identity for leg")
        return

    bridge = BridgeCall(cookie, lang, seconds,
                                   send_media=False, audio_file=None,
                                   outdir=os.path.join(HERE, "media"),
                                   play_audio=False, record=False,
                                   browser_peer=True)
    bridge.device_id = device_id
    bridge.requeue_on_close = True
    main_loop = asyncio.get_event_loop()

    def _fire(coro_factory):
        try:
            asyncio.run_coroutine_threadsafe(coro_factory(), main_loop)
        except Exception:
            pass

    def _share_names():
        """Give every leg the names of all our legs, so any leg can spot a
        match with one of its own. Runs whenever a leg learns its name.

        Also the only point where a leg's server-assigned nickname becomes
        known: fetch-initial-data arrives over the socket after the entry was
        leased, so the pool entry has no username until now. Save it so the
        identities panel can show names, and push it to the browser so the
        leg's "relay identity" row fills in instead of sitting on "…".
        """
        for key, b in sess.legs.items():
            name = getattr(b, "username", None)
            if name:
                did = getattr(b, "device_id", None) or device_id
                try:
                    voisa.pool_set_username(
                        name, device_id=did,
                        cookie=getattr(b, "cookie", None),
                        log=lambda m: logfile(m, "pool"))
                except Exception:
                    pass
                _fire(lambda k=key, n=name, d=did: sess.send(
                    "mitm", leg=k, what="identity", deviceId=d, username=n))

        names = {getattr(b, "username", None) for b in sess.legs.values()}
        for b in sess.legs.values():
            b.own_names = names - {getattr(b, "username", None) or ""}
            if b.own_names:
                b._log(f"[loopback] know our other legs: {sorted(b.own_names)}")


    bridge.on_reconcile = _share_names
    bridge.on_log = lambda m: _fire(lambda: sess.send("mitm", leg=leg, what="log", text=m))

    def _leg_state(**kw):
        def emit():
            if kw.get("phase") == "webrtc":
                return sess.send("mitm", leg=leg, what="signal",
                                 payload=kw.get("webrtc") or {})
            return sess.send("mitm", leg=leg, what="call", **kw)
        _fire(emit)
    bridge.on_state = _leg_state

    sess.legs[leg] = bridge
    await bridge.start()
    await sess.send("mitm", leg=leg, what="identity", deviceId=device_id,
                    username=getattr(bridge, "username", None))


async def leg_stop(sess: Session, leg: str):
    b = sess.legs.pop(leg, None)
    if b:
        try:
            await b.stop()
        except Exception:
            pass


async def legs_stop_all(sess: Session):
    for leg in list(sess.legs):
        await leg_stop(sess, leg)


async def leg_signal(sess: Session, leg: str, msg: dict):
    """SDP/ICE from the browser for one leg, forwarded to that leg's peer."""
    b = sess.legs.get(leg)
    if not b:
        await sess.send("mitm", leg=leg, what="log", text="no such leg")
        return
    b.ui_webrtc(msg)
