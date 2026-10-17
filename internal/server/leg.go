package server

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"

	"voisa/internal/logs"
	"voisa/internal/protocol"
	"voisa/internal/sio"
)

// Leg is one relay (MITM) leg: its own identity and its own upstream socket.
// The browser owns the leg's RTCPeerConnection; the leg only carries its
// matchmaking and SDP/ICE. When a stranger leaves, the leg requeues instead
// of stopping, so the other leg keeps its feed.
type Leg struct {
	key      string
	sess     *Session
	cookie   string
	deviceID string
	lang     string
	seconds  float64

	mu       sync.Mutex
	sio      *sio.Client
	matchID  any
	username string
	ownNames map[string]bool
	stopped  bool
	closing  bool
	timer    *time.Timer
}

func (l *Leg) log(m string) {
	l.sess.send("mitm", M{"leg": l.key, "what": "log", "text": m})
}

func (l *Leg) state(kw M) {
	kw2 := M{"leg": l.key, "what": "call"}
	for k, v := range kw {
		kw2[k] = v
	}
	l.sess.send("mitm", kw2)
}

func (l *Leg) emit(event string, data any) {
	l.mu.Lock()
	c := l.sio
	l.mu.Unlock()
	if c != nil {
		_ = c.Emit(event, data)
	}
}

// start connects and searches.
func (l *Leg) start() error {
	if err := l.connectSocket(); err != nil {
		return err
	}
	// The app sends the language as its own event, then start-search with no
	// payload. Putting the language in start-search lands in the default pool.
	l.emit("set-search-language", M{"searchLanguage": l.lang})
	l.log("[client] -> set-search-language " + l.lang)
	time.Sleep(150 * time.Millisecond)
	l.emit("start-search", M{})
	l.log("[client] -> start-search {}")
	l.state(M{"phase": "searching", "matchId": nil})
	if l.seconds > 0 {
		l.mu.Lock()
		l.timer = time.AfterFunc(time.Duration(l.seconds*float64(time.Second)), func() {
			l.log(fmt.Sprintf("[client] call window (%gs) elapsed", l.seconds))
			l.stop()
		})
		l.mu.Unlock()
	}
	return nil
}

func (l *Leg) connectSocket() error {
	c := &sio.Client{URL: protocol.SocketURL(l.cookie), Reconnect: true,
		ReconnectMin: time.Second, ReconnectMax: 5 * time.Second}
	c.OnConnect = func(sid string) { l.log("[socket] connected sid=" + sid) }
	c.OnDisconnect = func(reason string) { l.log("[socket] disconnected: " + reason) }
	c.OnEvent = func(ev string, raw json.RawMessage) {
		defer func() {
			if r := recover(); r != nil {
				logs.Write(fmt.Sprintf("leg %s [%s] handler: %v", l.key, ev, r), "err", l.sess.cid)
			}
		}()
		d := asMap(decode(raw))
		switch ev {
		case "fetch-initial-data":
			l.onInitial(d)
		case "start-dialog":
			l.onStartDialog(d)
		case "close-dialog":
			l.onCloseDialog(d)
		case "webrtc":
			l.relayWebRTC(d)
		case "buffer-dialog":
			l.log("[buffer-dialog] " + string(raw))
		}
	}
	l.mu.Lock()
	l.sio = c
	l.mu.Unlock()
	// TLS handshakes to Voisa intermittently time out; retry with backoff
	// rather than leave the UI on "Searching" forever.
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if err := c.Connect(context.Background(), 20*time.Second); err == nil {
			last = nil
			break
		} else {
			last = err
			l.log(fmt.Sprintf("[socket] connect attempt %d failed: %v", attempt+1, err))
			time.Sleep(time.Duration(2*(attempt+1)) * time.Second)
		}
		if l.isStopped() {
			return fmt.Errorf("leg stopped")
		}
	}
	if last != nil {
		return last
	}
	time.Sleep(800 * time.Millisecond)
	return nil
}

func (l *Leg) isStopped() bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stopped
}

func (l *Leg) onInitial(d M) {
	ice, _ := d["iceServers"].([]any)
	u := asMap(d["userData"])
	name := sget(u, "username")
	l.mu.Lock()
	changed := name != "" && name != l.username
	if changed {
		l.username = name
	}
	l.mu.Unlock()
	if changed {
		shareNames(l.sess) // tell the session so our other legs know this name
	}
	l.log(fmt.Sprintf("[session] user=%s premium=%s ice=%d", py(u["username"]), py(u["premium"]), len(ice)))
}

