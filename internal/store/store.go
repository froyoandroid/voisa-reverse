// Package store keeps the identity pool and the saved-identity shelf as JSON
// files next to the binary, in the same format the Python server wrote, so
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

// Pool: aged identities for relay legs, leased least-recently-used.

type Pool struct{ f file }

func NewPool(root string) *Pool { return &Pool{f: file{path: filepath.Join(root, "voisa_pool.json")}} }

func (p *Pool) Load() []Entry {
	p.f.mu.Lock()
	defer p.f.mu.Unlock()
	return p.f.load()
}

// Lease takes the least-recently-used identity whose cookie is not in
// exclude (identities a live session holds), minting one when none is free.
// The read-pick-write runs under one lock so two legs never get one account.
func (p *Pool) Lease(exclude map[string]bool, log func(string)) (Entry, error) {
	p.f.mu.Lock()
	defer p.f.mu.Unlock()
	entries := p.f.load()
	now := account.Now()
	var pick Entry
	for _, e := range entries {
		c := str(e, "cookie")
		if c == "" || exclude[c] {
			continue
		}
		if pick == nil || num(e, "last_used") < num(pick, "last_used") ||
			(num(e, "last_used") == num(pick, "last_used") && num(e, "created") < num(pick, "created")) {
			pick = e
		}
	}
	if pick != nil {
		pick["uses"] = num(pick, "uses") + 1
		pick["last_used"] = now
		if err := p.f.save(entries); err != nil {
			return nil, err
		}
		created := now
		if _, ok := pick["created"]; ok {
			created = num(pick, "created")
		}
		log(fmt.Sprintf("[pool] lease %s (age %.0fm, use #%.0f, %d other(s) idle)",
			str(pick, "deviceId"), (now-created)/60, num(pick, "uses"), len(entries)-1))
		return pick, nil
	}
	did := account.NewDeviceID()
	cookie, err := account.Create(did)
	if err != nil {
		return nil, err
	}
	e := Entry{"deviceId": did, "cookie": cookie, "created": now, "uses": 1, "last_used": now}
	entries = append(entries, e)
	if err := p.f.save(entries); err != nil {
		return nil, err
	}
	log(fmt.Sprintf("[pool] empty -> created %s", did))
	return e, nil
}

// Add pre-creates n identities so the pool has a stock that can age.
func (p *Pool) Add(n int, log func(string)) ([]Entry, error) {
	var made []Entry
	for i := 0; i < n; i++ {
		did := account.NewDeviceID()
		c, err := account.Create(did)
		if err != nil {
			if len(made) == 0 {
				return nil, err
			}
			break
		}
		made = append(made, Entry{"deviceId": did, "cookie": c, "created": account.Now(),
			"uses": 0, "last_used": nil})
	}
	p.f.mu.Lock()
	entries := append(p.f.load(), made...)
	err := p.f.save(entries)
	p.f.mu.Unlock()
	for _, e := range made {
		log("[pool] + " + str(e, "deviceId"))
	}
	return made, err
}

// Remove forgets one identity locally; the account on Voisa stays intact.
func (p *Pool) Remove(deviceID string, log func(string)) bool {
	p.f.mu.Lock()
	defer p.f.mu.Unlock()
	entries := p.f.load()
	keep := entries[:0:0]
	for _, e := range entries {
		if str(e, "deviceId") != deviceID {
			keep = append(keep, e)
		}
	}
	if len(keep) == len(entries) {
		return false
	}
	_ = p.f.save(keep)
	log(fmt.Sprintf("[pool] removed %s (%d left)", deviceID, len(keep)))
	return true
}

// SetUsername records the server-assigned nickname, matched by deviceId
// first, then cookie.
func (p *Pool) SetUsername(username, deviceID, cookie string, log func(string)) bool {
	if username == "" {
		return false
	}
	p.f.mu.Lock()
	defer p.f.mu.Unlock()
	entries := p.f.load()
	for _, e := range entries {
		if (deviceID != "" && str(e, "deviceId") == deviceID) || (cookie != "" && str(e, "cookie") == cookie) {
			if str(e, "username") == username {
				return true
			}
			e["username"] = username
			_ = p.f.save(entries)
			log(fmt.Sprintf("[pool] name %s -> %q", str(e, "deviceId"), username))
			return true
		}
	}
	return false
}

func (p *Pool) Clear(log func(string)) int {
	p.f.mu.Lock()
	defer p.f.mu.Unlock()
	n := len(p.f.load())
	_ = p.f.save(nil)
	log(fmt.Sprintf("[pool] cleared %d identity(ies)", n))
	return n
}

// Status lists the pool for the browser. Cookies never leave the server.
func (p *Pool) Status() []map[string]any {
	now := account.Now()
	out := []map[string]any{}
	for _, e := range p.Load() {
		created := now
		if _, ok := e["created"]; ok {
			created = num(e, "created")
		}
		out = append(out, map[string]any{
			"deviceId": e["deviceId"], "username": e["username"], "created": e["created"],
			"uses": num(e, "uses"), "last_used": e["last_used"],
			"age_min": float64(int((now-created)/60*10+0.5)) / 10,
		})
	}
	return out
}

// Missing returns the entries that still have no nickname.
func (p *Pool) Missing() []Entry {
	var out []Entry
	for _, e := range p.Load() {
		if str(e, "cookie") != "" && str(e, "username") == "" {
			out = append(out, e)
		}
	}
	return out
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
