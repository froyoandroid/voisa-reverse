"""Account identity for the Voisa client.

An account is just a deviceId plus a server-issued cookie:

    POST /api/v0/createAccount {"deviceId": "..."}  ->  {"cookie": "<uuid>"}

The cookie is the whole credential — every socket connection passes it as a
query parameter. There is no password and no login; reusing the deviceId
reuses the cookie, and a new deviceId mints a fresh identity (and a fresh
server-assigned nickname).

Nothing here touches audio or media.
"""
import json, time, uuid

import requests

from voisa_pkg.paths import STORE
from voisa_pkg.protocol import API


# account
def create_account(device_id: str) -> dict:
    r = requests.post(API, json={"deviceId": device_id}, timeout=15,
                      headers={"Content-Type": "application/json",
                               "Accept": "application/json"})
    r.raise_for_status()
    return r.json()


def load_store() -> dict:
    try:
        with open(STORE) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_store(d: dict) -> None:
    with open(STORE, "w") as f:
        json.dump(d, f, indent=2)


def new_device_id() -> str:
    """A device id in the shape the app itself uses.

    The real client's id is 16 hex chars with no prefix: the id stored on the
    device as `userId: "4b5590cc2269xxxx"  # shape example, not a real id` round-trips through createAccount and
    returns that device's own cookie, so userId IS the deviceId it sent.

    This used to be "voisa-py-<hex>", which stamped every account we created as
    a Python client — a far stronger fingerprint than any display name, and
    present on every leg we minted. Do not reintroduce a prefix.
    """
    return uuid.uuid4().hex[:16]


def create_fresh() -> dict:
    """Mint a brand-new identity WITHOUT touching the shared global store.

    This is what makes identity *per session*: every browser session that has
    no identity of its own gets a freshly minted deviceId+cookie here, instead
    of everyone falling back onto the single global ``voisa_account.json``. The
    caller (the web session, or the browser via localStorage) is responsible
    for remembering it.
    """
    did = new_device_id()
    acct = create_account(did)
    return {"deviceId": did, "cookie": acct["cookie"], "created": time.time()}


def register(device_id: str) -> dict:
    """Idempotently fetch the cookie for a specific deviceId.

    Does not write the global store — used when a browser session supplies its
    own remembered deviceId.
    """
    acct = create_account(device_id)
    return {"deviceId": device_id, "cookie": acct["cookie"]}


def ensure_account(device_id: str | None = None, force_new: bool = False) -> dict:
    st = load_store()
    if force_new:
        device_id = device_id or new_device_id()
    if device_id is None:
        device_id = st.get("deviceId") or new_device_id()
    if not force_new and st.get("deviceId") == device_id and st.get("cookie"):
        return st
    acct = create_account(device_id)
    st = {"deviceId": device_id, "cookie": acct["cookie"], "created": time.time()}
    save_store(st)
    return st


def _now() -> float:
    import time as _t
    return _t.time()