func (l *Leg) onStartDialog(d M) {
	keys := make([]string, 0, len(d))
	for k := range d {
		keys = append(keys, k)
	}
	l.log("[start-dialog] keys=" + pyList(keys))
	peer := sget(d, "username")

	// Loopback guard: if the peer's name is one of our own legs, the two
	// relays found each other. Bridging them would feed each leg's audio into
	// its own outbound, a closed loop. Refuse and search again.
	l.mu.Lock()
	loop := peer != "" && l.ownNames[peer]
	if loop {
		l.matchID = nil
	}
	l.mu.Unlock()
	if loop {
		l.log(fmt.Sprintf("[loopback] refusing match with our own leg %q — refusing to bridge a relay to itself", peer))
		l.state(M{"phase": "loopback", "matchId": nil, "peer": peer})
		l.emit("close-dialog", M{"matchId": d["matchId"]})
		go l.requeue()
		return
	}

	offer := truthy(d["initiate"])
	l.mu.Lock()
	l.matchID = d["matchId"]
	mid := l.matchID
	l.mu.Unlock()
	who := "they offer"
	if offer {
		who = "we offer"
	}
	l.log(fmt.Sprintf("[start-dialog] peer=%s initiate=%s (%s)", py(d["username"]), py(offer), who))
	l.state(M{"phase": "matched", "matchId": mid, "peer": d["username"], "avatar": d["avatar"], "initiate": offer})
	// accept the dialog; required in both directions
	l.emit("start-dialog", M{"initiate": true, "matchId": mid})
	// the browser owns the peer connection and builds the SDP itself
	l.log("[rtc] browser peer owns negotiation (" + who + ")")
	l.state(M{"phase": "negotiate", "matchId": mid, "offer": offer})
}

func (l *Leg) onCloseDialog(d M) {
	closed := d["matchId"]
	l.mu.Lock()
	cur := l.matchID
	// only a close for the match we are actually in may affect us (a stale
	// replay arrives right after start-search)
	if !same(closed, cur) {
		l.mu.Unlock()
		l.log(fmt.Sprintf("[close-dialog] ignoring %s (we are in %s)", py(closed), py(cur)))
		return
	}
	l.matchID = nil
	stopped := l.stopped
	l.mu.Unlock()
	l.log(fmt.Sprintf("[close-dialog] peer left (%s)", py(closed)))
	if stopped {
		// stop() emits close-dialog itself and the server echoes it back
		l.log("[close-dialog] ignoring echo (leg was stopped)")
		return
	}
	// a relay leg survives the peer hanging up: back to searching
	l.state(M{"phase": "closed", "matchId": nil})
	go l.requeue()
}

// next drops the current match on purpose (the browser saw its WebRTC
// connection fail or never connect) and searches again, the same way as when
// the stranger leaves. Nothing happens when the leg holds no match.
func (l *Leg) next(reason string) {
	l.mu.Lock()
	mid := l.matchID
	l.matchID = nil
	l.mu.Unlock()
	if mid == nil || l.isStopped() {
		return
	}
	l.log(fmt.Sprintf("[next] leaving %s: %s", py(mid), reason))
	l.emit("close-dialog", M{"matchId": mid})
	l.state(M{"phase": "closed", "matchId": nil})
	go l.requeue()
}

func (l *Leg) requeue() {
	if l.isStopped() {
		l.log("[requeue] cancelled (leg was stopped)")
		return
	}
	l.mu.Lock()
	c := l.sio
	l.mu.Unlock()
	if c == nil {
		return
	}
	if err := c.Emit("start-search", M{}); err != nil {
		l.log("[requeue] failed: " + err.Error())
		return
	}
	l.log("[client] -> start-search (requeue after peer left)")
	l.state(M{"phase": "searching", "matchId": nil})
}

// relayWebRTC forwards a Voisa webrtc message to the browser verbatim.
func (l *Leg) relayWebRTC(d M) {
	if ic, ok := d["iceCandidate"].(M); ok {
		l.log("[ice] <- peer candidate " + truncate(py(ic["candidate"]), 60))
	} else if _, ok := d["offer"]; ok {
		l.log("[rtc] <- peer offer -> browser")
	} else if _, ok := d["answer"]; ok {
		l.log("[rtc] <- peer answer -> browser")
	}
	l.sess.send("mitm", M{"leg": l.key, "what": "signal", "payload": d})
}

