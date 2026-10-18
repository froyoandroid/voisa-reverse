// Package recs stores recordings on the server, in each owner's media
// directory, and deletes them 24 hours after they start.
//
// The browser still does the recording (MediaRecorder), but every 1 s chunk
// is uploaded as it is produced and appended here in order, so the server
// always holds a playable file up to the last second received. This replaced
// browser storage (OPFS), which lost or truncated files.
//
// Each recording is <name>.webm plus a <name>.json sidecar (Meta). On stop the
// file is remuxed with ffmpeg (-c copy) so players get a duration and can
// seek; MediaRecorder output has neither.
package recs

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// TTL is how long a recording lives, counted from its start.
const TTL = 24 * time.Hour

// idleEnd: a recording that got no chunk for this long while not stopped is
// treated as ended (tab closed or crashed mid-recording).
const idleEnd = 20 * time.Second

// MaxChunk caps one uploaded chunk (a 1 s Opus slice is a few KB).
const MaxChunk = 4 << 20

// Storage caps, so one browser cannot fill the server's disk. A 64 kbit/s
// Opus recording is about 29 MB an hour, so MaxFile is roughly 7 hours.
const (
	MaxFile  = 200 << 20 // one recording
	MaxOwner = 1 << 30   // all of one owner's recordings together
	MaxLive  = 6         // recordings one owner may have open at once
)

// ErrQuota is returned when a recording or its owner is out of space.
var ErrQuota = errors.New("recording storage limit reached")

// Meta is the sidecar of one recording. Times are Unix milliseconds.
type Meta struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`  // call | relay | legacy
	Track      string `json:"track"` // call: "call"; relay: A | B | mix
	Group      string `json:"group,omitempty"`
	Peer       string `json:"peer,omitempty"`
	Mime       string `json:"mime,omitempty"`
	Created    int64  `json:"created"`
	Updated    int64  `json:"updated"`
	Ended      int64  `json:"ended,omitempty"`
	DurationMs int64  `json:"durationMs"`
	Bytes      int64  `json:"bytes"`
	Seq        int    `json:"seq"`
	Remuxed    bool   `json:"remuxed,omitempty"`
}

// Item is one row of the list sent to the browser.
type Item struct {
	Meta
	Live    bool  `json:"live"`
	Expires int64 `json:"expires"`
}

var (
	mu       sync.Mutex
	nameRe   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,150}$`)
	ErrSeq   = errors.New("chunk out of order")
	ErrEnded = errors.New("recording already stopped")
)

// ValidName accepts a plain media file name: no path, no sidecar.
func ValidName(n string) bool {
	return nameRe.MatchString(n) && !strings.Contains(n, "..") &&
		filepath.Base(n) == n && !strings.HasSuffix(n, ".json") && !strings.HasPrefix(n, ".")
}

func now() int64 { return time.Now().UnixMilli() }

func sidecar(dir, name string) string { return filepath.Join(dir, name+".json") }

func readMeta(dir, name string) (*Meta, error) {
	b, err := os.ReadFile(sidecar(dir, name))
	if err != nil {
		return nil, err
	}
	m := &Meta{}
	if err := json.Unmarshal(b, m); err != nil {
		return nil, err
	}
	return m, nil
}

func writeMeta(dir string, m *Meta) error {
	b, _ := json.Marshal(m)
	tmp := sidecar(dir, m.Name) + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, sidecar(dir, m.Name))
}

func clean(s string, n int) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
		if b.Len() >= n {
			break
		}
	}
	return b.String()
}

