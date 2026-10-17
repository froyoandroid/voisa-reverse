"""Filesystem locations shared by the library and the server.

Data files live at the project root, next to the entry points, never inside
the package: moving them would orphan existing identities.
"""
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

STORE = os.path.join(ROOT, "voisa_account.json")   # legacy default identity
POOL = os.path.join(ROOT, "voisa_pool.json")       # aged identities for relay legs (gitignored: live cookies)
SAVED = os.path.join(ROOT, "voisa_saved.json")     # identities the user kept for the Call view
MEDIA_DIR = os.path.join(ROOT, "media")
REC_DIR = os.path.join(ROOT, "recordings")
LOG_FILE = os.path.join(ROOT, "voisa.log")
UI_DIR = os.path.join(ROOT, "ui")
