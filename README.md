# Voisa

A self-hosted web client for Voisa random voice calls. One Go binary serves the
UI, a REST API and a WebSocket signalling channel. The browser is the WebRTC
peer, so audio never passes through the server.

![Call view](assets/screenshots/call.png)

## Features

- **Call**: pick a language, press Start, and you're matched with a stranger. The
  mic opens once per tab, and you can mute or unmute it during a call.
- **Relay**: two isolated legs (A and B), each with its own fresh identity. They
  search independently, and Bridge connects the two strangers to each other.
  The label only says "Bridged" once both peers are actually connected.
- **Recordings**: call and relay recordings stream to the server in 1 s chunks.
  ffmpeg remuxes them on stop, and they're deleted 24 h after they start. A relay
  recording saves A, B and the A+B mix.
- **Identity**: a call identity lasts 24 h per browser. Every tab gets its own,
  and none is created until your first action.
- **Identity pool** for the relay legs, plus saved identities.
- **Per-user isolation**: an anonymous HttpOnly cookie (`voisa_uid`) keeps each
  browser's pool, saved identities, logs and recordings separate under
  `users/<id>/`.
- **Settings**: mic, speaker and level test, echo/noise/AGC, start muted, default
  language, keep searching, auto-record. There's also a dark/light theme.

| Relay | Settings |
|---|---|
| ![Relay view](assets/screenshots/relay.png) | ![Settings view](assets/screenshots/settings.png) |

<p align="center"><img src="assets/screenshots/call-mobile.png" width="300" alt="Call view on a phone"></p>

## Requirements

- Go 1.26+
- ffmpeg (for the recordings)
- A reverse proxy with TLS (e.g. nginx). Browsers only allow the microphone on
  HTTPS or localhost.

## Build and run

```sh
go build -o bin/voisa ./cmd/voisa
./bin/voisa --root .            # http://127.0.0.1:8765
```

| Flag     | Default     | Meaning                                    |
|----------|-------------|--------------------------------------------|
| `--port` | `8765`      | listen port                                |
| `--root` | `.`         | project root: `ui/` and the data files     |
| `--host` | `127.0.0.1` | localhost only; any other address is refused |

The server binds to localhost on purpose. Put nginx in front for TLS and
WebSocket upgrades:

```nginx
location / {
    proxy_pass http://127.0.0.1:8765;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
}
```

### systemd

```sh
sudo systemctl enable --now voisa     # unit runs bin/voisa --root <app dir>
sudo systemctl restart voisa          # after rebuilding the binary
```

UI-only changes (`ui/`) don't need a restart; a hard refresh is enough.

## Layout

```
cmd/voisa/        entry point (flags, localhost guard, graceful shutdown)
internal/
  server/         HTTP routes, /ws, call sessions, relay legs, recordings API
  sio/            minimal Socket.IO v4 client for the upstream
  account/        identity creation
  store/          identity pool and saved identities
  users/          anonymous per-browser owners
  recs/           server-side recordings and 24 h janitor
  logs/           voisa.log writer
ui/               index.html, css/ (numbered, cascade order matters), js/<area>/
users/            per-user data (gitignored)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full map.

## Notes

- There is no login. Anyone who can reach the URL can use it, so restrict access
  in nginx (basic auth, an IP allowlist) if the instance is public.
- Data files (`users/`, `voisa.log`, media) and `bin/` are gitignored.
