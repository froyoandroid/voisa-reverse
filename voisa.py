#!/usr/bin/env python3
"""
voisa.py — standalone Voisa client (app.voisa v3.2.0).

Speaks the app's REAL wire protocol, captured from the live app:

  Session:   POST /api/v0/createAccount {deviceId} -> {cookie}      (anonymous identity)
  Socket:    wss://voisa.stivisto.com/socket.io/?cookie=…&…         (Socket.IO v4 / EIO 4)

  Wire events (kebab-case — these are the ACTUAL socket.io event names):
    server -> client : check-version, fetch-initial-data, start-dialog,
                       close-dialog, webrtc, ban-update, set-premium,
                       update-user, share-contacts, buffer-dialog
    client -> server : start-search, stop-search, sync-call-state,
                       start-dialog, close-dialog, close-dialog-v1, webrtc,
                       set-search-language, shuffle-username, update-avatar,
                       buffer-dialog
    note: buffer-dialog is BIDIRECTIONAL — a dialog ack, not a queue hold
          (server echoes {event:"decline", matchId} after applying one)

  Matchmaking flow:
    C: start-search  {searchLanguage}
    S: start-dialog  {initiate:false|true, matchId, username, premium, avatar}
    C: start-dialog  {initiate:true, matchId}        -> accept
    C: buffer-dialog {event:"match"}                 -> "match was shown" (no ack)
    C: buffer-dialog {event:"decline"}               -> dequeue  (ack {success:true})
    C: buffer-dialog {event:"accept"}                -> cancel   (ack {success:false,…})
    S: close-dialog  {matchId}                       -> dialog expired
    S/C: webrtc {matchId, offer|answer|iceCandidate}

Commands:
    whoami | new | login | listen | search | match | repl
"""
import argparse, json, os, sys, time, threading, uuid

import requests
import socketio

SERVER = "https://voisa.stivisto.com"
API = SERVER + "/api/v0/createAccount"
SOCK_PATH = "socket.io"
APP_VERSION, PLATFORM = "3.2.0", "android"
# Identity now lives in voisa_pkg.account; re-exported here so `voisa.py` keeps
# working as the CLI entry point.
from voisa_pkg.account import (  # noqa: E402,F401
    SERVER, API, SOCK_PATH, APP_VERSION, PLATFORM, STORE,
    SERVER_EVENTS,
    create_account, load_store, save_store, new_device_id, ensure_account,
    POOL, load_pool, save_pool, pool_lease, pool_add, pool_status,
    pool_remove, pool_clear, pool_set_username, pool_resolve_names,
)

# real wire events, both directions
SERVER_EVENTS = [
    "check-version", "fetch-initial-data", "start-dialog", "close-dialog",
    "webrtc", "ban-update", "set-premium", "update-user", "share-contacts",
]
CLIENT_EVENTS = [
    "start-search", "stop-search", "sync-call-state", "start-dialog",
    "close-dialog", "close-dialog-v1", "webrtc", "set-search-language",
    "shuffle-username", "update-avatar",
    # bidirectional: the dialog acknowledgement
    "buffer-dialog",
]
ALL_EVENTS = sorted(set(SERVER_EVENTS + CLIENT_EVENTS))


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


# commands
def cmd_new(a):
    print(json.dumps(ensure_account(a.device_id, force_new=True), indent=2))


def cmd_whoami(a):
    print(json.dumps(ensure_account(a.device_id), indent=2))


def cmd_login(a):
    acct = create_account(a.device_id)
    save_store({"deviceId": a.device_id, "cookie": acct["cookie"], "created": time.time()})
    print(json.dumps({"deviceId": a.device_id, "cookie": acct["cookie"]}, indent=2))


def _session(acct, on_ready=None, log=print):
    log(f"[account] deviceId={acct['deviceId']} cookie={acct['cookie']}")
    sio = connect(acct["cookie"], log)
    if on_ready:
        time.sleep(1.0)
        on_ready(sio, log)
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("\n[client] bye")
        sio.disconnect()


def cmd_listen(a):
    _session(ensure_account(a.device_id))


def cmd_search(a):
    def go(sio, log):
        sio.emit("start-search", {"searchLanguage": a.lang})
        log(f"[client] -> start-search {a.lang}")
        log("[client] waiting for start-dialog (or close-dialog on expiry) …")
    _session(ensure_account(a.device_id), go)


def cmd_match(a):
    """Queue N peers from this host and log whatever the server does."""
    n = a.peers
    log = print
    peers = []
    for i in range(n):
        acct = ensure_account(new_device_id(), force_new=True)
        sio = connect(acct["cookie"], lambda m, i=i: log(f"[P{i}] {m}"))
        peers.append((i, acct, sio))
        time.sleep(0.4)
    time.sleep(0.5)
    for i, acct, sio in peers:
        sio.emit("start-search", {"searchLanguage": a.lang})
        log(f"[P{i}] -> start-search ({acct['deviceId']})")
    log(f"[client] {n} peers queued; observing {a.wait}s …")
    try:
        time.sleep(a.wait)
    except KeyboardInterrupt:
        pass
    for _, _, sio in peers:
        try: sio.disconnect()
        except Exception: pass


def cmd_repl(a):
    acct = ensure_account(a.device_id)
    print(f"[account] deviceId={acct['deviceId']} cookie={acct['cookie']}")
    sio = connect(acct["cookie"])
    print("[repl] emit:  <event> <json>      e.g.  start-search {\"searchLanguage\":\"en\"}")
    print("[repl]        :events   :server   :client   :q")
    try:
        while True:
            line = input("voisa> ").strip()
            if not line:
                continue
            if line in (":q", ":quit", "exit"):
                break
            if line == ":events":
                print("  " + ", ".join(ALL_EVENTS)); continue
            if line == ":server":
                print("  " + ", ".join(SERVER_EVENTS)); continue
            if line == ":client":
                print("  " + ", ".join(CLIENT_EVENTS)); continue
            parts = line.split(None, 1)
            payload = {}
            if len(parts) > 1:
                try: payload = json.loads(parts[1])
                except json.JSONDecodeError:
                    print("[repl] bad json"); continue
            sio.emit(parts[0], payload)
            print(f"[client] -> {parts[0]} {json.dumps(payload)}")
    except (KeyboardInterrupt, EOFError):
        pass
    finally:
        sio.disconnect(); print("[client] bye")


def main():
    ap = argparse.ArgumentParser(description="Voisa standalone client")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("whoami"); p.add_argument("--device-id"); p.set_defaults(fn=cmd_whoami)
    p = sub.add_parser("new");    p.add_argument("--device-id"); p.set_defaults(fn=cmd_new)
    p = sub.add_parser("login");  p.add_argument("--device-id", required=True); p.set_defaults(fn=cmd_login)
    p = sub.add_parser("listen"); p.add_argument("--device-id"); p.set_defaults(fn=cmd_listen)
    p = sub.add_parser("search"); p.add_argument("--device-id"); p.add_argument("--lang", default="en"); p.set_defaults(fn=cmd_search)
    p = sub.add_parser("match");  p.add_argument("--peers", type=int, default=2); p.add_argument("--lang", default="en"); p.add_argument("--wait", type=int, default=60); p.set_defaults(fn=cmd_match)
    p = sub.add_parser("repl");   p.add_argument("--device-id"); p.set_defaults(fn=cmd_repl)

    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
