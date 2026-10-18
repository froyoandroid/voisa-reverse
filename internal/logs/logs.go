// Package logs writes voisa.log: one line per event, tagged with the client
// session that produced it, trimmed to the last day.
//
// There are two kinds of file. The server log (Init) gets every line, for
// the operator. Each user also has their own log, which is what the UI's
// Logs view reads: lines from a session bound to that user (Bind) and
// lines written for them directly (WriteUser). One user never sees
// another's lines.
package logs

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const MaxAge = 24 * time.Hour

var (
	mu      sync.Mutex
	path    string
	trimmed = map[string]time.Time{}
	bound   = map[string]string{} // session cid -> that user's log file
)

// Init sets the server log path.
func Init(p string) { path = p }

// Path is the server log path.
func Path() string { return path }

// Bind routes a session's lines to its user's log as well.
func Bind(cid, userLog string) {
	mu.Lock()
	bound[cid] = userLog
	mu.Unlock()
}

// Unbind forgets a closed session.
func Unbind(cid string) {
	mu.Lock()
	delete(bound, cid)
	mu.Unlock()
}

// Write appends one line to the server log, and to the user's log when the
// session is bound. It never fails loudly: logging must not break a call.
// cid tags the session, so parallel tabs stay separable in the file.
func Write(msg, level, cid string) {
	mu.Lock()
	defer mu.Unlock()
	line := format(msg, level, cid)
	appendTo(path, line)
	if u := bound[cid]; u != "" {
		appendTo(u, line)
	}
}

// WriteUser appends a line that belongs to one user (an HTTP action of
// theirs) to their log and to the server log.
func WriteUser(userLog, msg, level, cid string) {
	mu.Lock()
	defer mu.Unlock()
	line := format(msg, level, cid)
	appendTo(path, line)
	if userLog != "" {
		appendTo(userLog, line)
	}
}

// maxMsg caps one logged message so a client cannot flood the shared file.
const maxMsg = 2000

// sanitize keeps a message to one line. Newlines and other control bytes let
// a client forge extra log lines (the file is one line per event, and the
// server log is shared with the operator), so they are replaced with spaces.
func sanitize(msg string) string {
	if len(msg) > maxMsg {
		msg = msg[:maxMsg] + "…"
	}
	var b strings.Builder
	b.Grow(len(msg))
	for _, r := range msg {
		if r == '\n' || r == '\r' || r == '\t' {
			b.WriteByte(' ')
			continue
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func format(msg, level, cid string) string {
	tag := "(--)"
	if cid != "" {
		tag = "(" + cid + ")"
	}
	return fmt.Sprintf("%s %s [%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), tag, sanitize(level), sanitize(msg))
}

// Caller holds mu.
func appendTo(p, line string) {
	if p == "" {
		return
	}
	trim(p)
	_ = os.MkdirAll(filepath.Dir(p), 0o700)
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_, _ = f.WriteString(line)
	f.Close()
}

// trim drops lines older than MaxAge from one file, at most once a minute
// per file. The file is rewritten (atomically) only when something is
// actually dropped. Caller holds mu.
func trim(p string) {
	now := time.Now()
	if now.Sub(trimmed[p]) < time.Minute {
		return
	}
	trimmed[p] = now
	data, err := os.ReadFile(p)
	if err != nil {
		return
	}
	cutoff := now.Add(-MaxAge)
	var keep bytes.Buffer
	dropped := false
	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	for sc.Scan() {
		ln := sc.Text()
		if len(ln) >= 19 {
			if ts, err := time.ParseInLocation("2006-01-02 15:04:05", ln[:19], time.Local); err == nil && ts.Before(cutoff) {
				dropped = true
				continue
			}
		}
		keep.WriteString(ln)
		keep.WriteByte('\n')
	}
	if !dropped {
		return
	}
	tmp := p + ".trim"
	if os.WriteFile(tmp, keep.Bytes(), 0o600) == nil {
		_ = os.Rename(tmp, p)
	}
}
