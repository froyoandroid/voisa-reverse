// Package users gives every browser its own private space on the server,
// with no login: an anonymous, random owner id in an HttpOnly cookie.
//
// Each owner gets their own directory, users/<id>/, holding their identity
// pool, saved identities, activity log and legacy recordings. Nothing in
// one owner's directory is ever served to another. Two people on the same
// network, or one person in two different browsers, are different owners.
//
// The data the single-user server kept in the project root (voisa_pool.json,
// voisa_saved.json, media/incoming-*) belongs to nobody until someone claims
// it, once, with the token written to users/CLAIM_TOKEN.
package users

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"voisa/internal/store"
)

// CookieName is the owner cookie. It is unrelated to the Voisa account
// cookie, which stays in each tab's sessionStorage.
const CookieName = "voisa_uid"

const cookieMaxAge = 400 * 24 * time.Hour // the longest browsers keep a cookie

var idRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// User is one owner's private space.
type User struct {
	ID    string
	Dir   string
	Pool  *store.Pool
	Saved *store.Saved
}

// Log is the owner's own activity log.
func (u *User) Log() string { return filepath.Join(u.Dir, "voisa.log") }

// Media holds the owner's recordings (internal/recs).
func (u *User) Media() string { return filepath.Join(u.Dir, "media") }

// MediaDirs lists every owner's media directory, for the recordings janitor.
func MediaDirs() []string {
	ents, _ := os.ReadDir(base)
	var out []string
	for _, e := range ents {
		if e.IsDir() && idRe.MatchString(e.Name()) {
			if d := filepath.Join(base, e.Name(), "media"); dirExists(d) {
				out = append(out, d)
			}
		}
	}
	return out
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

var (
	mu    sync.Mutex
	root  string
	base  string
	cache = map[string]*User{}
)

// Init sets the project root. users/ is created beneath it, and a claim
// token is written when unclaimed single-user data is present.
func Init(projectRoot string) error {
	root = projectRoot
	base = filepath.Join(root, "users")
	if err := os.MkdirAll(base, 0o700); err != nil {
		return err
	}
	if hasLegacy() {
		if _, err := os.Stat(tokenPath()); errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(tokenPath(), []byte(newID()+"\n"), 0o600); err != nil {
				return err
			}
		}
	}
	return nil
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// For returns the owner of a request, issuing a new owner cookie when the
// request has none (or a malformed one). Call it before writing the
// response body.
func For(w http.ResponseWriter, r *http.Request) *User {
	if c, err := r.Cookie(CookieName); err == nil && idRe.MatchString(c.Value) {
		if u := get(c.Value); u != nil {
			return u
		}
	}
	id := newID()
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    id,
		Path:     "/",
		MaxAge:   int(cookieMaxAge.Seconds()),
		HttpOnly: true,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		SameSite: http.SameSiteLaxMode,
	})
	return get(id)
}

func get(id string) *User {
	mu.Lock()
	defer mu.Unlock()
	if u := cache[id]; u != nil {
		return u
	}
	// The directory is created on first write (store, log, claim), so a
	// visitor who never saves anything leaves nothing behind.
	dir := filepath.Join(base, id)
	u := &User{ID: id, Dir: dir, Pool: store.NewPool(dir), Saved: store.NewSaved(dir)}
	cache[id] = u
	return u
}

// legacy single-user data

var legacyFiles = []string{"voisa_pool.json", "voisa_saved.json"}

func tokenPath() string { return filepath.Join(base, "CLAIM_TOKEN") }

func legacyMedia() []string {
	ents, _ := os.ReadDir(filepath.Join(root, "media"))
	var out []string
	for _, e := range ents {
		n := e.Name()
		if strings.HasPrefix(n, "incoming-") && (strings.HasSuffix(n, ".wav") || strings.HasSuffix(n, ".ivf")) {
			out = append(out, n)
		}
	}
	return out
}

func hasLegacy() bool {
	for _, f := range legacyFiles {
		if _, err := os.Stat(filepath.Join(root, f)); err == nil {
			return true
		}
	}
	return len(legacyMedia()) > 0
}

// Claim moves the unclaimed single-user data into u's space when token
// matches the one in users/CLAIM_TOKEN. It works once: the token is
// deleted afterwards.
func Claim(u *User, token string) bool {
	mu.Lock()
	defer mu.Unlock()
	want, err := os.ReadFile(tokenPath())
	w := strings.TrimSpace(string(want))
	if err != nil || w == "" || subtle.ConstantTimeCompare([]byte(w), []byte(token)) != 1 {
		return false
	}
	if err := os.MkdirAll(u.Media(), 0o700); err != nil {
		return false
	}
	for _, f := range legacyFiles {
		src := filepath.Join(root, f)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		if err := merge(src, filepath.Join(u.Dir, f)); err == nil {
			_ = os.Remove(src)
		}
	}
	for _, n := range legacyMedia() {
		_ = os.Rename(filepath.Join(root, "media", n), filepath.Join(u.Media(), n))
	}
	_ = os.Remove(tokenPath())
	return true
}

// merge adds src's entries to dst (both JSON arrays of identity objects),
// skipping any deviceId dst already has, and writes dst atomically.
func merge(src, dst string) error {
	read := func(p string) ([]map[string]any, error) {
		b, err := os.ReadFile(p)
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		var out []map[string]any
		if err := json.Unmarshal(b, &out); err != nil {
			return nil, err
		}
		return out, nil
	}
	have, err := read(dst)
	if err != nil {
		return err
	}
	add, err := read(src)
	if err != nil {
		return err
	}
	seen := map[any]bool{}
	for _, e := range have {
		seen[e["deviceId"]] = true
	}
	for _, e := range add {
		if !seen[e["deviceId"]] {
			have = append(have, e)
			seen[e["deviceId"]] = true
		}
	}
	if have == nil {
		have = []map[string]any{}
	}
	b, err := json.MarshalIndent(have, "", "  ")
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", dst, time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// The browser's Call identity

// IdentityTTL is how long a browser keeps one Voisa identity for its calls
// (user rule: 24 hours, for every user). After that the next call makes a
// new one.
const IdentityTTL = 24 * time.Hour

// CallIdentity is the Voisa account this browser calls with. Since is when
// the browser took it (Unix seconds), which starts its 24 hours: a pool
// identity that is months old still gets its full day.
type CallIdentity struct {
	DeviceID string  `json:"deviceId"`
	Cookie   string  `json:"cookie"`
	Since    float64 `json:"since"`
}

// Valid reports whether the identity exists and is less than IdentityTTL old.
func (c CallIdentity) Valid() bool { return c.Cookie != "" && Fresh(c.Since) }

// Fresh reports whether an identity taken at since is still within its TTL.
func Fresh(since float64) bool {
	if since <= 0 {
		return false
	}
	return time.Since(time.Unix(0, int64(since*1e9))) < IdentityTTL
}

func (u *User) identityPath() string { return filepath.Join(u.Dir, "identity.json") }

var idMu sync.Mutex

// Identity returns the browser's Call identity (zero when it has none).
func (u *User) Identity() CallIdentity {
	idMu.Lock()
	defer idMu.Unlock()
	var c CallIdentity
	if b, err := os.ReadFile(u.identityPath()); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

// SetIdentity makes c the browser's Call identity, so it survives closing
// the tab, for the rest of its 24 hours.
func (u *User) SetIdentity(c CallIdentity) error {
	idMu.Lock()
	defer idMu.Unlock()
	if err := os.MkdirAll(u.Dir, 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := fmt.Sprintf("%s.%d.tmp", u.identityPath(), time.Now().UnixNano())
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, u.identityPath())
}