// Start creates an empty recording and returns its sidecar.
func Start(dir, kind, track, group, peer, mime string) (*Meta, error) {
	kind = clean(kind, 10)
	if kind != "call" && kind != "relay" {
		return nil, fmt.Errorf("kind must be call or relay")
	}
	track = clean(track, 8)
	if track == "" {
		track = kind
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if live, used := usage(dir); live >= MaxLive || used >= MaxOwner {
		return nil, ErrQuota
	}
	rnd := make([]byte, 3)
	_, _ = rand.Read(rnd)
	stamp := time.Now().UTC().Format("20060102-150405")
	name := fmt.Sprintf("%s-%s-%s-%s.webm", kind, track, stamp, hex.EncodeToString(rnd))
	if kind == "call" {
		name = fmt.Sprintf("call-%s-%s.webm", stamp, hex.EncodeToString(rnd))
	}
	t := now()
	m := &Meta{Name: name, Kind: kind, Track: track, Group: clean(group, 40),
		Peer: truncate(peer, 80), Mime: truncate(mime, 60), Created: t, Updated: t}
	mu.Lock()
	defer mu.Unlock()
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	f.Close()
	return m, writeMeta(dir, m)
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}

// Append writes chunk seq to the end of the recording. A repeated seq (a
// retried upload that had already landed) is accepted and ignored; a gap is
// refused so the file can never get bytes out of order.
func Append(dir, name string, seq int, body io.Reader) (*Meta, error) {
	data, err := io.ReadAll(io.LimitReader(body, MaxChunk+1))
	if err != nil {
		return nil, err
	}
	if len(data) > MaxChunk {
		return nil, fmt.Errorf("chunk too large")
	}
	mu.Lock()
	defer mu.Unlock()
	m, err := readMeta(dir, name)
	if err != nil {
		return nil, err
	}
	if m.Ended != 0 {
		return m, ErrEnded
	}
	if seq < m.Seq {
		return m, nil
	}
	if seq > m.Seq {
		return m, ErrSeq
	}
	if m.Bytes+int64(len(data)) > MaxFile {
		return m, ErrQuota
	}
	if _, used := usage(dir); used+int64(len(data)) > MaxOwner {
		return m, ErrQuota
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	n, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil {
		return nil, werr
	}
	if cerr != nil {
		return nil, cerr
	}
	m.Seq++
	m.Bytes += int64(n)
	m.Updated = now()
	m.DurationMs = m.Updated - m.Created
	return m, writeMeta(dir, m)
}

// Stop marks the recording ended and remuxes it in the background.
func Stop(dir, name string, durationMs int64) (*Meta, error) {
	mu.Lock()
	m, err := readMeta(dir, name)
	if err != nil {
		mu.Unlock()
		return nil, err
	}
	if m.Ended == 0 {
		m.Ended = now()
		if durationMs > 0 && durationMs < int64(TTL/time.Millisecond) {
			m.DurationMs = durationMs
		} else {
			m.DurationMs = m.Updated - m.Created
		}
		err = writeMeta(dir, m)
	}
	mu.Unlock()
	if err == nil {
		go remux(dir, name)
	}
	return m, err
}

// usage counts the owner's open recordings and the bytes all files use.
// Caller holds mu (or does not need an exact answer).
func usage(dir string) (live int, used int64) {
	ents, _ := os.ReadDir(dir)
	t := now()
	for _, e := range ents {
		info, err := e.Info()
		if err != nil || e.IsDir() {
			continue
		}
		used += info.Size()
		n := e.Name()
		if strings.HasSuffix(n, ".json") || strings.HasPrefix(n, ".") {
			continue
		}
		if m, err := readMeta(dir, n); err == nil && m.Ended == 0 && t-m.Updated < int64(idleEnd/time.Millisecond) {
			live++
		}
	}
	return live, used
}

// demuxer picks the ffmpeg input format from the file's first bytes. The
// upload is untrusted, and letting ffmpeg probe the format would let a file
// that is really an HLS playlist or a concat list make ffmpeg open other
// files or URLs (and copy them into a recording the uploader can download).
// Only the two formats MediaRecorder writes are accepted.
func demuxer(p string) string {
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	head := make([]byte, 4)
	if _, err := io.ReadFull(f, head); err != nil {
		return ""
	}
	switch {
	case head[0] == 0x1A && head[1] == 0x45 && head[2] == 0xDF && head[3] == 0xA3: // EBML
		return "matroska"
	case string(head) == "OggS":
		return "ogg"
	}
	return ""
}

var remuxing sync.Map

// remux rewrites the container with a duration and cues (-c copy, no
// re-encode). The original is kept when ffmpeg is missing or fails.
func remux(dir, name string) {
	if _, busy := remuxing.LoadOrStore(dir+"/"+name, true); busy {
		return
	}
	defer remuxing.Delete(dir + "/" + name)
	ff, err := exec.LookPath("ffmpeg")
	if err != nil {
		return
	}
	src := filepath.Join(dir, name)
	format := demuxer(src)
	if format == "" {
		return // not a MediaRecorder file: keep it as uploaded, never probe it
	}
	tmp := filepath.Join(dir, "."+name+".remux.webm")
	outFmt := "webm"
	if format == "ogg" {
		outFmt = "ogg"
	}
	// the input format is forced and only plain local files may be opened
	cmd := exec.Command(ff, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
		"-protocol_whitelist", "file", "-f", format, "-i", src,
		"-map", "0:a", "-c", "copy", "-f", outFmt, tmp)
	if err := cmd.Run(); err != nil {
		os.Remove(tmp)
		return
	}
	st, err := os.Stat(tmp)
	if err != nil || st.Size() == 0 {
		os.Remove(tmp)
		return
	}
	mu.Lock()
	defer mu.Unlock()
	m, err := readMeta(dir, name)
	if err != nil {
		os.Remove(tmp)
		return
	}
	if os.Rename(tmp, src) != nil {
		os.Remove(tmp)
		return
	}
	m.Remuxed = true
	m.Bytes = st.Size()
	_ = writeMeta(dir, m)
}

// List returns the owner's recordings, newest first. Recordings left
// unfinished (no chunk for idleEnd) are closed here; expired ones are
// deleted. Legacy files from the old server engine (incoming-*) are listed
// with kind "legacy".
func List(dir string) []Item {
	ents, _ := os.ReadDir(dir)
	out := []Item{}
	t := now()
	for _, e := range ents {
		n := e.Name()
		if e.IsDir() || strings.HasSuffix(n, ".json") || strings.HasSuffix(n, ".tmp") || strings.HasPrefix(n, ".") {
			continue
		}
		m, err := readMeta(dir, n)
		if err != nil {
			info, ierr := e.Info()
			if ierr != nil || !strings.HasPrefix(n, "incoming-") {
				continue
			}
			mt := info.ModTime().UnixMilli()
			m = &Meta{Name: n, Kind: "legacy", Track: "legacy", Created: mt, Updated: mt, Ended: mt, Bytes: info.Size()}
		}
		// legacy files predate the 24 h rule and are never auto-deleted
		if m.Kind != "legacy" && t-m.Created > int64(TTL/time.Millisecond) {
			Remove(dir, n)
			continue
		}
		live := m.Ended == 0 && t-m.Updated < int64(idleEnd/time.Millisecond)
		if m.Ended == 0 && !live {
			if mm, err := Stop(dir, n, 0); err == nil {
				m = mm
			}
		}
		if live {
			m.DurationMs = t - m.Created
		}
		exp := m.Created + int64(TTL/time.Millisecond)
		if m.Kind == "legacy" {
			exp = 0
		}
		out = append(out, Item{Meta: *m, Live: live, Expires: exp})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Created > out[j].Created })
	return out
}

// Remove deletes one recording and its sidecar.
func Remove(dir, name string) bool {
	mu.Lock()
	defer mu.Unlock()
	err := os.Remove(filepath.Join(dir, name))
	os.Remove(sidecar(dir, name))
	return err == nil
}

// Clear deletes every recording of kind ("" = all) and returns the count.
func Clear(dir, kind string) int {
	n := 0
	for _, it := range List(dir) {
		if kind == "" || it.Kind == kind {
			if Remove(dir, it.Name) {
				n++
			}
		}
	}
	return n
}

// Janitor deletes expired recordings in every owner's media directory, now
// and then every interval. dirs returns the media directories to sweep.
func Janitor(dirs func() []string, every time.Duration) {
	sweep := func() {
		for _, d := range dirs() {
			List(d) // List deletes what expired and closes abandoned ones
		}
	}
	sweep()
	t := time.NewTicker(every)
	for range t.C {
		sweep()
	}
}
