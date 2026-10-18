// Package server is the web UI backend: the single-page UI, its REST API and
// the /ws channel each browser tab talks over.
package server

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"voisa/internal/account"
	"voisa/internal/logs"
	"voisa/internal/protocol"
	"voisa/internal/sio"
	"voisa/internal/users"
)

var (
	root  string
	uiDir string
)

// New builds the HTTP handler for a project root (data files and ui/).
func New(projectRoot string) http.Handler {
	root = projectRoot
	uiDir = filepath.Join(root, "ui")
	logs.Init(filepath.Join(root, "voisa.log"))
	if err := users.Init(root); err != nil {
		panic(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", index)
	mux.Handle("GET /static/", staticFiles())
	mux.HandleFunc("GET /ws", wsHandler)

	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		// Identity is per session: no shared account cookie is ever served.
		writeJSON(w, 200, M{"has_account": false, "per_session": true})
	})
	mux.HandleFunc("POST /api/new", limited(apiNew))
	mux.HandleFunc("POST /api/relay/fresh", limited(apiRelayFresh))
	mux.HandleFunc("GET /api/pool", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"entries": users.For(w, r).Pool.Status()})
	})
	mux.HandleFunc("POST /api/pool/add", limited(apiPoolAdd))
	mux.HandleFunc("DELETE /api/pool/{device_id}", apiPoolRemove)
	mux.HandleFunc("POST /api/pool/clear", func(w http.ResponseWriter, r *http.Request) {
		u := users.For(w, r)
		writeJSON(w, 200, M{"cleared": u.Pool.Clear(userLog(u, "pool"))})
	})
	mux.HandleFunc("POST /api/pool/resolve_names", limited(apiResolveNames))
	mux.HandleFunc("GET /api/saved", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"entries": users.For(w, r).Saved.Status()})
	})
	mux.HandleFunc("POST /api/saved", apiSavedAdd)
	mux.HandleFunc("POST /api/saved/use", apiSavedUse)
	mux.HandleFunc("DELETE /api/saved/{device_id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"removed": users.For(w, r).Saved.Remove(r.PathValue("device_id"))})
	})

	mux.HandleFunc("GET /api/log", apiLog)
	mux.HandleFunc("DELETE /api/log", func(w http.ResponseWriter, r *http.Request) {
		_ = os.Remove(users.For(w, r).Log())
		writeJSON(w, 200, M{"cleared": true})
	})
	mux.HandleFunc("GET /api/log/download", func(w http.ResponseWriter, r *http.Request) {
		lp := users.For(w, r).Log()
		if _, err := os.Stat(lp); err != nil {
			writeJSON(w, 404, M{"detail": "no log yet"})
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="voisa.log"`)
		http.ServeFile(w, r, lp)
	})

	recordingRoutes(mux)

	return secureHeaders(sameOrigin(withNotFound(mux)))
}

// secureHeaders sets defensive response headers on every reply. The CSP is
// strict: scripts load only from this origin (plus the one inline bootstrap
// script, which carries a per-request nonce), the page cannot be framed, and
// the browser talks to no other origin.
func secureHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		h.Set("Cross-Origin-Opener-Policy", "same-origin")
		h.Set("Permissions-Policy", "microphone=(self), camera=(), geolocation=(), payment=()")
		next.ServeHTTP(w, r)
	})
}

// csp returns the Content-Security-Policy for the index, which locks the
// page to its own origin. The inline bootstrap script is allowed by nonce.
// Inline styles stay allowed because the UI sets element styles directly.
// The page cannot be embedded anywhere.
func csp(nonce, host string) string {
	ws := ""
	if host != "" && !strings.ContainsAny(host, " ;'\"") {
		ws = " wss://" + host + " ws://" + host
	}
	return "default-src 'self'; " +
		"script-src 'self' 'nonce-" + nonce + "'; " +
		"style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; " +
		"media-src 'self' blob:; " +
		"font-src 'self'; " +
		"connect-src 'self'" + ws + "; " +
		"object-src 'none'; " +
		"base-uri 'self'; " +
		"form-action 'self'; " +
		"frame-ancestors 'none'"
}

// withNotFound answers unknown paths the way the old server did.
func withNotFound(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pattern == "" {
			writeJSON(w, 404, M{"detail": "Not Found"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func readBody(r *http.Request) M {
	b, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	var m M
	if json.Unmarshal(b, &m) != nil || m == nil {
		return M{}
	}
	return m
}

// userLog writes one user's HTTP-side lines (pool, saved) to their log.
func userLog(u *users.User, level string) func(string) {
	return func(m string) { logs.WriteUser(u.Log(), m, level, "") }
}

// page

// staticFiles serves ui/ under /static/, files only: no directory listings.
func staticFiles() http.Handler {
	fsrv := http.StripPrefix("/static/", http.FileServer(http.Dir(uiDir)))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/") {
			writeJSON(w, 404, M{"detail": "Not Found"})
			return
		}
		fsrv.ServeHTTP(w, r)
	})
}

var assetRe = regexp.MustCompile(`(/static/[\w./-]+\.(?:css|js))"`)

// assetVersion is the mtime of the newest UI asset; it busts the browser
// cache whenever a file is edited.
func assetVersion() string {
	var newest time.Time
	_ = filepath.WalkDir(uiDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if strings.HasSuffix(p, ".css") || strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".html") {
			if info, err := d.Info(); err == nil && info.ModTime().After(newest) {
				newest = info.ModTime()
			}
		}
		return nil
	})
	return strconv.FormatInt(newest.Unix(), 10)
}

func index(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	// one-time adoption of the old single-user data (users/CLAIM_TOKEN)
	if tok := r.URL.Query().Get("claim"); tok != "" {
		if users.Claim(u, tok) {
			logs.WriteUser(u.Log(), "[users] old shared identities and recordings claimed by this browser", "sys", "")
		}
		http.Redirect(w, r, "/", http.StatusSeeOther)
		return
	}
	b, err := os.ReadFile(filepath.Join(uiDir, "index.html"))
	if err != nil {
		http.Error(w, "ui missing", 500)
		return
	}
	html := assetRe.ReplaceAllString(string(b), `$1?v=`+assetVersion()+`"`)
	nonce := newNonce()
	html = inlineScriptRe.ReplaceAllString(html, `<script nonce="`+nonce+`">`)
	w.Header().Set("Content-Security-Policy", csp(nonce, r.Host))
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, html)
}

