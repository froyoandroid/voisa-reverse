// Package sio is a minimal Socket.IO v4 client (engine.io protocol 4, websocket
// transport only), covering exactly what Voisa needs: connect to the default
// namespace, receive events, emit events with or without an ack, answer
// pings, and reconnect with backoff.
//
// Wire format, for reference:
//
//	engine.io  0 open {json} | 1 close | 2 ping | 3 pong | 4 message
//	socket.io  (inside an engine.io message) 0 connect | 1 disconnect |
//	           2 event [name, data] | 3 ack id[data] | 4 connect error
package sio

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Client is one upstream socket. Callbacks run on the client's reader
// goroutine, one at a time and in arrival order.
type Client struct {
	URL          string
	OnConnect    func(sid string)
	OnDisconnect func(reason string)
	OnEvent      func(event string, data json.RawMessage)

	// Reconnect after an unexpected drop, with delays doubling from
	// ReconnectMin up to ReconnectMax. Never after Close().
	Reconnect    bool
	ReconnectMin time.Duration
	ReconnectMax time.Duration

	mu        sync.Mutex
	conn      *websocket.Conn
	sid       string
	connected bool
	closed    bool
	nextAck   int
	acks      map[int]chan json.RawMessage
	wmu       sync.Mutex
	done      chan struct{}
}

var ErrNotConnected = errors.New("not connected")

// Connect dials and completes the handshake within timeout. Once connected,
// a reader goroutine owns the socket until it drops or Close is called.
func (c *Client) Connect(ctx context.Context, timeout time.Duration) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return errors.New("client closed")
	}
	if c.acks == nil {
		c.acks = map[int]chan json.RawMessage{}
	}
	c.mu.Unlock()
	conn, sid, ping, err := c.dial(ctx, timeout)
	if err != nil {
		return err
	}
	c.attach(conn, sid)
	go c.readLoop(conn, ping)
	return nil
}

func (c *Client) dial(ctx context.Context, timeout time.Duration) (*websocket.Conn, string, time.Duration, error) {
	hctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	conn, _, err := websocket.Dial(hctx, c.URL, nil)
	if err != nil {
		return nil, "", 0, err
	}
	conn.SetReadLimit(4 << 20)
	fail := func(e error) (*websocket.Conn, string, time.Duration, error) {
		conn.Close(websocket.StatusNormalClosure, "")
		return nil, "", 0, e
	}
	// engine.io open: 0{"sid":..,"pingInterval":..,"pingTimeout":..}
	_, msg, err := conn.Read(hctx)
	if err != nil {
		return fail(err)
	}
	if len(msg) == 0 || msg[0] != '0' {
		return fail(fmt.Errorf("unexpected engine.io open %q", trunc(msg)))
	}
	var open struct {
		PingInterval int `json:"pingInterval"`
		PingTimeout  int `json:"pingTimeout"`
	}
	_ = json.Unmarshal(msg[1:], &open)
	ping := time.Duration(open.PingInterval+open.PingTimeout) * time.Millisecond
	if ping <= 0 {
		ping = 45 * time.Second
	}
	// socket.io connect to the default namespace
	if err := conn.Write(hctx, websocket.MessageText, []byte("40")); err != nil {
		return fail(err)
	}
	for {
		_, msg, err := conn.Read(hctx)
		if err != nil {
			return fail(err)
		}
		s := string(msg)
		switch {
		case s == "2":
			_ = conn.Write(hctx, websocket.MessageText, []byte("3"))
		case strings.HasPrefix(s, "40"):
			var ok struct {
				SID string `json:"sid"`
			}
			_ = json.Unmarshal([]byte(s[2:]), &ok)
			return conn, ok.SID, ping, nil
		case strings.HasPrefix(s, "44"):
			return fail(fmt.Errorf("connect error: %s", s[2:]))
		}
	}
}

func (c *Client) attach(conn *websocket.Conn, sid string) {
	c.mu.Lock()
	c.conn, c.sid, c.connected = conn, sid, true
	c.done = make(chan struct{})
	c.mu.Unlock()
	if c.OnConnect != nil {
		c.OnConnect(sid)
	}
}

func (c *Client) readLoop(conn *websocket.Conn, ping time.Duration) {
	reason := "transport close"
	for {
		ctx, cancel := context.WithTimeout(context.Background(), ping)
		_, msg, err := conn.Read(ctx)
		cancel()
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				reason = "ping timeout"
			}
			break
		}
		if stop, why := c.handle(conn, string(msg)); stop {
			reason = why
			break
		}
	}
	conn.Close(websocket.StatusNormalClosure, "")

	c.mu.Lock()
	wasClosed := c.closed
	if c.conn == conn {
		c.conn, c.connected = nil, false
		close(c.done)
	}
	for id, ch := range c.acks {
		close(ch)
		delete(c.acks, id)
	}
	c.mu.Unlock()
	if wasClosed {
		return // Close() already reported the disconnect
	}
	if c.OnDisconnect != nil {
		c.OnDisconnect(reason)
	}
	if c.Reconnect && reason != "io server disconnect" {
		c.reconnect()
	}
}

