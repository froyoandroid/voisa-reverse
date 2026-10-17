"""Voisa web server (localhost-only; nginx in front).

    app               FastAPI app factory and main()
    config            paths and settings
    logs              voisa.log writer
    routes/           HTTP API, one module per area
    ws                the /ws channel
    commands          one handler per browser command
    sessions          Session: one tab <-> one upstream signalling socket
    relay             relay (MITM) legs
    server_call       legacy server-side call (aiortc)
"""