// uiWebRTC forwards the browser's offer/answer/candidate upstream.
func (l *Leg) uiWebRTC(msg M) {
	l.mu.Lock()
	c, mid := l.sio, l.matchID
	l.mu.Unlock()
	if c == nil || mid == nil {
		return
	}
	out := M{"matchId": mid}
	switch {
	case msg["offer"] != nil:
		out["offer"] = msg["offer"]
		l.log("[rtc] browser offer -> peer")
	case msg["answer"] != nil:
		out["answer"] = msg["answer"]
		l.log("[rtc] browser answer -> peer")
	case msg["iceCandidate"] != nil:
		out["iceCandidate"] = msg["iceCandidate"]
		l.log("[ice] browser candidate -> peer")
	default:
		return
	}
	if err := c.Emit("webrtc", out); err != nil {
		l.log("[rtc] emit failed: " + err.Error())
	}
}

// stop ends the leg's call and searches, then closes its socket.
func (l *Leg) stop() {
	l.mu.Lock()
	if l.closing {
		l.mu.Unlock()
		return
	}
	l.stopped, l.closing = true, true
	if l.timer != nil {
		l.timer.Stop()
	}
	mid, c := l.matchID, l.sio
	l.matchID = nil
	l.mu.Unlock()
	if c != nil {
		if mid != nil {
			_ = c.Emit("close-dialog", M{"matchId": mid})
			l.log("[client] -> close-dialog")
		}
		if c.Emit("stop-search", M{}) == nil {
			l.log("[client] -> stop-search")
		}
	}
	l.mu.Lock()
	l.closing = false
	l.mu.Unlock()
	l.log("[call] stopped")
	l.state(M{"phase": "idle", "matchId": nil})
}

// close drops the leg's socket for good (after stop).
func (l *Leg) close() {
	l.mu.Lock()
	c := l.sio
	l.sio = nil
	l.mu.Unlock()
	if c != nil {
		c.Close()
	}
}

// shareNames gives every leg the names of all our legs, so any leg can spot
// a match with one of its own. It is also where a leased pool entry learns
// its server-assigned nickname: save it, and push it to the browser so the
// leg's identity row fills in.
func shareNames(s *Session) {
	s.mu.Lock()
	legs := make([]*Leg, 0, len(s.legs))
	for _, l := range s.legs {
		legs = append(legs, l)
	}
	s.mu.Unlock()
	names := map[string]bool{}
	for _, l := range legs {
		l.mu.Lock()
		name := l.username
		l.mu.Unlock()
		if name == "" {
			continue
		}
		names[name] = true
		s.user.Pool.SetUsername(name, l.deviceID, l.cookie, func(m string) { logs.Write(m, "pool", s.cid) })
		s.send("mitm", M{"leg": l.key, "what": "identity", "deviceId": l.deviceID, "username": name})
	}
	for _, l := range legs {
		l.mu.Lock()
		own := map[string]bool{}
		var list []string
		for n := range names {
			if n != l.username {
				own[n] = true
				list = append(list, n)
			}
		}
		l.ownNames = own
		l.mu.Unlock()
		if len(list) > 0 {
			sort.Strings(list)
			l.log("[loopback] know our other legs: " + pyList(list))
		}
	}
}

// legStart starts (or restarts) one relay leg with its own identity.
func legStart(s *Session, key, cookie, deviceID, lang string, seconds float64) error {
	legStop(s, key)
	if cookie == "" {
		s.send("mitm", M{"leg": key, "what": "log", "text": "no identity for leg"})
		return nil
	}
	l := &Leg{key: key, sess: s, cookie: cookie, deviceID: deviceID, lang: lang, seconds: seconds}
	s.mu.Lock()
	s.legs[key] = l
	s.mu.Unlock()
	if err := l.start(); err != nil {
		return err
	}
	l.mu.Lock()
	var name any
	if l.username != "" {
		name = l.username
	}
	l.mu.Unlock()
	s.send("mitm", M{"leg": key, "what": "identity", "deviceId": deviceID, "username": name})
	return nil
}

func legStop(s *Session, key string) {
	s.mu.Lock()
	l := s.legs[key]
	delete(s.legs, key)
	s.mu.Unlock()
	if l != nil {
		l.stop()
		l.close()
	}
}

func legsStopAll(s *Session) {
	s.mu.Lock()
	keys := make([]string, 0, len(s.legs))
	for k := range s.legs {
		keys = append(keys, k)
	}
	s.mu.Unlock()
	for _, k := range keys {
		legStop(s, k)
	}
}

func legNext(s *Session, key, reason string) {
	s.mu.Lock()
	l := s.legs[key]
	s.mu.Unlock()
	if l != nil {
		l.next(reason)
	}
}

func legSignal(s *Session, key string, msg M) {
	s.mu.Lock()
	l := s.legs[key]
	s.mu.Unlock()
	if l == nil {
		s.send("mitm", M{"leg": key, "what": "log", "text": "no such leg"})
		return
	}
	l.uiWebRTC(msg)
}
