"""Call recordings saved by the server-side call engine (media/)."""
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from voisa_server.config import MEDIA_DIR

router = APIRouter()


def _rec_entry(name: str) -> dict:
    p = os.path.join(MEDIA_DIR, name)
    st = os.stat(p)
    return {"name": name, "bytes": st.st_size, "mtime": int(st.st_mtime),
            "kind": "audio" if name.endswith(".wav") else "video"}


@router.get("/api/recordings")
async def recordings():
    try:
        names = [n for n in os.listdir(MEDIA_DIR)
                 if n.startswith("incoming-") and n.endswith((".wav", ".ivf"))]
    except FileNotFoundError:
        names = []
    out = []
    for n in names:
        try:
            out.append(_rec_entry(n))
        except OSError:
            pass
    out.sort(key=lambda e: e["mtime"], reverse=True)
    # deliberately no "dir": this endpoint is reachable over the public site and
    # the absolute path leaked the server's filesystem layout. The UI does not
    # need it; recordings are fetched by name from /api/recordings/{name}.
    return {"files": out, "total_bytes": sum(e["bytes"] for e in out)}


@router.get("/api/recordings/{name}")
async def recording_file(name: str):
    # no path traversal: only the basename, only our own naming
    if os.path.basename(name) != name or not name.startswith("incoming-"):
        raise HTTPException(status_code=400, detail="bad name")
    p = os.path.join(MEDIA_DIR, name)
    if not os.path.isfile(p):
        raise HTTPException(status_code=404, detail="not found")
    return FileResponse(p, filename=name,
                        media_type="audio/wav" if name.endswith(".wav") else "video/x-ivf")


@router.delete("/api/recordings/{name}")
async def recording_delete(name: str):
    if os.path.basename(name) != name or not name.startswith("incoming-"):
        raise HTTPException(status_code=400, detail="bad name")
    p = os.path.join(MEDIA_DIR, name)
    try:
        os.remove(p)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="not found")
    return {"deleted": name}


@router.delete("/api/recordings")
async def recordings_clear():
    n = 0
    try:
        for name in os.listdir(MEDIA_DIR):
            if name.startswith("incoming-") and name.endswith((".wav", ".ivf")):
                os.remove(os.path.join(MEDIA_DIR, name))
                n += 1
    except FileNotFoundError:
        pass
    return {"deleted": n}
