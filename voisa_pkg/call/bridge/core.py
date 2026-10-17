"""BridgeCall: the asyncio call engine behind the web UI's relay legs."""
import asyncio, os



from voisa_pkg.call.bridge.signalling import SignallingMixin
from voisa_pkg.call.bridge.peer import PeerMixin
from voisa_pkg.call.bridge.recording import RecordingMixin


class BridgeCall(SignallingMixin, PeerMixin, RecordingMixin):
    """asyncio-native wrapper around the call logic, with log/state hooks for the web UI.

    Unlike VoisaCall (which owns its own loop and blocks), BridgeCall runs on the
    caller's event loop and reports progress through on_log / on_state callbacks.
    """

    def __init__(self, cookie, lang="en", seconds=None, send_media=True,
                 audio_file=None, outdir="media", play_audio=True,
                 record=False, browser_peer=False):
        self.cookie = cookie
        # browser_peer=True: do NOT terminate WebRTC here. The browser is the
        # peer; this process only carries signalling between the browser and
        # the Voisa server, so decoded audio never touches a local sound card.
        self.browser_peer = browser_peer
        self.lang = lang
        self.seconds = seconds
        self.send_media = send_media
        self.audio_file = audio_file
        self.outdir = outdir
        # play the partner's voice out the local speaker as frames arrive
        self.play_audio = play_audio
        # Save incoming media to outdir/ (media/incoming-*.wav|ivf).
        # OFF by default: it captures the other person's voice. Live playback is
        # always on, so leaving this off costs nothing audible.
        self.record = record          # save incoming media to outdir/
        self.sio = None
        self.pc = None
        self.match_id = None
        self.is_offerer = None
        self.ice_servers = []
        self.peer = None
        self.recorders = []
        self.recording = record       # recording active right now (can toggle)
        self._live_tracks = []        # tracks seen this call, for late recording
        self.players = []            # (track, LivePlayer) for live speaker output
        # loopback guard
        # Our own display name, and the names of every OTHER leg we run. The
        # server discloses no peer account id — start-dialog carries only
        # {avatar, initiate, matchId, premium, username} — so the peer's NAME is
        # the only field a relay can be matched against.
        self.username = None
        self.own_names = set()
        self.on_reconcile = None     # callable(): this leg learned its name
        self.peer_addrs = set()
        self.on_peer_addr = None     # callable(addr): a peer address arrived
        self.on_loopback = None      # callable(peer_name): we met our own leg
        self._lvl_last = 0.0         # level-message throttle
        self._rec_started = set()
        self._timer = None
        self._reader = None
        self.on_log = lambda m: None
        self.on_state = lambda **kw: None
        self._closing = False
        self._loop = None      # main event loop, captured in start()
        os.makedirs(outdir, exist_ok=True)

    # thread-safe scheduling
    # socket.io invokes handlers on a worker thread; asyncio primitives must be
    # scheduled on the loop that created them.
    def _schedule(self, coro):
        try:
            asyncio.run_coroutine_threadsafe(coro, self._loop)
        except Exception as e:
            self.on_log(f"[sched] {e}")

    def _log(self, m):
        """Emit a log line. Callbacks may be sync or async and may be invoked
        from socket.io's worker thread, so route through the captured loop."""
        try:
            r = self.on_log(str(m))
            if asyncio.iscoroutine(r):
                self._schedule(r)
        except Exception:
            pass

    def _state(self, **kw):
        try:
            r = self.on_state(**kw)
            if asyncio.iscoroutine(r):
                self._schedule(r)
        except Exception:
            pass

    async def start(self):
        """Connect AND search. The normal path (the `full call` button)."""
        await self._connect_socket()
        # The app sends the language as its OWN event, then start-search with NO
        # payload. Passing searchLanguage to start-search put us in the default
        # pool instead of the chosen language -> we never met the other device.
        self.sio.emit("set-search-language", {"searchLanguage": self.lang})
        self._log(f"[client] -> set-search-language {self.lang}")
        await asyncio.sleep(0.15)
        self.sio.emit("start-search", {})
        self._log("[client] -> start-search {}")
        self._state(phase="searching", matchId=None)
        self._timer = asyncio.create_task(self._timeout())

    async def start_listen(self):
        """Connect WITHOUT searching.

        Used by the manual path (start search, then accept dialog): the dialog is
        already pending server-side, so emitting start-search would queue a
        *second* search. We just listen and negotiate when start-dialog arrives.
        """
        await self._connect_socket()
        self._log("[client] attached to pending dialog (not searching)")
        self._state(phase="waiting", matchId=self.match_id)
        self._timer = asyncio.create_task(self._timeout())

    async def _timeout(self):
        # Call window. The UI no longer sets this: calls run until stopped, so
        # seconds defaults to None meaning "no limit". A positive value is still
        # honoured for the CLI, which wants a bounded run.
        if not self.seconds or self.seconds <= 0:
            return
        await asyncio.sleep(self.seconds)
        self._log(f"[client] call window ({self.seconds}s) elapsed")
        await self.stop()

    async def stop(self):
        if self._closing:
            return
        self._stopped = True
        self._closing = True
        try:
            if self._timer:
                self._timer.cancel()
            if self.match_id and self.sio:
                self.sio.emit("close-dialog", {"matchId": self.match_id})
                self._log("[client] -> close-dialog")
            # Order matters: stop the recorders while the tracks are still live,
            # THEN close the peer connection. Closing pc first kills the tracks and
            # MediaRecorder.stop() throws, leaving an unfinalised file.
            await self._finalise_recorders()
            if self.pc:
                await self.pc.close()
                self.pc = None
            # Tell the peer we are done, then leave the Voisa socket CONNECTED.
            #
            # This used to disconnect sio and set it to None, which killed the
            # session for good: a second start-search had no socket to use and a
            # second stop was a silent no-op, so the call looked like it never
            # stopped. A "stop" should end the call, not the session.
            if self.match_id and self.sio:
                try:
                    self.sio.emit("close-dialog", {"matchId": self.match_id})
                except Exception:
                    pass
            self.match_id = None
            self._abort_searches()
        finally:
            self._closing = False          # allow the next call on this bridge
            self._live_tracks = []
            self.player = None
            self.recorder = None
            self.recorders = []
            self.recording = False
            self._log("[call] stopped")
            self._state(phase="idle", matchId=None)

    def _abort_searches(self):
        """Clear any in-flight matchmaking so a stop really stops matching."""
        if not self.sio:
            return
        try:
            self.sio.emit("stop-search", {})
            self._log("[client] -> stop-search")
        except Exception:
            pass
