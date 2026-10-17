// Package logs writes voisa.log: one line per event, tagged with the client
// session that produced it, trimmed to the last day.
package logs

import (
	"bufio"
	"bytes"
	"fmt"
	"os"
	"sync"
	"time"
)

const MaxAge = 24 * time.Hour

var (
	mu      sync.Mutex
	path    string
	trimmed time.Time
)

// Init sets the log file path.
func Init(p string) { path = p }

// Path is the log file path.
func Path() string { return path }

// Write appends one line. It never fails loudly: logging must not break a
// call. cid tags the session, so parallel tabs stay separable in the file.
func Write(msg, level, cid string) {
	tag := "(--)"
	if cid != "" {
		tag = "(" + cid + ")"
	}
	mu.Lock()
	defer mu.Unlock()
	trim()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	fmt.Fprintf(f, "%s %s [%s] %s\n", time.Now().Format("2006-01-02 15:04:05"), tag, level, msg)
	f.Close()
}

// trim drops lines older than MaxAge, at most once a minute. The file is
// rewritten (atomically) only when something is actually dropped. Caller
// holds mu.
func trim() {
	now := time.Now()
	if now.Sub(trimmed) < time.Minute {
		return
	}
	trimmed = now
	data, err := os.ReadFile(path)
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
	tmp := path + ".trim"
	if os.WriteFile(tmp, keep.Bytes(), 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}
