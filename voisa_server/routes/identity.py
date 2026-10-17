"""Identities: mint, lease from the pool, the saved shelf, legacy login."""
import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

import voisa
from voisa_pkg.identity import saved_add, saved_remove, saved_status, saved_take
from voisa_server.logs import logfile
from voisa_server.sessions import _cookies_in_use

router = APIRouter()


# REST
@router.get("/api/state")
async def state():
    # Identity is per-session now: each browser session holds its own identity
    # (in localStorage) and supplies it on connect. This endpoint deliberately
    # does NOT return a shared account cookie — serving one here is exactly what
    # made identity global, and on a network-reachable page it also handed the
    # bearer credential to anyone who asked.
    return {"has_account": False, "per_session": True}


@router.post("/api/new")
def api_new():
    # Lease an identity from the pool rather than always minting a fresh one.
    #
    # A brand-new account created seconds before a call is the anomaly: no
    # history, createdAt clustered with the call, and previously stamped
    # "voisa-py-". An aged, reused account looks like a returning user.
    #
    # Not adopted as the stored default, for the same reason as api_login:
    # concurrent tabs and legs each need their own identity.
    # Never lease an identity another live session is already using — that is
    # exactly how two tabs ended up showing the same "new" identity.
    entry = voisa.pool_lease(log=lambda m: logfile(m, "pool"),
                             exclude=_cookies_in_use())
    return {"deviceId": entry["deviceId"], "cookie": entry["cookie"]}


@router.get("/api/pool")
def api_pool():
    """Identifier pool: aged identities reused across calls."""
    return {"entries": voisa.pool_status()}


@router.get("/api/saved")
def api_saved_list():
    return {"entries": saved_status()}


@router.post("/api/saved")
def api_saved_add(body: dict = None):
    b = body or {}
    did, cookie = str(b.get("deviceId", "")), str(b.get("cookie", ""))
    if not did or not cookie:
        return JSONResponse({"error": "deviceId and cookie required"}, status_code=400)
    saved_add(did, cookie, b.get("username"))
    logfile(f"[saved] identity {did} stored", "sys")
    return {"saved": did}


@router.post("/api/saved/use")
def api_saved_use(body: dict = None):
    did = str((body or {}).get("deviceId", ""))
    e = saved_take(did)
    if not e:
        return JSONResponse({"error": "not saved"}, status_code=404)
    logfile(f"[saved] identity {did} adopted", "sys")
    return {"deviceId": e["deviceId"], "cookie": e["cookie"], "username": e.get("username")}


@router.delete("/api/saved/{device_id}")
def api_saved_del(device_id: str):
    return {"removed": saved_remove(device_id)}


@router.post("/api/pool/add")
def api_pool_add(body: dict = None):
    n = int((body or {}).get("n", 1))
    n = max(1, min(n, 20))
    made = voisa.pool_add(n, log=lambda m: logfile(m, "pool"))
    return {"added": [e["deviceId"] for e in made], "total": len(voisa.load_pool())}


@router.delete("/api/pool/{device_id}")
def api_pool_remove(device_id: str):
    ok = voisa.pool_remove(device_id, log=lambda m: logfile(m, "pool"))
    if not ok:
        raise HTTPException(404, "no such identity")
    return {"removed": device_id, "total": len(voisa.load_pool())}


@router.post("/api/pool/clear")
def api_pool_clear():
    n = voisa.pool_clear(log=lambda m: logfile(m, "pool"))
    return {"cleared": n}


@router.post("/api/pool/resolve_names")
async def api_pool_resolve_names():
    """Backfill missing nicknames: one short socket connection per entry."""
    resolved = await asyncio.get_event_loop().run_in_executor(
        None, lambda: voisa.pool_resolve_names(
            log=lambda m: logfile(m, "pool")))
    return {"resolved": resolved, "total": len(voisa.load_pool())}


@router.post("/api/login")
def api_login(body: dict):
    did = (body or {}).get("deviceId")
    if not did:
        raise HTTPException(400, "deviceId required")
    acct = voisa.create_account(did)
    # Do NOT overwrite the stored account here. Logging a second tab in would
    # otherwise hijack the first tab's identity — two relays would collapse onto
    # one account and fight over the same match. The cookie is returned so the
    # caller can adopt it for its own session only. Use the "make default"
    # action if you actually want to change what a fresh page load uses.
    return {"deviceId": did, "cookie": acct["cookie"]}
