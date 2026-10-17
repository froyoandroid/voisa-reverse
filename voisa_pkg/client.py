"""Blocking socket.io helpers for one-shot actions and the CLI."""
import json

import socketio

from voisa_pkg.protocol import SERVER, SOCK_PATH, APP_VERSION, PLATFORM, SERVER_EVENTS


# account
def make_socket(log=print) -> socketio.Client:
    sio = socketio.Client(reconnection=True, logger=False,
                          engineio_logger=False, request_timeout=30)

    @sio.event
    def connect():
        log(f"[socket] connected sid={sio.sid}")

    @sio.event
    def connect_error(data):
        log(f"[socket] connect_error: {data}")

    @sio.event
    def disconnect(reason=None):
        log(f"[socket] disconnected: {reason}")

    for ev in SERVER_EVENTS:
        sio.on(ev, _h(ev, log))
    try:
        sio.on("*", lambda ev=None, *a: log(
            f"[event] {ev} {json.dumps(a, default=str)[:1500]}"))
    except Exception:
        pass
    return sio


def shuffle_username(cookie: str, log=print):
    """Request a new server-assigned nickname. Premium accounts only; a free
    account gets back ``{"code": "PREMIUM_REQUIRED"}``. Returns the ack."""
    sio = connect(cookie, log=log)
    box = {}
    sio.emit("shuffle-username", {}, callback=lambda *a: box.setdefault("ack", a[0] if a else None))
    import time as _t; _t.sleep(3)
    sio.disconnect()
    return box.get("ack")


def buffer_dialog(cookie: str, event: str, match_id: str | None = None, log=print):
    """Send a dialog acknowledgement and return the server ack.

    ``event``:
      "match"   -> "this match reached the screen"   (no ack)
      "decline" -> dequeue a pending match           -> {"success": True}
      "accept"  -> cancel a pending accept           -> {"success": False, "declined": True}
    """
    if event not in ("match", "accept", "decline"):
        raise ValueError("event must be match/accept/decline")
    sio = connect(cookie, log=log)
    box = {}
    pl = {"event": event}
    if match_id:
        pl["matchId"] = match_id
    sio.emit("buffer-dialog", pl,
             callback=lambda *a: box.setdefault("ack", a[-1] if a else None))
    import time as _t; _t.sleep(2)
    sio.disconnect()
    return box.get("ack")


def _h(ev, log):
    def f(*a):
        log(f"[event] {ev} {json.dumps(a, default=str)[:1500]}")
    return f


def connect(cookie: str, log=print) -> socketio.Client:
    q = (f"?cookie={cookie}&version={APP_VERSION}&platform={PLATFORM}"
         f"&rawLanguage=en-GB&language=en&currentTheme=system")
    sio = make_socket(log)
    sio.connect(SERVER + "/" + q, transports=["websocket", "polling"],
                wait_timeout=20, socketio_path=SOCK_PATH)
    return sio
