"""Read, clear and download voisa.log."""
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from voisa_server.config import LOG_FILE

router = APIRouter()


@router.get("/api/log")
async def get_log(lines: int = 500):
    try:
        with open(LOG_FILE, "r", encoding="utf-8", errors="replace") as f:
            data = f.readlines()
    except FileNotFoundError:
        data = []
    tail = data[-max(1, min(lines, 20000)):]
    return {"path": LOG_FILE,
            "total_lines": len(data),
            "bytes": os.path.getsize(LOG_FILE) if os.path.exists(LOG_FILE) else 0,
            "lines": [l.rstrip("\n") for l in tail]}


@router.delete("/api/log")
async def clear_log():
    try:
        os.remove(LOG_FILE)
    except FileNotFoundError:
        pass
    return {"cleared": True}


@router.get("/api/log/download")
async def download_log():
    if not os.path.exists(LOG_FILE):
        raise HTTPException(status_code=404, detail="no log yet")
    return FileResponse(LOG_FILE, filename="voisa.log", media_type="text/plain")
