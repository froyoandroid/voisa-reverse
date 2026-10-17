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
  store/              voisa_saved.json (the saved-identity shelf)
  users/              anonymous owners: voisa_uid cookie -> users/<id>/
  logs/               voisa.log writer, trimmed to 24 h
  server/
    http.go           routes, static files, index cache-busting, /ws handler
    session.go        one browser tab <-> one upstream socket (Call path)
    leg.go            relay legs A/B: own identity + socket, requeue, loopback
    commands.go       /ws command table
    util.go           JSON and log-format helpers

ui/
  index.html          markup; loads css/ in numbered order, then js/
  css/01-16-*.css     cascade order matters: tokens, base, shell, ... overrides last
  js/core/            state, log, socket, message router, redaction
  js/call/            Call view (stage, deck, events, peer card, search, talk)
  js/rtc/             browser WebRTC peer, negotiation, recording
  js/identity/        identity sheet
  js/recordings/      recordings list
  js/relay/           relay legs, bridge audio, OPFS recording
  js/shell/           views, theme, sidebar
  js/dev/             raw event emitter
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
`voisa_uid`, and its own `users/<id>/`: `identity.json`,
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
identities on every Start (`/api/relay/fresh`). There is no identity pool.

Old single-user data in the root is adopted once via `/?claim=<token>`, with
the token in `users/CLAIM_TOKEN`.

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
