package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"voisa/internal/users"

	"voisa/internal/account"
	"voisa/internal/logs"
	"voisa/internal/protocol"
	"voisa/internal/sio"
)

// Browser -> server commands over /ws. Each tab's commands run one at a time,
// in order; a failure in one is logged and reported to that tab only.

type command func(s *Session, msg M) error

var commands map[string]command

func init() {
	commands = map[string]command{
		"connect":      cmdConnect,
		"emit":         cmdEmit,
		"search":       cmdSearch,
		"accept":       cmdAccept,
		"hangup":       func(s *Session, _ M) error { s.hangup(); return nil },
		"bufferdialog": cmdBufferDialog,
		"shuffle":      cmdShuffle,
		"call":         cmdCall,
		"record":       cmdRecord,
		"mitm":         cmdMitm,
		"webrtc":       func(s *Session, m M) error { s.browserWebRTC(m); return nil },
		"stopcall":     func(s *Session, _ M) error { s.stopCall(); return nil },
		"logline":      cmdLogline,
		"ping":         func(s *Session, _ M) error { s.send("pong", nil); return nil },
	}
}

// needsUpstream: commands that act on Voisa, so the tab's identity is
// created (or renewed after 24 hours) right before them.
var needsUpstream = map[string]bool{
	"emit": true, "search": true, "accept": true, "bufferdialog": true, "shuffle": true,
}

func dispatch(s *Session, msg M) {
	name := msg["cmd"]
	h := commands[sget(msg, "cmd")]
	if h == nil {
		s.log("unknown cmd: "+py(name), "sys")
		return
	}
	if needsUpstream[sget(msg, "cmd")] {
		inner := h
		h = func(s *Session, m M) error {
			if err := ensureUpstream(s); err != nil {
				return err
			}
			return inner(s, m)
		}
	}
	defer func() {
		if r := recover(); r != nil {
			logs.Write(fmt.Sprintf("cmd %q panicked: %v", sget(msg, "cmd"), r), "err", s.cid)
			s.log(fmt.Sprintf("%s failed: %v", sget(msg, "cmd"), r), "err")
		}
	}()
	if err := h(s, msg); err != nil {
		logs.Write(fmt.Sprintf("cmd %q failed: %v", sget(msg, "cmd"), err), "err", s.cid)
		s.log(fmt.Sprintf("%s failed: %v", sget(msg, "cmd"), err), "err")
	}
}

// identityCall retries Voisa's account API, which times out now and then.
func identityCall(fn func() (account.Identity, error)) (account.Identity, error) {
	var last error
	for i := 0; i < 3; i++ {
		id, err := fn()
		if err == nil {
			return id, nil
		}
		last = err
		if i < 2 {
			time.Sleep(time.Duration(1.5*float64(i+1)*1000) * time.Millisecond)
		}
	}
	return account.Identity{}, last
}

// cmdConnect is sent on every page load (lazy) and when the user picks an
// identity themselves (New identity, a saved one).
//
// Lazy: nothing is created or connected yet. The tab's remembered identity is
// noted, and ensureUpstream picks the identity at the first action that needs
// Voisa (Start, search, accept, ...). So opening the page never mints an
// account or shows the browser online.
func cmdConnect(s *Session, msg M) error {
	// bump generation first so the UI drops stale events from the old socket
	if g, ok := msg["gen"].(float64); ok {
		s.mu.Lock()
		s.gen = int64(g)
		s.mu.Unlock()
	}
	did, cookie := sget(msg, "deviceId"), sget(msg, "cookie")
	since, _ := msg["since"].(float64)
	if truthy(msg["lazy"]) {
		s.mu.Lock()
		s.want = tabIdentity{deviceID: did, cookie: cookie, since: since}
		s.mu.Unlock()
		return nil
	}
	// The user chose this identity: it becomes the browser's identity, and its
	// 24 hours start now.
	if cookie == "" && did != "" {
		acct, err := identityCall(func() (account.Identity, error) { return account.Register(did) })
		if err != nil {
			return err
		}
		cookie = acct.Cookie
	}
	if cookie == "" {
		return s.useIdentity(s.mint(true))
	}
	if cookiesInUse(s)[cookie] {
		s.log("that identity is in use by another session — this session gets its own", "warn")
		return s.useIdentity(s.mint(false))
	}
	c := users.CallIdentity{DeviceID: did, Cookie: cookie, Since: account.Now()}
	_ = s.user.SetIdentity(c)
	return s.useIdentity(c, nil)
}

// ensureUpstream gives the tab a live Voisa identity before an action that
// needs one. In order: the tab's own remembered identity, the browser's
// identity (kept 24 hours, so it survives closing the tab), else a new one.
// An identity past its 24 hours is replaced at the next action, never in the
// middle of a call.
func ensureUpstream(s *Session) error {
	s.mu.Lock()
	have := s.sio != nil // connected, or reconnecting on its own
	cookie, since, inMatch, want := s.cookie, s.since, s.matchID != nil, s.want
	s.mu.Unlock()
	owner := s.user.Identity()
	if have {
		if users.Fresh(since) || inMatch {
			return nil
		}
		s.log("this identity is 24 hours old — making a new one", "sys")
		// replace the browser's identity too when this was it (or it expired)
		return s.useIdentity(s.mint(cookie == owner.Cookie || !owner.Valid()))
	}
	inUse := cookiesInUse(s)
	switch {
	case want.cookie != "" && want.cookie == owner.Cookie && owner.Valid() && !inUse[owner.Cookie]:
		return s.useIdentity(owner, nil)
	case want.cookie != "" && want.cookie != owner.Cookie && users.Fresh(want.since) && !inUse[want.cookie]:
		// this tab's own identity (a second tab got its own; a reload keeps it)
		return s.useIdentity(users.CallIdentity{DeviceID: want.deviceID, Cookie: want.cookie, Since: want.since}, nil)
	case owner.Valid() && !inUse[owner.Cookie]:
		return s.useIdentity(owner, nil)
	case owner.Valid():
		// another open tab has the browser's identity: this tab gets its own
		// and the browser's stays as it is
		return s.useIdentity(s.mint(false))
	default:
		return s.useIdentity(s.mint(true))
	}
}

