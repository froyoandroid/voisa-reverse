// Package server is the web UI backend: the single-page UI, its REST API and
// the /ws channel each browser tab talks over.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

	"voisa/internal/logs"
	"voisa/internal/protocol"
	"voisa/internal/sio"
	"voisa/internal/store"
)

var (
	root     string
	uiDir    string
	mediaDir string
	pool     *store.Pool
	saved    *store.Saved
)

// New builds the HTTP handler for a project root (data files and ui/).
func New(projectRoot string) http.Handler {
	root = projectRoot
	uiDir = filepath.Join(root, "ui")
	mediaDir = filepath.Join(root, "media")
	logs.Init(filepath.Join(root, "voisa.log"))
	pool = store.NewPool(root)
	saved = store.NewSaved(root)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", index)
	mux.Handle("GET /static/", staticFiles())
	mux.HandleFunc("GET /ws", wsHandler)

	mux.HandleFunc("GET /api/state", func(w http.ResponseWriter, r *http.Request) {
		// Identity is per session: no shared account cookie is ever served.
		writeJSON(w, 200, M{"has_account": false, "per_session": true})
	})
	mux.HandleFunc("POST /api/new", apiNew)
	mux.HandleFunc("GET /api/pool", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"entries": pool.Status()})
	})
	mux.HandleFunc("POST /api/pool/add", apiPoolAdd)
	mux.HandleFunc("DELETE /api/pool/{device_id}", apiPoolRemove)
	mux.HandleFunc("POST /api/pool/clear", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"cleared": pool.Clear(poolLog)})
	})
	mux.HandleFunc("POST /api/pool/resolve_names", apiResolveNames)
	mux.HandleFunc("GET /api/saved", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"entries": saved.Status()})
	})
	mux.HandleFunc("POST /api/saved", apiSavedAdd)
	mux.HandleFunc("POST /api/saved/use", apiSavedUse)
	mux.HandleFunc("DELETE /api/saved/{device_id}", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, M{"removed": saved.Remove(r.PathValue("device_id"))})
	})
	mux.HandleFunc("POST /api/login", apiLogin)

	mux.HandleFunc("GET /api/log", apiLog)
	mux.HandleFunc("DELETE /api/log", func(w http.ResponseWriter, r *http.Request) {
		_ = os.Remove(logs.Path())
		writeJSON(w, 200, M{"cleared": true})
	})
	mux.HandleFunc("GET /api/log/download", func(w http.ResponseWriter, r *http.Request) {
		if _, err := os.Stat(logs.Path()); err != nil {
			writeJSON(w, 404, M{"detail": "no log yet"})
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="voisa.log"`)
		http.ServeFile(w, r, logs.Path())
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

func poolLog(m string) { logs.Write(m, "pool", "") }

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

// apiNew leases an aged identity from the pool rather than minting one: a
// brand-new account seconds before a call is the anomaly. Never one a live
// session already holds.
func apiNew(w http.ResponseWriter, r *http.Request) {
	e, err := pool.Lease(cookiesInUse(nil), poolLog)
	if err != nil {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	writeJSON(w, 200, M{"deviceId": e["deviceId"], "cookie": e["cookie"]})
}

func apiPoolAdd(w http.ResponseWriter, r *http.Request) {
	n := 1
	if v, ok := readBody(r)["n"].(float64); ok {
		n = int(v)
	}
	n = max(1, min(n, 20))
	made, err := pool.Add(n, poolLog)
	if err != nil && len(made) == 0 {
		writeJSON(w, 500, M{"detail": err.Error()})
		return
	}
	ids := []any{}
	for _, e := range made {
		ids = append(ids, e["deviceId"])
	}
	writeJSON(w, 200, M{"added": ids, "total": len(pool.Load())})
}

func apiPoolRemove(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("device_id")
	if !pool.Remove(id, poolLog) {
		writeJSON(w, 404, M{"detail": "no such identity"})
		return
	}
	writeJSON(w, 200, M{"removed": id, "total": len(pool.Load())})
}

// apiResolveNames backfills missing nicknames: the name is only disclosed
// over the socket, so each nameless entry gets one short connection.
func apiResolveNames(w http.ResponseWriter, r *http.Request) {
	resolved := M{}
	for _, e := range pool.Missing() {
		did, _ := e["deviceId"].(string)
		cookie, _ := e["cookie"].(string)
		name := fetchUsername(cookie)
		if name != "" {
			pool.SetUsername(name, did, cookie, poolLog)
			resolved[did] = name
		} else {
			poolLog(fmt.Sprintf("[pool] resolve %s: no name (dead cookie?)", did))
		}
	}
	writeJSON(w, 200, M{"resolved": resolved, "total": len(pool.Load())})
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
	b := readBody(r)
	did, cookie := py(orEmpty(b["deviceId"])), py(orEmpty(b["cookie"]))
	if did == "" || cookie == "" {
		writeJSON(w, 400, M{"error": "deviceId and cookie required"})
		return
	}
	saved.Add(did, cookie, sget(b, "username"))
	logs.Write("[saved] identity "+did+" stored", "sys", "")
	writeJSON(w, 200, M{"saved": did})
}

func apiSavedUse(w http.ResponseWriter, r *http.Request) {
	did := py(orEmpty(readBody(r)["deviceId"]))
	e := saved.Take(did)
	if e == nil {
		writeJSON(w, 404, M{"error": "not saved"})
		return
	}
	logs.Write("[saved] identity "+did+" adopted", "sys", "")
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
	data, _ := os.ReadFile(logs.Path())
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
	writeJSON(w, 200, M{"path": logs.Path(), "total_lines": total, "bytes": len(data), "lines": lines})
}

// recordings (files left by the removed server-side engine)

func recName(name string) bool {
	return filepath.Base(name) == name && strings.HasPrefix(name, "incoming-")
}

func apiRecordings(w http.ResponseWriter, r *http.Request) {
	ents, _ := os.ReadDir(mediaDir)
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
	p := filepath.Join(mediaDir, name)
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
	if err := os.Remove(filepath.Join(mediaDir, name)); err != nil {
		writeJSON(w, 404, M{"detail": "not found"})
		return
	}
	writeJSON(w, 200, M{"deleted": name})
}

func apiRecordingsClear(w http.ResponseWriter, r *http.Request) {
	n := 0
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
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	conn.SetReadLimit(4 << 20)
	s := newSession(conn)
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
