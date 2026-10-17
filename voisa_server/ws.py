"""/ws: the browser's live channel (events, call control, signalling)."""
import asyncio

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from voisa_server.commands import dispatch
from voisa_server.logs import logfile
from voisa_server.sessions import Session, _SESSIONS

router = APIRouter()


@router.websocket("/ws")
async def ws(websocket: WebSocket):
    await websocket.accept()
    sess = Session(websocket)
    _SESSIONS.add(sess)
    await sess.log("ready")
    try:
        while True:
            msg = await websocket.receive_json()
            if not isinstance(msg, dict):
                continue
            try:
                await dispatch(sess, msg)
            except (WebSocketDisconnect, asyncio.CancelledError):
                raise
            except Exception as e:
                import traceback as _tb
                logfile(f"cmd {msg.get('cmd')!r} failed: " + _tb.format_exc(), "err", cid=sess.cid)
                await sess.log(f"{msg.get('cmd')} failed: {type(e).__name__}: {e}", "err")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        # starlette raises a distinct WebSocketDisconnected (trailing 'd') when
        # the socket closes mid-receive — a normal disconnect, not a crash.
        # Fall through to finally (detach), just don't log it as a crash.
        from starlette.websockets import WebSocketDisconnected as _WSD
        if not isinstance(e, _WSD):
            # log the FULL traceback to the file: a bare message like
            # "name 'x' is not defined" is useless without knowing where.
            import traceback as _tb
            logfile("WS HANDLER CRASH: " + _tb.format_exc(), "err", cid=sess.cid)
            try:
                await sess.send("log", text=f"error: {e}")
            except Exception:
                pass
    finally:
        _SESSIONS.discard(sess)
        # The socket.io connection is owned by the SERVER, not by this browser
        # tab. Closing the tab (or reloading it) must not tear down a call that
        # is in progress, so only the browser-facing WS is dropped here. The
        # call keeps running and is cleaned up by its own timer or by an
        # explicit `stopcall`.
        await sess.close()