// mint creates a new Voisa account. asOwner makes it the browser's identity.
func (s *Session) mint(asOwner bool) (users.CallIdentity, error) {
	acct, err := identityCall(account.Fresh)
	if err != nil {
		return users.CallIdentity{}, err
	}
	c := users.CallIdentity{DeviceID: acct.DeviceID, Cookie: acct.Cookie, Since: account.Now()}
	if asOwner {
		_ = s.user.SetIdentity(c)
	}
	s.log("new identity created", "match")
	return c, nil
}

// useIdentity tells the tab its identity and connects with it, unless that
// identity is already live on this tab.
func (s *Session) useIdentity(c users.CallIdentity, err error) error {
	if err != nil {
		return err
	}
	s.mu.Lock()
	same := s.cookie == c.Cookie && s.sio != nil
	s.since = c.Since
	s.want = tabIdentity{deviceID: c.DeviceID, cookie: c.Cookie, since: c.Since}
	s.mu.Unlock()
	s.send("account", M{"deviceId": c.DeviceID, "cookie": c.Cookie, "since": c.Since})
	if same && s.connected() != nil {
		return nil
	}
	return s.connect(c.Cookie)
}

func cmdEmit(s *Session, msg M) error {
	p := msg["payload"]
	if !truthy(p) {
		p = M{}
	}
	s.emit(py(msg["event"]), p, false)
	return nil
}

func cmdSearch(s *Session, msg M) error {
	lang := sget(msg, "lang")
	if lang == "" {
		lang = "en"
	}
	s.search(lang)
	return nil
}

func cmdAccept(s *Session, msg M) error {
	mid := msg["matchId"]
	if !truthy(mid) {
		s.mu.Lock()
		mid = s.matchID
		s.mu.Unlock()
	}
	s.accept(mid)
	return nil
}

func cmdBufferDialog(s *Session, msg M) error {
	ev := sget(msg, "event")
	if ev == "" {
		ev = "match"
	}
	s.emit("buffer-dialog", M{"event": ev}, false)
	return nil
}

// cmdShuffle asks for a new server-assigned nickname over a short-lived
// socket of its own (premium accounts only).
func cmdShuffle(s *Session, _ M) error {
	s.mu.Lock()
	cookie := s.cookie
	s.mu.Unlock()
	c := &sio.Client{URL: protocol.SocketURL(cookie)}
	if err := c.Connect(context.Background(), 20*time.Second); err != nil {
		s.log("shuffle-username refused: "+err.Error(), "err")
		return nil
	}
	defer c.Close()
	ack, err := c.EmitAck("shuffle-username", M{}, 3*time.Second)
	if err != nil {
		s.log("shuffle-username: no reply", "err")
		return nil
	}
	var v any
	_ = json.Unmarshal(ack, &v)
	if m, ok := v.(M); ok && truthy(m["code"]) {
		s.log("shuffle-username refused: "+py(m["code"]), "err")
	} else if truthy(v) {
		s.log("new username: "+py(v), "match")
	} else {
		s.log("shuffle-username: no reply", "err")
	}
	return nil
}

// cmdCall was the server-side (aiortc) call engine. The browser is the peer
// now, and that engine went with the Python backend.
func cmdCall(s *Session, _ M) error {
	s.log("the server-side call engine was removed; use Start (the browser call)", "err")
	return nil
}

// cmdRecord only confirms there is a call: the browser records itself.
func cmdRecord(s *Session, msg M) error {
	want := true
	if v, ok := msg["on"]; ok {
		want = truthy(v)
	}
	s.mu.Lock()
	inCall := s.matchID != nil
	s.mu.Unlock()
	if want && !inCall {
		s.log("no active call to record", "err")
		s.send("recording", M{"on": false, "ok": false})
	} else {
		s.send("recording", M{"on": want, "ok": true})
	}
	return nil
}

func cmdMitm(s *Session, msg M) error {
	// accept "A"/"B" or a "leg-A"/"leg-B" element id
	leg := strings.TrimPrefix(strings.ToUpper(py(orEmpty(msg["leg"]))), "LEG-")
	act := sget(msg, "act")
	switch {
	case leg != "A" && leg != "B":
		s.log("mitm: bad leg", "err")
	case act == "start":
		lang := sget(msg, "lang")
		if lang == "" {
			lang = "en"
		}
		secs, _ := msg["seconds"].(float64)
		return legStart(s, leg, sget(msg, "cookie"), sget(msg, "deviceId"), lang, secs)
	case act == "stop":
		legStop(s, leg)
		s.send("mitm", M{"leg": leg, "what": "call", "phase": "idle", "matchId": nil})
	case act == "signal":
		legSignal(s, leg, msg)
	default:
		s.log(fmt.Sprintf("mitm: bad act %q", act), "err")
	}
	return nil
}

func orEmpty(v any) any {
	if v == nil {
		return ""
	}
	return v
}

// cmdLogline lets the UI persist its own lines to the same file.
func cmdLogline(s *Session, msg M) error {
	level := sget(msg, "level")
	if level == "" {
		level = "ui"
	}
	logs.Write(py(orEmpty(msg["text"])), level, s.cid)
	return nil
}