func (c *Client) reconnect() {
	delay := c.ReconnectMin
	if delay <= 0 {
		delay = time.Second
	}
	max := c.ReconnectMax
	if max <= 0 {
		max = 5 * time.Second
	}
	for {
		time.Sleep(delay)
		c.mu.Lock()
		closed := c.closed
		c.mu.Unlock()
		if closed {
			return
		}
		conn, sid, ping, err := c.dial(context.Background(), 20*time.Second)
		if err == nil {
			c.mu.Lock()
			if c.closed {
				c.mu.Unlock()
				conn.Close(websocket.StatusNormalClosure, "")
				return
			}
			c.mu.Unlock()
			c.attach(conn, sid)
			go c.readLoop(conn, ping)
			return
		}
		if delay *= 2; delay > max {
			delay = max
		}
	}
}

// handle processes one engine.io frame; stop reports a server-side close.
func (c *Client) handle(conn *websocket.Conn, s string) (stop bool, reason string) {
	if s == "" {
		return false, ""
	}
	switch s[0] {
	case '2': // ping -> pong
		c.write(conn, "3")
	case '1':
		return true, "transport close"
	case '4':
		p := s[1:]
		if p == "" {
			return false, ""
		}
		switch p[0] {
		case '1':
			return true, "io server disconnect"
		case '2':
			body := skipDigits(p[1:])
			var arr []json.RawMessage
			if json.Unmarshal([]byte(body), &arr) != nil || len(arr) == 0 {
				return false, ""
			}
			var name string
			if json.Unmarshal(arr[0], &name) != nil {
				return false, ""
			}
			var data json.RawMessage
			if len(arr) > 1 {
				data = arr[1]
			}
			if c.OnEvent != nil {
				c.OnEvent(name, data)
			}
		case '3':
			rest := p[1:]
			i := 0
			for i < len(rest) && rest[i] >= '0' && rest[i] <= '9' {
				i++
			}
			id, err := strconv.Atoi(rest[:i])
			if err != nil {
				return false, ""
			}
			var arr []json.RawMessage
			_ = json.Unmarshal([]byte(rest[i:]), &arr)
			c.mu.Lock()
			ch := c.acks[id]
			delete(c.acks, id)
			c.mu.Unlock()
			if ch != nil {
				if len(arr) > 0 {
					ch <- arr[0]
				} else {
					ch <- json.RawMessage("null")
				}
				close(ch)
			}
		}
	}
	return false, ""
}

func (c *Client) write(conn *websocket.Conn, s string) error {
	c.wmu.Lock()
	defer c.wmu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, []byte(s))
}

func (c *Client) live() *websocket.Conn {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.connected {
		return nil
	}
	return c.conn
}

// Emit sends an event with one data argument (nil sends {}).
func (c *Client) Emit(event string, data any) error {
	conn := c.live()
	if conn == nil {
		return ErrNotConnected
	}
	frame, err := encode("", event, data)
	if err != nil {
		return err
	}
	return c.write(conn, frame)
}

// EmitAck sends an event and waits up to timeout for the server's ack.
func (c *Client) EmitAck(event string, data any, timeout time.Duration) (json.RawMessage, error) {
	conn := c.live()
	if conn == nil {
		return nil, ErrNotConnected
	}
	c.mu.Lock()
	id := c.nextAck
	c.nextAck++
	ch := make(chan json.RawMessage, 1)
	c.acks[id] = ch
	c.mu.Unlock()
	frame, err := encode(strconv.Itoa(id), event, data)
	if err != nil {
		return nil, err
	}
	if err := c.write(conn, frame); err != nil {
		return nil, err
	}
	select {
	case r, ok := <-ch:
		if !ok {
			return nil, ErrNotConnected
		}
		return r, nil
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.acks, id)
		c.mu.Unlock()
		return nil, errors.New("ack timeout")
	}
}

func encode(ackID, event string, data any) (string, error) {
	if data == nil {
		data = map[string]any{}
	}
	b, err := json.Marshal([]any{event, data})
	if err != nil {
		return "", err
	}
	return "42" + ackID + string(b), nil
}

// Connected reports whether the socket is up right now.
func (c *Client) Connected() bool { return c.live() != nil }

// SID is the socket.io session id of the current connection.
func (c *Client) SID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sid
}

// Close disconnects for good: no reconnect. OnDisconnect fires once with
// "io client disconnect" when the socket was up.
func (c *Client) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	conn, was := c.conn, c.connected
	c.mu.Unlock()
	if conn != nil {
		_ = c.write(conn, "41")
		conn.Close(websocket.StatusNormalClosure, "")
	}
	if was && c.OnDisconnect != nil {
		c.OnDisconnect("io client disconnect")
	}
}

func skipDigits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[i:]
}

func trunc(b []byte) string {
	if len(b) > 80 {
		return string(b[:80])
	}
	return string(b)
}
