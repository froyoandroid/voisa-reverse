package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

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

func dispatch(s *Session, msg M) {
	name := msg["cmd"]
	h := commands[sget(msg, "cmd")]
	if h == nil {
		s.log("unknown cmd: "+py(name), "sys")
		return
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

func cmdConnect(s *Session, msg M) error {
	// bump generation first so the UI drops stale events from the old socket
	if g, ok := msg["gen"].(float64); ok {
		s.mu.Lock()
		s.gen = int64(g)
		s.mu.Unlock()
	}
	did, cookie := sget(msg, "deviceId"), sget(msg, "cookie")
	var acct account.Identity
	var err error
	switch {
	case cookie != "":
		// the tab remembered its own identity
		acct = account.Identity{DeviceID: did, Cookie: cookie}
	case did != "":
		acct, err = identityCall(func() (account.Identity, error) { return account.Register(did) })
	default:
		// no identity at all: mint a fresh one bound to this session
		acct, err = identityCall(account.Fresh)
	}
	if err != nil {
		return err
	}
	// Identity is per session: never share one another live session holds.
	if acct.Cookie != "" && cookiesInUse(s)[acct.Cookie] {
		s.log("that identity is in use by another session — this session gets its own", "warn")
		if acct, err = identityCall(account.Fresh); err != nil {
			return err
		}
	}
	accountMsg := M{"deviceId": acct.DeviceID, "cookie": acct.Cookie}
	if acct.Created != 0 {
		accountMsg["created"] = acct.Created
	}
	// Only reconnect when the identity actually changes: a page load also
	// sends connect, and tearing down unconditionally killed a live call.
	s.mu.Lock()
	sameID := s.cookie == acct.Cookie
	s.mu.Unlock()
	if sameID && s.connected() != nil {
		s.send("account", accountMsg)
		s.log("already connected (identity unchanged)", "sys")
		return nil
	}
	s.send("account", accountMsg)
	return s.connect(acct.Cookie)
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
