# Voisa — code layout

The backend is one Go binary (signalling relay, REST API, static UI). The
browser is the WebRTC peer for the Call view and for both relay legs, so the
server never touches media.

```
cmd/voisa/main.go     entry point: flags, localhost guard, graceful shutdown
internal/
  protocol/           Voisa endpoints, app version, server events, socket URL
  sio/                minimal Socket.IO v4 client (engine.io 4, websocket):
                      handshake, ping/pong, events, acks, reconnect
  account/            createAccount, device ids, fresh/register identities
  store/              voisa_pool.json (LRU lease) and voisa_saved.json
  users/              anonymous owners: voisa_uid cookie -> users/<id>/
  recs/               recordings in users/<id>/media: chunk append, sidecar
                      meta, ffmpeg remux on stop, 24 h janitor
  logs/               voisa.log writer, trimmed to 24 h
  server/
    http.go           routes, static files, index cache-busting, /ws handler
    session.go        one browser tab <-> one upstream socket (Call path)
    leg.go            relay legs A/B: own identity + socket, requeue, loopback
    commands.go       /ws command table
    recordings.go     /api/recordings and /api/rec/{start,chunk,stop}
    util.go           JSON and log-format helpers

ui/
  index.html          markup; loads css/ in numbered order, then js/
  css/01-17-*.css     cascade order matters: tokens, base, shell, ... overrides last
  js/core/            state, prefs (Settings), log, socket, message router, redaction
  js/call/            Call view (stage, deck, events, peer card, search, talk)
  js/rtc/             browser WebRTC peer, negotiation, recording
  js/identity/        identity sheet
  js/recordings/      ServerRec uploader, shared rows, call recordings list
  js/relay/           relay legs, bridge audio, relay recording, pool
  js/shell/           views, theme, sidebar
  js/settings/        Settings view: audio, call, relay, storage
  js/main.js          boot; loaded last
```

## Build and run

```
go build -o bin/voisa ./cmd/voisa
bin/voisa --host 127.0.0.1 --port 8765 --root .
```

`--root` holds `ui/`, the server log `voisa.log`, and `users/` (gitignored).
systemd runs it as `voisa.service` behind nginx.

## Users

There is no login. Each browser gets an anonymous HttpOnly cookie,
`voisa_uid`, and its own `users/<id>/`: `voisa_pool.json`,
`voisa_saved.json` (live Voisa cookies), `voisa.log` (what the Logs view
shows) and `media/`. One owner never sees another's data, even on the same
network. Inside an owner, each tab still has its own Voisa identity
(sessionStorage), and no identity is ever live in two sessions server-wide.

Identities (user rules): opening the page creates nothing. The tab sends a
lazy `connect`, and the identity is picked at the first action that needs
Voisa (`needsUpstream` in commands.go: search, emit, accept, ...). The order
is the tab's own identity, then the browser's (`users/<id>/identity.json`,
kept 24 hours from when it was taken, so it survives closing the tab), then
a new one. A second open tab gets its own. After 24 hours the next action
makes a new one, never in the middle of a call. Relay legs mint brand-new
identities on every Start (`/api/relay/fresh`), never from the pool.

Old single-user data in the root is adopted once via `/?claim=<token>`, with
the token in `users/CLAIM_TOKEN`.

## Recordings

The browser records (MediaRecorder) and the server stores. `ServerRec`
(`js/recordings/upload.js`) calls `POST /api/rec/start`, then uploads every
1 s chunk in order to `/api/rec/<name>/chunk?seq=n`, then `/stop`. The server
appends each chunk at once (`internal/recs`), so a closed tab keeps
everything up to the last second; a recording with no chunk for 20 s is
closed on its own. On stop, ffmpeg remuxes it (`-c copy`) so players get a
duration and can seek. Each recording is deleted 24 hours after it started
(janitor every 5 min). Old `incoming-*` files from the removed server engine
are listed as "Old" and never auto-deleted.

A call recording is both sides (peer and mic) mixed in an AudioContext. A
relay recording is three files, A, B and the A+B mix, sharing one group.
Browser storage (OPFS) is no longer written; Settings > Storage can remove
leftovers from before.

## Settings

Per-browser preferences in localStorage `voisa:settings` (`js/core/prefs.js`):
mic and speaker devices, echo, noise and gain processing, start muted,
default language, keep searching, auto-record calls and relay. Never
identities or cookies.

## Conventions

- Front-end files are classic scripts sharing one global scope, loaded in the
  order index.html lists them. Anything that runs at load time goes in
  `js/main.js` so every function exists first.
- New browser command: add `func cmdX(s *Session, msg M) error` in
  `internal/server/commands.go` and register it in `commands`.
- New HTTP route: register it in `server.New` (`internal/server/http.go`).
  Keep FastAPI-style error bodies: `{"detail": ...}`.
- Identity is per browser tab and never shared between live sessions
  (`cookiesInUse`).
- Never hold a session or leg mutex across network I/O.
- Per-user data goes through `users.For(w, r)` (or `Session.user`), never a
  package global.
