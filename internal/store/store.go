// Package store keeps the saved-identity shelf as a JSON file in the
// owner's directory, in the same format the Python server wrote, so
// existing files load unchanged. Entries are kept as generic maps so fields
// this code does not know about survive a rewrite.
package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"voisa/internal/account"
)

type Entry = map[string]any

type file struct {
	path string
	mu   sync.Mutex
}

func (f *file) load() []Entry {
	b, err := os.ReadFile(f.path)
	if err != nil {
		return []Entry{}
	}
	var out []Entry
	if json.Unmarshal(b, &out) != nil || out == nil {
		return []Entry{}
	}
	return out
}

// save writes atomically: a crash mid-write cannot truncate the file.
func (f *file) save(entries []Entry) error {
	if entries == nil {
		entries = []Entry{}
	}
	b, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(f.path), 0o700); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", f.path, time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, f.path)
}

func str(e Entry, k string) string {
	s, _ := e[k].(string)
	return s
}

func num(e Entry, k string) float64 {
	switch v := e[k].(type) {
	case float64:
		return v
	case int:
		return float64(v)
	}
	return 0
}

// Saved: the identities a user kept so they can switch back to one.

type Saved struct{ f file }

func NewSaved(root string) *Saved {
	return &Saved{f: file{path: filepath.Join(root, "voisa_saved.json")}}
}

func (s *Saved) Add(deviceID, cookie, username string) Entry {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	entries := s.f.load()
	for _, e := range entries {
		if str(e, "deviceId") == deviceID {
			e["cookie"] = cookie
			if username != "" {
				e["username"] = username
			}
			_ = s.f.save(entries)
			return e
		}
	}
	var u any
	if username != "" {
		u = username
	}
	e := Entry{"deviceId": deviceID, "cookie": cookie, "username": u, "created": account.Now(), "uses": 0}
	entries = append(entries, e)
	_ = s.f.save(entries)
	return e
}

func (s *Saved) Remove(deviceID string) bool {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	entries := s.f.load()
	keep := entries[:0:0]
	for _, e := range entries {
		if str(e, "deviceId") != deviceID {
			keep = append(keep, e)
		}
	}
	if len(keep) == len(entries) {
		return false
	}
	_ = s.f.save(keep)
	return true
}

// Take returns a saved identity (with its cookie) and counts the use.
func (s *Saved) Take(deviceID string) Entry {
	s.f.mu.Lock()
	defer s.f.mu.Unlock()
	entries := s.f.load()
	for _, e := range entries {
		if str(e, "deviceId") == deviceID && str(e, "cookie") != "" {
			e["uses"] = num(e, "uses") + 1
			_ = s.f.save(entries)
			cp := Entry{}
			for k, v := range e {
				cp[k] = v
			}
			return cp
		}
	}
	return nil
}

func (s *Saved) Status() []map[string]any {
	s.f.mu.Lock()
	entries := s.f.load()
	s.f.mu.Unlock()
	out := []map[string]any{}
	for _, e := range entries {
		out = append(out, map[string]any{"deviceId": e["deviceId"], "username": e["username"],
			"created": e["created"], "uses": num(e, "uses")})
	}
	return out
}
