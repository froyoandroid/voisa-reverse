"""Saved identities: the user's personal shelf for the Call view.

The pool serves relay legs (leased least-recently-used); this list holds the
identities a user kept so they can switch back to one they liked.
"""
import json, os, threading

from voisa_pkg.paths import SAVED
from voisa_pkg.identity.account import _now


_SAVED_LOCK = threading.RLock()


def load_saved() -> list:
    try:
        with open(SAVED) as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (FileNotFoundError, ValueError):
        return []


def save_saved(entries: list) -> None:
    tmp = f"{SAVED}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w") as f:
        json.dump(entries, f, indent=2)
    os.replace(tmp, SAVED)


def saved_add(device_id: str, cookie: str, username: str | None = None) -> dict:
    with _SAVED_LOCK:
        entries = load_saved()
        entry = next((e for e in entries if e.get("deviceId") == device_id), None)
        if entry:
            entry["cookie"] = cookie
            if username:
                entry["username"] = username
        else:
            entry = {"deviceId": device_id, "cookie": cookie, "username": username,
                     "created": _now(), "uses": 0}
            entries.append(entry)
        save_saved(entries)
        return entry


def saved_remove(device_id: str) -> bool:
    with _SAVED_LOCK:
        entries = load_saved()
        kept = [e for e in entries if e.get("deviceId") != device_id]
        if len(kept) == len(entries):
            return False
        save_saved(kept)
        return True


def saved_take(device_id: str) -> dict | None:
    with _SAVED_LOCK:
        entries = load_saved()
        for e in entries:
            if e.get("deviceId") == device_id and e.get("cookie"):
                e["uses"] = e.get("uses", 0) + 1
                save_saved(entries)
                return dict(e)
        return None


def saved_status() -> list:
    return [{"deviceId": e.get("deviceId"), "username": e.get("username"),
             "created": e.get("created"), "uses": e.get("uses", 0)}
            for e in load_saved()]
