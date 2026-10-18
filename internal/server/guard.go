package server

import (
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Request guards: a same-origin check for every state-changing request, and
// a per-client rate limit for the routes that mint Voisa accounts.

// sameOrigin refuses a state-changing request (anything but GET, HEAD or
// OPTIONS) that a browser sent from another site. The owner cookie is
// SameSite=Lax, which already keeps it off cross-site POSTs, but a sibling
// subdomain counts as same-site, so the origin itself is checked too.
// Sec-Fetch-Site is used when the browser sends it, else Origin. A request
// with neither (curl, the probes) is not from a browser page and passes.
func sameOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if !originOK(r) {
			writeJSON(w, http.StatusForbidden, M{"detail": "cross-origin request refused"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func originOK(r *http.Request) bool {
	switch r.Header.Get("Sec-Fetch-Site") {
	case "same-origin", "none":
		return true
	case "":
		// older browser or not a browser: fall back to Origin
	default: // same-site, cross-site
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && strings.EqualFold(u.Host, r.Host)
}

// mintLimit is how many account-minting requests one client may make: a
// burst of mintBurst, then one every mintEvery. Each request can create up
// to 20 Voisa accounts (pool add), and an open endpoint that mints without
// limit gets the server's IP banned upstream.
const (
	mintBurst = 10
	mintEvery = 6 * time.Second
)

type bucket struct {
	tokens float64
	last   time.Time
}

var (
	limMu sync.Mutex
	lim   = map[string]*bucket{}
)

// limited wraps a handler with the per-client mint limit. The client is
// keyed by IP (X-Real-IP from nginx, which binds it to the TCP peer, else
// the socket address).
func limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !allow(clientIP(r)) {
			w.Header().Set("Retry-After", "6")
			writeJSON(w, http.StatusTooManyRequests, M{"detail": "too many requests, slow down"})
			return
		}
		h(w, r)
	}
}

func allow(key string) bool {
	limMu.Lock()
	defer limMu.Unlock()
	now := time.Now()
	b := lim[key]
	if b == nil {
		b = &bucket{tokens: mintBurst, last: now}
		lim[key] = b
	}
	b.tokens += now.Sub(b.last).Seconds() / mintEvery.Seconds()
	if b.tokens > mintBurst {
		b.tokens = mintBurst
	}
	b.last = now
	// drop full buckets now and then so the map stays small
	if len(lim) > 4096 {
		for k, v := range lim {
			if now.Sub(v.last) > mintEvery*mintBurst {
				delete(lim, k)
			}
		}
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// clientIP trusts X-Real-IP only from a loopback peer (nginx on this host).
// The server binds 127.0.0.1, so in practice every request comes through
// nginx, which overwrites the header with the real peer address.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xr := strings.TrimSpace(r.Header.Get("X-Real-IP")); xr != "" {
			return xr
		}
	}
	return host
}
