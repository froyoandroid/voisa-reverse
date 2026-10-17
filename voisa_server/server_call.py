"""Server-side call (aiortc terminates the media here). Legacy `call` command:
the normal Call view uses the browser as the peer and never gets here."""
from __future__ import annotations

import asyncio, os
from typing import TYPE_CHECKING

from voisa_pkg.call import BridgeCall
from voisa_server.config import HERE

if TYPE_CHECKING:
    from voisa_server.sessions import Session

# call integration (aiortc)
async def start_call(sess: Session, lang: str, seconds, send_media: bool,
                     audio_file, record: bool = False, search: bool = True):
    if sess.call:
        await sess.call.stop()

    bridge = BridgeCall(sess.cookie, lang, seconds,
                                   send_media=send_media, audio_file=audio_file,
                                   outdir=os.path.join(HERE, "media"),
                                   play_audio=True, record=record,
                                   browser_peer=True)
    # BridgeCall may call these from any thread; hop back onto the UI loop.
    main_loop = asyncio.get_event_loop()

    def _fire(coro_factory):
        try:
            asyncio.run_coroutine_threadsafe(coro_factory(), main_loop)
        except Exception:
            pass

    sess._ice_counts = {}      # fresh counters per call
    sess._ice_total = 0
    sess._ice_last = 0.0
    bridge.on_log = lambda m: _fire(lambda: sess.log(m))
    bridge.on_state = lambda **kw: _fire(lambda: sess.send("call", **kw))
    sess.call = bridge
    if search:
        await bridge.start()
    else:
        # attach without emitting start-search: we are joining a dialog that is
        # already pending, so just listen and negotiate when it arrives
        await bridge.start_listen()
