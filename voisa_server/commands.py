"""Browser -> server commands over /ws, one handler per command.

Every handler takes (sess, msg). dispatch() looks the command up in COMMANDS;
a failure in one command is logged and reported to that tab only.
"""
import asyncio

import voisa
from voisa_server.logs import logfile
from voisa_server.sessions import Session, _cookies_in_use
from voisa_server.relay import leg_start, leg_stop, leg_signal
from voisa_server.server_call import start_call


async def _identity_call(fn, *args, attempts: int = 3):
    """Mint / re-register an identity off the event loop. Voisa's account API
    times out now and then, so a single slow request no longer fails the tab."""
    for i in range(attempts):
        try:
            return await asyncio.to_thread(fn, *args)
        except Exception:
            if i == attempts - 1:
                raise
            await asyncio.sleep(1.5 * (i + 1))


def _shuffle(cookie: str):
    """Blocking nickname shuffle — runs off the event loop."""
    try:
        return voisa.shuffle_username(cookie, log=lambda *_: None)
    except Exception as e:
        return {"code": f"{type(e).__name__}: {e}"}


async def cmd_connect(sess: Session, msg: dict) -> None:
    # bump generation first so stale events from the old socket are
    # dropped by the UI
    if msg.get("gen") is not None:
        sess.gen = int(msg["gen"])
    did = msg.get("deviceId")
    # An explicit cookie lets each browser tab hold its OWN identity
    # instead of everyone sharing the one stored account. This is
    # what makes two isolated relays possible: tab A is one Voisa
    # identity, tab B is another, and they never collide.
    cookie = msg.get("cookie")
    if cookie:
        # the browser session remembered its own identity — use it
        acct = {"deviceId": did or "", "cookie": cookie}
    elif did:
        # a remembered deviceId with no cookie: re-fetch it (does
        # not touch the shared global store)
        acct = await _identity_call(voisa.register, did)
    else:
        # no identity at all: mint a FRESH one bound to this session,
        # never the global voisa_account.json default. The browser
        # persists what comes back on the `account` message, so a
        # reload keeps the same identity instead of minting again.
        acct = await _identity_call(voisa.create_fresh)

    # Identity is PER SESSION. If the identity this tab asked for is
    # already held by another live session (a duplicated tab, a second
    # tab in the same browser, a stale copy), do not share it: give this
    # session its own fresh one instead.
    if acct.get("cookie") and acct["cookie"] in _cookies_in_use(exclude=sess):
        await sess.log("that identity is in use by another session — "
                       "this session gets its own", "warn")
        acct = await _identity_call(voisa.create_fresh)

    # Only tear down when the identity is actually changing. A plain
    # page load also sends `connect`; closing unconditionally killed
    # a call that was already in progress (and a peer arriving one
    # second later found a dead session).
    same_identity = (sess.cookie == acct["cookie"])
    if same_identity and sess.sio and sess.sio.connected:
        # already connected as this identity — don't reconnect and
        # don't disturb a live call
        await sess.send("account", **acct)
        await sess.log("already connected (identity unchanged)")
        return
    await sess.send("account", **acct)
    await sess.connect(acct["cookie"])


async def cmd_emit(sess: Session, msg: dict) -> None:
    await sess.emit(msg.get("event"), msg.get("payload") or {})


async def cmd_search(sess: Session, msg: dict) -> None:
    # language is its own event; start-search takes no payload
    await sess.search(msg.get("lang", "en"))


async def cmd_accept(sess: Session, msg: dict) -> None:
    # the dialog is accepted as soon as start-dialog arrives; this is a
    # no-op unless that somehow did not happen
    await sess._accept(msg.get("matchId") or sess.match_id)


async def cmd_hangup(sess: Session, msg: dict) -> None:
    await sess.hangup()


async def cmd_bufferdialog(sess: Session, msg: dict) -> None:
    # dialog ack: match | decline | accept
    await sess.emit("buffer-dialog",
                    {"event": msg.get("event", "match")})


async def cmd_shuffle(sess: Session, msg: dict) -> None:
    # server-assigned nickname change; premium accounts only
    ack = await sess.loop.run_in_executor(None, _shuffle, sess.cookie)
    if isinstance(ack, dict) and ack.get("code"):
        await sess.log(f"shuffle-username refused: {ack['code']}", "err")
    elif ack:
        await sess.log(f"new username: {ack}", "match")
    else:
        await sess.log("shuffle-username: no reply", "err")


async def cmd_call(sess: Session, msg: dict) -> None:
    await start_call(sess, msg.get("lang", "en"), int(msg.get("seconds") or 0),
                     bool(msg.get("media", True)), msg.get("audioFile"),
                     bool(msg.get("record", False)))


async def cmd_record(sess: Session, msg: dict) -> None:
    # the browser holds the peer's audio and records it itself; the
    # server only confirms there is a call to record
    want = bool(msg.get("on", True))
    if want and not sess.match_id:
        await sess.log("no active call to record", "err")
        await sess.send("recording", on=False, ok=False)
    else:
        await sess.send("recording", on=want, ok=True)


async def cmd_mitm(sess: Session, msg: dict) -> None:
    # leg control for the MITM view: start/stop a leg, or hand a
    # leg the browser's SDP/ICE
    # accept "A"/"B" or a "leg-A"/"leg-B" element id, so a
    # frontend slip cannot silently reject every leg message
    leg = str(msg.get("leg") or "").upper().removeprefix("LEG-")
    act = msg.get("act")
    if leg not in ("A", "B"):
        await sess.log("mitm: bad leg", "err")
    elif act == "start":
        await leg_start(sess, leg, msg.get("cookie"),
                        msg.get("deviceId"), msg.get("lang", "en"),
                        msg.get("seconds") or 0)
    elif act == "stop":
        await leg_stop(sess, leg)
        await sess.send("mitm", leg=leg, what="call", phase="idle", matchId=None)
    elif act == "signal":
        await leg_signal(sess, leg, msg)
    else:
        await sess.log(f"mitm: bad act {act!r}", "err")


async def cmd_webrtc(sess: Session, msg: dict) -> None:
    # the BROWSER owns the peer connection; relay its SDP/ICE upstream
    await sess.browser_webrtc(msg)


async def cmd_stopcall(sess: Session, msg: dict) -> None:
    await sess.stop_call()


async def cmd_logline(sess: Session, msg: dict) -> None:
    # the UI can persist its own client-side lines to the same file
    logfile(str(msg.get("text", "")), msg.get("level", "ui"), cid=sess.cid)


async def cmd_ping(sess: Session, msg: dict) -> None:
    await sess.send("pong")


COMMANDS = {
    "connect": cmd_connect,
    "emit": cmd_emit,
    "search": cmd_search,
    "accept": cmd_accept,
    "hangup": cmd_hangup,
    "bufferdialog": cmd_bufferdialog,
    "shuffle": cmd_shuffle,
    "call": cmd_call,
    "record": cmd_record,
    "mitm": cmd_mitm,
    "webrtc": cmd_webrtc,
    "stopcall": cmd_stopcall,
    "logline": cmd_logline,
    "ping": cmd_ping,
}


async def dispatch(sess: Session, msg: dict) -> None:
    cmd = msg.get("cmd")
    handler = COMMANDS.get(cmd)
    if handler is None:
        await sess.log(f"unknown cmd: {cmd}")
        return
    await handler(sess, msg)
