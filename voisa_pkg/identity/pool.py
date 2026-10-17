"""Identity pool for relay legs.

Accounts are long-lived assets, not per-call throwaways.

A fresh account created seconds before a call is the anomaly: its createdAt
clusters with the call, it has no history, and every leg we minted used to be
stamped "voisa-py-". A pool of accounts that already exist, age, and get
reused looks like an ordinary returning user.

The pool file is gitignored: it holds live cookies.
"""
import contextlib, json, os, threading

from voisa_pkg.paths import POOL
from voisa_pkg.protocol import SERVER, SOCK_PATH, APP_VERSION, PLATFORM
from voisa_pkg.identity.account import create_account, new_device_id, _now


def load_pool() -> list:
    try:
        with open(POOL) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, ValueError):
        return []


# Serialises every pool read-modify-write. Without this, two legs starting at
# the same instant both read the file, both pick the same entry and the second
# write clobbers the first — handing one account to two legs.
_POOL_LOCK = threading.RLock()


@contextlib.contextmanager
def _pool_guard():
    with _POOL_LOCK:
        yield


def save_pool(entries: list) -> None:
    # unique tmp per writer: a shared name lets concurrent writers delete each
    # other's temp file mid-replace (FileNotFoundError on os.replace)
    tmp = f"{POOL}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w") as f:
        json.dump(entries, f, indent=2)
    os.replace(tmp, POOL)


def pool_lease(min_age_s: float = 0, log=print, exclude=None) -> dict:
    """Take an identity from the pool, creating one if the pool is empty.

    Least-recently-used, so identities are rotated rather than reused back to
    back. The whole read-pick-write runs under a lock: two legs starting at the
    same instant used to read the file together, both pick the same entry, and
    the second write clobbered the first — two "separate" legs ended up on one
    account.

    Returns {"deviceId", "cookie", "created", "uses"}.
    """
    import time as _t
    with _pool_guard():
        entries = load_pool()
        now = _t.time()
        busy = set(exclude or ())
        # skip identities a live session already holds (identity is per session)
        usable = [e for e in entries if e.get("cookie") and e["cookie"] not in busy]
        if min_age_s:
            aged = [e for e in usable if now - e.get("created", now) >= min_age_s]
            if aged:
                usable = aged
        if usable:
            pick = min(usable, key=lambda e: (e.get("last_used") or 0,
                                               e.get("created", 0)))

            pick["uses"] = pick.get("uses", 0) + 1
            pick["last_used"] = now
            save_pool(entries)
            log(f"[pool] lease {pick['deviceId']} "
                f"(age {(now - pick.get('created', now)) / 60:.0f}m, "
                f"use #{pick['uses']}, {len(entries) - 1} other(s) idle)")
            return pick

        did = new_device_id()
        acct = create_account(did)
        entry = {"deviceId": did, "cookie": acct["cookie"], "created": now,
                 "uses": 1, "last_used": now}
        entries.append(entry)
        save_pool(entries)
        log(f"[pool] empty -> created {did}")
        return entry


def pool_add(n: int = 1, log=print) -> list:
    """Pre-create identities so the pool has a stock of usable accounts.

    They are not touched by a call until leased, so they simply age — which is
    the point: an account with days of history beats one minted mid-session.
    """
    count = max(1, n)
    made = []
    for _ in range(count):
        did = new_device_id()
        acct = create_account(did)
        made.append({"deviceId": did, "cookie": acct["cookie"], "created": _now(),
                     "uses": 0, "last_used": None})
    with _pool_guard():
        entries = load_pool()
        entries.extend(made)
        save_pool(entries)
    for entry in made:
        log(f"[pool] + {entry['deviceId']}")
    return made


def pool_resolve_names(log=print) -> dict:
    """Fill in missing usernames by connecting each nameless entry once.

    The nickname is only disclosed over the socket, so entries created before
    name tracking have none. One short connection per entry (~5s each, HTTP +
    socket, no search) fixes that. Entries that fail to resolve keep no name
    rather than blocking the rest.
    """
    import socketio as _sio
    resolved = {}
    with _pool_guard():
        entries = load_pool()
        missing = [e for e in entries if e.get("cookie") and not e.get("username")]
    for e in missing:
        name = None
        try:
            sio = _sio.Client(reconnection=False, request_timeout=15)
            box = {}
            sio.on("fetch-initial-data",
                   lambda *a: box.setdefault("user", (a[0] if a else {}).get("userData", {})))
            q = (f"?cookie={e['cookie']}&version={APP_VERSION}&platform={PLATFORM}"
                 f"&rawLanguage=en-GB&language=en&currentTheme=system")
            sio.connect(f"{SERVER}/{q}", transports=["websocket"],
                        wait_timeout=15, socketio_path=SOCK_PATH)
            import time as _t
            for _ in range(50):
                if "user" in box:
                    break
                _t.sleep(0.1)
            try:
                sio.disconnect()
            except Exception:
                pass
            name = (box.get("user") or {}).get("username")
        except Exception as ex:
            log(f"[pool] resolve {e.get('deviceId')}: {ex}")
        if name:
            pool_set_username(name, device_id=e.get("deviceId"),
                              cookie=e.get("cookie"), log=log)
            resolved[e.get("deviceId")] = name
        else:
            log(f"[pool] resolve {e.get('deviceId')}: no name (dead cookie?)")
    return resolved


def pool_remove(device_id: str, log=print) -> bool:
    """Drop one identity from the pool. Returns True if it was there.

    Removal is local only: it forgets the identity here and leaves the account
    intact on Voisa's side. Deleting the server-side account would need an
    endpoint we never observed, and abandoning an account mid-life is a louder
    signal than keeping a quiet one unused.
    """
    with _pool_guard():
        entries = load_pool()
        keep = [e for e in entries if e.get("deviceId") != device_id]
        if len(keep) == len(entries):
            return False
        save_pool(keep)
        log(f"[pool] removed {device_id} ({len(keep)} left)")
        return True


def pool_set_username(username: str, device_id: str | None = None,
                       cookie: str | None = None, log=print) -> bool:
    """Record the server-assigned nickname on a pool entry.

    The nickname is only disclosed over the socket (fetch-initial-data's
    userData), after the entry was created — so it is filled in late, matched
    by deviceId first, then cookie. Returns True if an entry was updated.
    """
    if not username:
        return False
    with _pool_guard():
        entries = load_pool()
        for e in entries:
            if ((device_id and e.get("deviceId") == device_id)
                    or (cookie and e.get("cookie") == cookie)):
                if e.get("username") == username:
                    return True
                e["username"] = username
                save_pool(entries)
                log(f"[pool] name {e['deviceId']} -> {username!r}")
                return True
        return False


def pool_clear(log=print) -> int:
    """Forget every identity. Returns how many were removed."""
    with _pool_guard():
        n = len(load_pool())
        save_pool([])
        log(f"[pool] cleared {n} identity(ies)")
        return n


def pool_status() -> list:
    import time as _t
    now = _t.time()
    out = []
    for e in load_pool():
        # cookie never leaves the server: the browser needs deviceId (for del)
        # and username (for display), nothing else
        out.append({"deviceId": e.get("deviceId"), "username": e.get("username"),
                    "created": e.get("created"), "uses": e.get("uses", 0),
                    "last_used": e.get("last_used"),
                    "age_min": round((now - e.get("created", now)) / 60, 1)})
    return out
