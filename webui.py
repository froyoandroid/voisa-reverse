#!/usr/bin/env python3
"""Voisa web UI backend: localhost-only entry point.

The server lives in voisa_server/ (see its __init__ for the layout). This file
stays as the entry point so the systemd unit and old commands keep working.

Run:
    .venv/bin/python webui.py --port 8765
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from voisa_server.app import app, main   # noqa: E402,F401

if __name__ == "__main__":
    main()
