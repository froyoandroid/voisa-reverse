"""Server settings and paths."""
from voisa_pkg.paths import ROOT, UI_DIR, LOG_FILE, MEDIA_DIR, REC_DIR   # noqa: F401

HERE = ROOT          # project root: data files and the ui/ folder live here

HOST = "127.0.0.1"   # localhost only; nginx fronts it
PORT = 8765

# A day of logs is the useful window: long enough to reconstruct a session that
# ran overnight, short enough that the file never grows without bound.
LOG_MAX_AGE_S = 24 * 3600


# Below this a recording cannot hold a decodable stream (an aborted start, or a
# peer that never sent audio). Stubs are deleted rather than listed, so the UI
# never offers a download that will not play.
REC_MIN_BYTES = 2048
