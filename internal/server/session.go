package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"voisa/internal/logs"
	"voisa/internal/protocol"
	"voisa/internal/sio"
)

// Every live browser session. Identity is per session, so this set is how a
// new session learns which identities are already taken.
var (
	sessMu   sync.Mutex
	sessions = map[*Session]bool{}
)

// cookiesInUse is every Voisa identity a live session holds (its own and its
// relay legs'), except those of exclude.
func cookiesInUse(exclude *Session) map[string]bool {
	sessMu.Lock()
	list := make([]*Session, 0, len(sessions))
	for s := range sessions {
		if s != exclude {
			list = append(list, s)
		}
	}
	sessMu.Unlock()
	used := map[string]bool{}
	for _, s := range list {
		s.mu.Lock()
		if s.cookie != "" {
			used[s.cookie] = true
		}
		for _, l := range s.legs {
			if l.cookie != "" {
				used[l.cookie] = true
			}
		}
		s.mu.Unlock()
	}
	return used
}

// Session is one browser tab and its one upstream Voisa socket.
//
// The browser is the WebRTC peer, so this process is only a signalling relay:
// one socket per tab carries matchmaking events and SDP/ICE between the
// browser and Voisa. There is deliberately no second socket per call: two
// sockets on one identity raced each other for start-dialog.
type Session struct {
	ws  *websocket.Conn
	cid string

	mu         sync.Mutex
	sio        *sio.Client
	cookie     string
	matchID    any // nil when not in a match
	accepted   any // matchId already accepted
	gen        int64
	iceCounts  map[string]int
	iceTotal   int
	iceLast    time.Time
	iceServers any
	legs       map[string]*Leg
	detached   bool

	wmu sync.Mutex
}

const connectAttempts = 4

func newSession(ws *websocket.Conn) *Session {
	return &Session{ws: ws, cid: shortID(), legs: map[string]*Leg{}, iceCounts: map[string]int{}}
}

// send writes one message to the browser: {"kind", "t", "gen", ...kw}.
func (s *Session) send(kind string, kw M) {
	s.mu.Lock()
	if s.detached {
		s.mu.Unlock()
		return
	}
	gen := s.gen
	s.mu.Unlock()
	msg := M{"kind": kind, "t": float64(time.Now().UnixNano()) / 1e9, "gen": gen}
	for k, v := range kw {
		msg[k] = v
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return
	}
	s.wmu.Lock()
	defer s.wmu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = s.ws.Write(ctx, websocket.MessageText, b)
}

func (s *Session) log(msg, level string) {
	logs.Write(msg, level, s.cid)
	s.send("log", M{"text": msg, "level": level})
}

// upstream socket

func (s *Session) makeClient(cookie string) *sio.Client {
	c := &sio.Client{URL: protocol.SocketURL(cookie), Reconnect: true,
		ReconnectMin: time.Second, ReconnectMax: 8 * time.Second}
	c.OnConnect = func(sid string) { s.send("status", M{"state": "connected", "sid": sid}) }
	c.OnDisconnect = func(reason string) {
		// the peer connection cannot survive a lost signalling channel
		s.dropMatch(true)
		s.send("status", M{"state": "disconnected", "reason": reason})
	}
	known := map[string]bool{}
	for _, e := range protocol.ServerEvents {
		known[e] = true
	}
	c.OnEvent = func(ev string, raw json.RawMessage) {
		if !known[ev] {
			return
		}
		defer func() {
			if r := recover(); r != nil {
				logs.Write(fmt.Sprintf("[%s] handler: %v", ev, r), "err", s.cid)
			}
		}()
		s.onEvent(ev, decode(raw))
	}
	return c
}

func (s *Session) connect(cookie string) error {
	s.disconnect()
	s.mu.Lock()
	s.cookie = cookie
	s.mu.Unlock()
	s.send("status", M{"state": "connecting"})
	var last error
	for attempt := 1; attempt <= connectAttempts; attempt++ {
		c := s.makeClient(cookie)
		err := c.Connect(context.Background(), 15*time.Second)
		if err == nil {
			s.mu.Lock()
			superseded := s.cookie != cookie || s.detached
			if !superseded {
				s.sio = c
			}
			s.mu.Unlock()
			if superseded {
				c.Close()
				return nil
			}
			s.log("connected", "sys")
			return nil
		}
		last = err
		s.mu.Lock()
		superseded := s.cookie != cookie || s.detached
		s.mu.Unlock()
		if superseded {
			return nil // superseded while we were retrying
		}
		s.log(fmt.Sprintf("connect attempt %d failed: %v", attempt, err), "warn")
		time.Sleep(time.Duration(min(1.5*float64(attempt), 5) * float64(time.Second)))
	}
	s.send("status", M{"state": "offline"})
	return fmt.Errorf("Voisa unreachable after %d attempts: %v", connectAttempts, last)
}

