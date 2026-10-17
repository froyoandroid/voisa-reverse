"""The single-page UI and its cache-busted assets."""
import os, re

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from voisa_server.config import UI_DIR

router = APIRouter()


def _asset_version() -> str:
    """mtime stamp of the newest UI asset; busts the browser cache on edit."""
    newest = 0.0
    for dirpath, _dirs, files in os.walk(UI_DIR):
        for f in files:
            if f.endswith((".css", ".js", ".html")):
                newest = max(newest, os.path.getmtime(os.path.join(dirpath, f)))
    return str(int(newest))


@router.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(UI_DIR, "index.html")) as f:
        html = f.read()
    # stamp every local asset URL so an edited file is never served stale
    v = _asset_version()
    html = re.sub(r'(/static/[\w./-]+\.(?:css|js))(?=")', rf"\1?v={v}", html)
    return HTMLResponse(html, headers={"Cache-Control": "no-store"})
