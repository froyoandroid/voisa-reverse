# Voisa — code layout

Entry points at the root stay stable (systemd runs `webui.py`); the code lives in packages.

```
webui.py              entry point -> voisa_server.app:main
voisa.py              public library facade + client CLI
voisa_call.py         call-engine facade + call CLI

voisa_server/         FastAPI web server (localhost only, nginx in front)
  app.py              app factory, static mount, main()
  config.py           paths and settings
  logs.py             voisa.log writer (tagged per tab, trimmed to 24 h)
  ws.py               /ws channel: receive loop, error isolation, cleanup
  commands.py         one handler per browser command (COMMANDS table)
  sessions.py         Session: one tab <-> one async upstream socket (signalling relay)
  relay.py            relay (MITM) legs, one BridgeCall + identity each
  server_call.py      legacy server-side aiortc call (`call` command)
  routes/             HTTP API by area
    pages.py          index.html with cache-busted assets
    identity.py       /api/state, /api/new, /api/saved*, /api/pool*, /api/login
    recordings.py     /api/recordings*   (server-side call media)
    relay_recordings.py /api/mitm/rec*   (relay leg uploads)
    logs.py           /api/log*

voisa_pkg/            client library
  protocol.py         endpoints, version, event names, socket URL
  paths.py            data file locations (project root)
  identity/           account.py, saved.py, pool.py
  client.py           blocking socket helpers
  call/               standalone.py (VoisaCall), bridge/ (BridgeCall: core,
                      signalling, peer, recording mixins)
  media/              player.py, recorder.py, synthetic.py
  webrtc.py           ICE helpers
  cli/                voisa_cli.py, call_cli.py
  account.py, audio.py  compatibility shims

ui/
  index.html          markup; loads css/ in numbered order, then js/
  css/01-15-*.css     cascade order matters: tokens, base, shell, ... overrides last
  js/core/            state, log, socket, message router, redaction
  js/call/            Call view (stage, deck, events, peer card, search, talk)
  js/rtc/             browser WebRTC peer, negotiation, recording
  js/identity/        identity sheet
  js/recordings/      recordings list
  js/relay/           relay legs, bridge audio, OPFS recording, pool
  js/shell/           views, theme, sidebar
  js/dev/             raw event emitter
  js/main.js          boot; loaded last
```

## Conventions

- Front-end files are classic scripts sharing one global scope, loaded in the
  order index.html lists them. Anything that runs at load time goes in
  `js/main.js` so every function exists first.
- New browser command: add `async def cmd_<name>(sess, msg)` in
  `voisa_server/commands.py` and register it in `COMMANDS`.
- New HTTP area: a router module in `voisa_server/routes/`, added to `ROUTERS`.
- Identity is per browser tab and never shared between live sessions.
