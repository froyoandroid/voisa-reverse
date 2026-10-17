// Package server is the web UI backend: the single-page UI, its REST API and
// the /ws channel each browser tab talks over.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/coder/websocket"

	"voisa/internal/account"
	"voisa/internal/logs"
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
	mux.HandleFunc("POST /api/new", apiNew)
	mux.HandleFunc("POST /api/relay/fresh", apiRelayFresh)
	mux.HandleFunc("GET /api/saved", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"entries": users.For(w, r).Saved.Status()})
	})
	mux.HandleFunc("POST /api/saved", apiSavedAdd)
	mux.HandleFunc("POST /api/saved/use", apiSavedUse)
	mux.HandleFunc("DELETE /api/saved/{device_id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"removed": users.For(w, r).Saved.Remove(r.PathValue("device_id"))})
	})
	mux.HandleFunc("POST /api/login", apiLogin)

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

	mux.HandleFunc("GET /api/recordings", apiRecordings)
	mux.HandleFunc("GET /api/recordings/{name}", apiRecordingFile)
	mux.HandleFunc("DELETE /api/recordings/{name}", apiRecordingDelete)
	mux.HandleFunc("DELETE /api/recordings", apiRecordingsClear)

	return withNotFound(mux)
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

// userLog writes one user's HTTP-side lines to their log.
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
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, html)
}

// identities

// apiNew is the "New identity" button: a brand-new Voisa account that
// becomes this browser's Call identity, with its 24 hours starting now.
func apiNew(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	id, err := identityCall(account.Fresh)
	if err != nil {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	c := users.CallIdentity{DeviceID: id.DeviceID, Cookie: id.Cookie, Since: account.Now()}
	_ = u.SetIdentity(c)
	logs.WriteUser(u.Log(), "[identity] new identity "+c.DeviceID, "sys", "")
	writeJSON(w, 200, M{"deviceId": c.DeviceID, "cookie": c.Cookie, "since": c.Since})
}

// apiRelayFresh mints a brand-new identity for a relay leg (user rule: relay
// legs always get brand-new identities).
func apiRelayFresh(w http.ResponseWriter, r *http.Request) {
	id, err := identityCall(account.Fresh)
	if err != nil {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	writeJSON(w, 200, M{"deviceId": id.DeviceID, "cookie": id.Cookie})
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

// apiLogin returns the cookie for a deviceId to the caller only; it never
// becomes anyone else's identity.
func apiLogin(w http.ResponseWriter, r *http.Request) {
	did := sget(readBody(r), "deviceId")
	if did == "" {
		writeJSON(w, 400, M{"detail": "deviceId required"})
		return
	}
	id, err := identityCall(func() (accountIdentity, error) { return accountRegister(did) })
	if err != nil {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	writeJSON(w, 200, M{"deviceId": did, "cookie": id.Cookie})
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

// recordings (files left by the removed server-side engine)

func recName(name string) bool {
	return filepath.Base(name) == name && strings.HasPrefix(name, "incoming-")
}

func apiRecordings(w http.ResponseWriter, r *http.Request) {
	ents, _ := os.ReadDir(users.For(w, r).Media())
	files := []M{}
	var total int64
	for _, e := range ents {
		n := e.Name()
		if !strings.HasPrefix(n, "incoming-") || !(strings.HasSuffix(n, ".wav") || strings.HasSuffix(n, ".ivf")) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		kind := "video"
		if strings.HasSuffix(n, ".wav") {
			kind = "audio"
		}
		files = append(files, M{"name": n, "bytes": info.Size(), "mtime": info.ModTime().Unix(), "kind": kind})
		total += info.Size()
	}
	sort.Slice(files, func(i, j int) bool { return files[i]["mtime"].(int64) > files[j]["mtime"].(int64) })
	writeJSON(w, 200, M{"files": files, "total_bytes": total})
}

func apiRecordingFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !recName(name) {
		writeJSON(w, 400, M{"detail": "bad name"})
		return
	}
	p := filepath.Join(users.For(w, r).Media(), name)
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		writeJSON(w, 404, M{"detail": "not found"})
		return
	}
	ct := "video/x-ivf"
	if strings.HasSuffix(name, ".wav") {
		ct = "audio/wav"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	http.ServeFile(w, r, p)
}

func apiRecordingDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !recName(name) {
		writeJSON(w, 400, M{"detail": "bad name"})
		return
	}
	if err := os.Remove(filepath.Join(users.For(w, r).Media(), name)); err != nil {
		writeJSON(w, 404, M{"detail": "not found"})
		return
	}
	writeJSON(w, 200, M{"deleted": name})
}

func apiRecordingsClear(w http.ResponseWriter, r *http.Request) {
	n := 0
	mediaDir := users.For(w, r).Media()
	ents, _ := os.ReadDir(mediaDir)
	for _, e := range ents {
		name := e.Name()
		if strings.HasPrefix(name, "incoming-") && (strings.HasSuffix(name, ".wav") || strings.HasSuffix(name, ".ivf")) {
			if os.Remove(filepath.Join(mediaDir, name)) == nil {
				n++
			}
		}
	}
	writeJSON(w, 200, M{"deleted": n})
}

// websocket

func wsHandler(w http.ResponseWriter, r *http.Request) {
	// Same-origin is not enforced, matching the old server; nginx fronts it.
	u := users.For(w, r) // before Accept, so a new owner cookie rides the 101
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(4 << 20)
	s := newSession(conn, u)
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
