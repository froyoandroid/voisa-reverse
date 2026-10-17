#!/usr/bin/env python3
"""voisa.py: public facade of the Voisa client library, plus its CLI.

The code lives in voisa_pkg/ (protocol, identity, client, call, media, cli).
This module re-exports the public API so `import voisa` keeps working for the
server and scripts.

    python voisa.py new | whoami | login | listen | search | match | repl
"""
from voisa_pkg.protocol import *          # noqa: F401,F403
from voisa_pkg.protocol import socket_url, socket_query   # noqa: F401
from voisa_pkg.paths import STORE, POOL, SAVED            # noqa: F401
from voisa_pkg.identity import *          # noqa: F401,F403
from voisa_pkg.client import make_socket, shuffle_username, buffer_dialog, connect  # noqa: F401
from voisa_pkg.cli.voisa_cli import main

if __name__ == "__main__":
    main()