func (s *Session) disconnect() {
	s.dropMatch(false)
	s.mu.Lock()
	c := s.sio
	s.sio = nil
	s.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

func (s *Session) connected() *sio.Client {
	s.mu.Lock()
	c := s.sio
	s.mu.Unlock()
	if c == nil || !c.Connected() {
		return nil
	}
	return c
}

func (s *Session) emit(event string, payload any, quiet bool) bool {
	c := s.connected()
	if c == nil {
		s.log(event+": not connected", "err")
		return false
	}
	if payload == nil {
		payload = M{}
	}
	_ = c.Emit(event, payload)
	if !quiet {
		s.send("sent", M{"event": event, "payload": payload})
	}
	return true
}

// upstream events

func (s *Session) onEvent(ev string, payload any) {
	d := asMap(payload)
	switch ev {
	case "fetch-initial-data":
		s.mu.Lock()
		s.iceServers = d["iceServers"]
		if s.iceServers == nil {
			s.iceServers = []any{}
		}
		ice := s.iceServers
		s.mu.Unlock()
		user := d["userData"]
		if user == nil {
			user = M{}
		}
		langs := d["searchLanguages"]
		if langs == nil {
			langs = M{}
		}
		s.send("event", M{"event": ev, "payload": payload})
		s.send("session", M{"user": user, "searchLanguages": langs,
			"banStatus": d["banStatus"], "iceServers": ice})

	case "start-dialog":
		mid := d["matchId"]
		s.mu.Lock()
		s.matchID = mid
		s.iceCounts, s.iceTotal, s.iceLast = map[string]int{}, 0, time.Time{}
		s.mu.Unlock()
		s.send("event", M{"event": ev, "payload": payload})
		s.accept(mid)
		s.send("call", M{"phase": "matched", "matchId": mid, "peer": d["username"],
			"avatar": d["avatar"], "initiate": truthy(d["initiate"])})
		// the browser builds the SDP; tell it whether it offers
		s.send("call", M{"phase": "negotiate", "matchId": mid, "offer": truthy(d["initiate"])})

	case "close-dialog":
		// ignore a close for a match we are not in (a stale replay right
		// after start-search is common)
		s.mu.Lock()
		if !same(d["matchId"], s.matchID) {
			s.mu.Unlock()
			return
		}
		s.matchID, s.accepted = nil, nil
		s.mu.Unlock()
		s.send("event", M{"event": ev, "payload": payload})
		s.send("call", M{"phase": "closed", "matchId": nil})

	case "webrtc":
		s.mu.Lock()
		cur := s.matchID
		if d["matchId"] != nil && cur != nil && !same(d["matchId"], cur) {
			s.mu.Unlock()
			return // signalling for a match we already left
		}
		var summary string
		if ic, ok := d["iceCandidate"].(M); ok && ic != nil {
			s.countICE(sget(ic, "candidate"))
			if time.Since(s.iceLast) >= 5*time.Second {
				s.iceLast = time.Now()
				keys := make([]string, 0, len(s.iceCounts))
				for k := range s.iceCounts {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				parts := make([]string, len(keys))
				for i, k := range keys {
					parts[i] = fmt.Sprintf("%s=%d", k, s.iceCounts[k])
				}
				summary = fmt.Sprintf("[ice] peer candidates: %d (%s)", s.iceTotal, strings.Join(parts, " "))
			}
		}
		s.mu.Unlock()
		if summary != "" {
			s.send("log", M{"level": "sys", "text": summary})
		}
		s.send("webrtc", M{"payload": payload, "matchId": cur})

	default:
		s.send("event", M{"event": ev, "payload": payload})
	}
}

// countICE tallies peer candidates by type. Caller holds s.mu.
func (s *Session) countICE(cand string) {
	typ := "?"
	for _, t := range []string{"relay", "srflx", "prflx", "host"} {
		if strings.Contains(cand, "typ "+t) {
			typ = t
			break
		}
	}
	s.iceCounts[typ]++
	s.iceTotal++
}

// accept accepts a dialog exactly once (a second accept is noise the server
// can misread).
func (s *Session) accept(mid any) {
	s.mu.Lock()
	if mid == nil || (s.accepted != nil && same(s.accepted, mid)) {
		s.mu.Unlock()
		return
	}
	s.accepted = mid
	s.mu.Unlock()
	s.emit("start-dialog", M{"initiate": true, "matchId": mid}, false)
}

// call control

func (s *Session) search(lang string) {
	s.dropMatch(false)
	if !s.emit("set-search-language", M{"searchLanguage": lang}, false) {
		s.send("call", M{"phase": "idle", "matchId": nil})
		return
	}
	s.emit("start-search", M{}, false)
	s.send("call", M{"phase": "searching", "matchId": nil})
}

// browserWebRTC relays SDP/ICE from the browser to the peer, tagged with the
// live match.
func (s *Session) browserWebRTC(msg M) {
	s.mu.Lock()
	mid := s.matchID
	s.mu.Unlock()
	if mid == nil {
		return // call already over; late candidate
	}
	out := M{"matchId": mid}
	found := false
	for _, k := range []string{"offer", "answer", "iceCandidate"} {
		if v, ok := msg[k]; ok {
			out[k] = v
			found = true
			break
		}
	}
	if found {
		s.emit("webrtc", out, true)
	}
}

// dropMatch leaves the current match without touching the socket. lost means
// the socket is already gone, so nothing is sent upstream.
func (s *Session) dropMatch(lost bool) {
	s.mu.Lock()
	mid := s.matchID
	s.matchID, s.accepted = nil, nil
	c := s.sio
	s.mu.Unlock()
	if mid != nil && !lost && c != nil && c.Connected() {
		_ = c.Emit("close-dialog", M{"matchId": mid})
	}
}

func (s *Session) hangup() {
	s.dropMatch(false)
	s.send("call", M{"phase": "idle", "matchId": nil})
}

func (s *Session) stopCall() {
	s.dropMatch(false)
	if c := s.connected(); c != nil {
		_ = c.Emit("stop-search", M{})
	}
	s.send("call", M{"phase": "idle", "matchId": nil})
}

// close runs when the tab is gone. Its RTCPeerConnections died with it, so
// nothing upstream is worth keeping: leave the match, close every socket.
func (s *Session) close() {
	s.mu.Lock()
	s.detached = true
	s.mu.Unlock()
	legsStopAll(s)
	s.disconnect()
}
