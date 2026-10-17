package server

import (
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"voisa/internal/logs"
	"voisa/internal/recs"
	"voisa/internal/users"
)

// recordingRoutes serves the owner's recordings. The browser records and
// uploads each 1 s chunk while recording (start, chunk..., stop); the server
// keeps the file in users/<id>/media/ and deletes it 24 h after it started.
func recordingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/recordings", apiRecordings)
	mux.HandleFunc("GET /api/recordings/{name}", apiRecordingFile)
	mux.HandleFunc("DELETE /api/recordings/{name}", apiRecordingDelete)
	mux.HandleFunc("DELETE /api/recordings", apiRecordingsClear)
	mux.HandleFunc("POST /api/rec/start", apiRecStart)
	mux.HandleFunc("POST /api/rec/{name}/chunk", apiRecChunk)
	mux.HandleFunc("POST /api/rec/{name}/stop", apiRecStop)
	go recs.Janitor(users.MediaDirs, 5*time.Minute)
}

func apiRecordings(w http.ResponseWriter, r *http.Request) {
	kind := r.URL.Query().Get("kind")
	all := recs.List(users.For(w, r).Media())
	files := []recs.Item{}
	var bytes, ms int64
	for _, it := range all {
		if kind != "" && it.Kind != kind {
			continue
		}
		files = append(files, it)
		bytes += it.Bytes
		ms += it.DurationMs
	}
	writeJSON(w, 200, M{"files": files, "total_bytes": bytes, "total_ms": ms,
		"ttl_hours": int(recs.TTL / time.Hour), "now": time.Now().UnixMilli()})
}

func apiRecordingFile(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !recs.ValidName(name) {
		writeJSON(w, 400, M{"detail": "bad name"})
		return
	}
	p := filepath.Join(users.For(w, r).Media(), name)
	if st, err := os.Stat(p); err != nil || st.IsDir() {
		writeJSON(w, 404, M{"detail": "not found"})
		return
	}
	ct := "audio/webm"
	switch {
	case strings.HasSuffix(name, ".wav"):
		ct = "audio/wav"
	case strings.HasSuffix(name, ".ivf"):
		ct = "video/x-ivf"
	case strings.HasSuffix(name, ".ogg"):
		ct = "audio/ogg"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	disp := "inline"
	if r.URL.Query().Get("dl") != "" {
		disp = "attachment"
	}
	w.Header().Set("Content-Disposition", disp+`; filename="`+name+`"`)
	http.ServeFile(w, r, p)
}

func apiRecordingDelete(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !recs.ValidName(name) {
		writeJSON(w, 400, M{"detail": "bad name"})
		return
	}
	if !recs.Remove(users.For(w, r).Media(), name) {
		writeJSON(w, 404, M{"detail": "not found"})
		return
	}
	writeJSON(w, 200, M{"deleted": name})
}

func apiRecordingsClear(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	n := recs.Clear(u.Media(), r.URL.Query().Get("kind"))
	logs.WriteUser(u.Log(), "[rec] cleared "+strconv.Itoa(n)+" recording(s)", "sys", "")
	writeJSON(w, 200, M{"deleted": n})
}

func apiRecStart(w http.ResponseWriter, r *http.Request) {
	u := users.For(w, r)
	b := readBody(r)
	m, err := recs.Start(u.Media(), sget(b, "kind"), sget(b, "track"), sget(b, "group"), sget(b, "peer"), sget(b, "mime"))
	if err != nil {
		writeJSON(w, 400, M{"detail": err.Error()})
		return
	}
	logs.WriteUser(u.Log(), "[rec] started "+m.Name, "sys", "")
	writeJSON(w, 200, M{"name": m.Name, "created": m.Created, "ttl_hours": int(recs.TTL / time.Hour)})
}

func apiRecChunk(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	seq, err := strconv.Atoi(r.URL.Query().Get("seq"))
	if !recs.ValidName(name) || err != nil || seq < 0 {
		writeJSON(w, 400, M{"detail": "bad name or seq"})
		return
	}
	m, err := recs.Append(users.For(w, r).Media(), name, seq, r.Body)
	switch {
	case errors.Is(err, recs.ErrSeq):
		writeJSON(w, 409, M{"detail": err.Error(), "next": m.Seq})
	case errors.Is(err, recs.ErrEnded):
		writeJSON(w, 410, M{"detail": err.Error()})
	case err != nil:
		writeJSON(w, 404, M{"detail": err.Error()})
	default:
		writeJSON(w, 200, M{"next": m.Seq, "bytes": m.Bytes})
	}
}

func apiRecStop(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !recs.ValidName(name) {
		writeJSON(w, 400, M{"detail": "bad name"})
		return
	}
	u := users.For(w, r)
	var dur int64
	if v, ok := readBody(r)["durationMs"].(float64); ok {
		dur = int64(v)
	}
	m, err := recs.Stop(u.Media(), name, dur)
	if err != nil {
		writeJSON(w, 404, M{"detail": err.Error()})
		return
	}
	logs.WriteUser(u.Log(), "[rec] saved "+m.Name, "match", "")
	writeJSON(w, 200, M{"name": m.Name, "durationMs": m.DurationMs, "bytes": m.Bytes})
}