// inlineScriptRe matches a bare <script> tag, which is the inline bootstrap
// script (every other script has a src).
var inlineScriptRe = regexp.MustCompile(`<script>`)

// newNonce returns a fresh random CSP nonce for one page load.
func newNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return base64.StdEncoding.EncodeToString(b)
}

// identities

// apiNew leases an aged identity from the pool rather than minting one: a
// brand-new account seconds before a call is the anomaly. Never one a live
// session already holds.
func apiNew(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	e, err := u.Pool.Lease(cookiesInUse(nil), userLog(u, "pool"))
	if err != nil {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	// the user asked for it: it becomes this browser's identity for 24 hours
	did, _ := e["deviceId"].(string)
	cookie, _ := e["cookie"].(string)
	c := users.CallIdentity{DeviceID: did, Cookie: cookie, Since: account.Now()}
	_ = u.SetIdentity(c)
	writeJSON(w, 200, M{"deviceId": c.DeviceID, "cookie": c.Cookie, "since": c.Since})
}

// apiRelayFresh mints a brand-new identity for a relay leg (user rule: relay
// legs never reuse pool identities).
func apiRelayFresh(w http.ResponseWriter, r *http.Request) {
	id, err := identityCall(account.Fresh)
	if err != nil {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	writeJSON(w, 200, M{"deviceId": id.DeviceID, "cookie": id.Cookie})
}

func apiPoolAdd(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	n := 1
	if v, ok := readBody(r)["n"].(float64); ok {
		n = int(v)
	}
	n = max(1, min(n, 20))
	made, err := u.Pool.Add(n, userLog(u, "pool"))
	if err != nil && len(made) == 0 {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	ids := []any{}
	for _, e := range made {
		ids = append(ids, e["deviceId"])
	}
	writeJSON(w, 200, M{"added": ids, "total": len(u.Pool.Load())})
}

func apiPoolRemove(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	id := r.PathValue("device_id")
	if !u.Pool.Remove(id, userLog(u, "pool")) {
		writeJSON(w, 404, M{"detail": "no such identity"})
		return
	}
	writeJSON(w, 200, M{"removed": id, "total": len(u.Pool.Load())})
}

// apiResolveNames backfills missing nicknames: the name is only disclosed
// over the socket, so each nameless entry gets one short connection.
func apiResolveNames(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	poolLog := userLog(u, "pool")
	resolved := M{}
	for _, e := range u.Pool.Missing() {
		did, _ := e["deviceId"].(string)
		cookie, _ := e["cookie"].(string)
		name := fetchUsername(cookie)
		if name != "" {
			u.Pool.SetUsername(name, did, cookie, poolLog)
			resolved[did] = name
		} else {
			poolLog(fmt.Sprintf("[pool] resolve %s: no name (dead cookie?)", did))
		}
	}
	writeJSON(w, 200, M{"resolved": resolved, "total": len(u.Pool.Load())})
}

func fetchUsername(cookie string) string {
	got := make(chan string, 1)
	c := &sio.Client{URL: protocol.SocketURL(cookie)}
	c.OnEvent = func(ev string, raw json.RawMessage) {
		if ev != "fetch-initial-data" {
			return
		}
		d := asMap(decode(raw))
		select {
		case got <- sget(asMap(d["userData"]), "username"):
		default:
		}
	}
	if err := c.Connect(context.Background(), 15*time.Second); err != nil {
		return ""
	}
	defer c.Close()
	select {
	case n := <-got:
		return n
	case <-time.After(5 * time.Second):
		return ""
	}
}

func apiSavedAdd(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	b := readBody(r)
	did, cookie := py(orEmpty(b["deviceId"])), py(orEmpty(b["cookie"]))
	if did == "" || cookie == "" {
		writeJSON(w, 400, M{"error": "deviceId and cookie required"})
		return
	}
	u.Saved.Add(did, cookie, sget(b, "username"))
	logs.WriteUser(u.Log(), "[saved] identity "+did+" stored", "sys", "")
	writeJSON(w, 200, M{"saved": did})
}

func apiSavedUse(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	did := py(orEmpty(readBody(r)["deviceId"]))
	e := u.Saved.Take(did)
	if e == nil {
		writeJSON(w, 404, M{"error": "not saved"})
		return
	}
	logs.WriteUser(u.Log(), "[saved] identity "+did+" adopted", "sys", "")
	writeJSON(w, 200, M{"deviceId": e["deviceId"], "cookie": e["cookie"], "username": e["username"]})
}

// logs

func apiLog(w http.ResponseWriter, r *http.Request) {
	n := 500
	if v, err := strconv.Atoi(r.URL.Query().Get("lines")); err == nil {
		n = v
	}
	n = max(1, min(n, 20000))
	lp := users.For(w, r).Log()
	data, _ := os.ReadFile(lp)
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(data) == 0 {
		lines = nil
	}
	total := len(lines)
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	if lines == nil {
		lines = []string{}
	}
	writeJSON(w, 200, M{"path": "voisa.log", "total_lines": total, "bytes": len(data), "lines": lines})
}

// websocket

func wsHandler(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r) // before Accept, so a new owner cookie rides the 101
	// Same-origin only: the default check rejects a cross-origin handshake
	// (the Origin host must equal the request Host), which stops a page on
	// another site from opening a socket as this browser. A non-browser
	// client sends no Origin and is allowed.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(4 << 20)
	s := newSession(conn, u, clientIP(r))
	logs.Bind(s.cid, u.Log())
	defer logs.Unbind(s.cid)
	sessMu.Lock()
	sessions[s] = true
	sessMu.Unlock()
	defer func() {
		sessMu.Lock()
		delete(sessions, s)
		sessMu.Unlock()
		s.close()
		conn.Close(websocket.StatusNormalClosure, "")
	}()
	s.log("ready", "sys")
	for {
		_, data, err := conn.Read(context.Background())
		if err != nil {
			var ce websocket.CloseError
			if !errors.As(err, &ce) && !errors.Is(err, io.EOF) {
				logs.Write("ws read: "+err.Error(), "warn", s.cid)
			}
			return
		}
		var msg M
		if json.Unmarshal(data, &msg) != nil || msg == nil {
			continue
		}
		dispatch(s, msg)
	}
}

// CloseAll ends every live session (used on shutdown so legs leave their
// matches cleanly).
func CloseAll() {
	sessMu.Lock()
	list := make([]*Session, 0, len(sessions))
	for s := range sessions {
		list = append(list, s)
	}
	sessMu.Unlock()
	for _, s := range list {
		s.close()
	}
}
