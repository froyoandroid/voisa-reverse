"""FastAPI application: routes, static UI and the /ws channel."""
import argparse, os, sys

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from voisa_server.config import UI_DIR, HOST, PORT
from voisa_server.routes import ROUTERS
from voisa_server import ws


def create_app() -> FastAPI:
    app = FastAPI(title="Voisa Local", docs_url=None, redoc_url=None, openapi_url=None)
    for r in ROUTERS:
        app.include_router(r)
    app.include_router(ws.router)
    if os.path.isdir(UI_DIR):
        app.mount("/static", StaticFiles(directory=UI_DIR), name="static")
    return app


app = create_app()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=HOST, help="localhost only (do not change)")
    ap.add_argument("--port", type=int, default=PORT)
    a = ap.parse_args()

    if a.host not in ("127.0.0.1", "localhost", "::1"):
        print(f"refusing to bind {a.host}: this UI is localhost-only")
        sys.exit(2)

    import uvicorn
    print(f"Voisa local UI -> http://{a.host}:{a.port}  (localhost only)")
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")
