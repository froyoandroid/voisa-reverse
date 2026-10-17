// Package protocol holds the Voisa wire protocol: endpoints, client identity
// and event names, captured from app.voisa v3.2.0. Every other package takes
// these from here, so a version bump is a one-line change.
package protocol

import "net/url"

const (
	Server     = "https://voisa.stivisto.com"
	API        = Server + "/api/v0/createAccount"
	SockPath   = "socket.io"
	AppVersion = "3.2.0"
	Platform   = "android"
)

// ServerEvents are the real wire events the server sends.
var ServerEvents = []string{
	"check-version", "fetch-initial-data", "start-dialog", "close-dialog",
	"webrtc", "ban-update", "set-premium", "update-user", "share-contacts",
}

// SocketURL is the engine.io websocket URL for one identity, with the query
// string the app itself sends when it opens its socket.
func SocketURL(cookie string) string {
	// built by hand rather than with url.Values, which sorts the keys: this
	// keeps the app's own parameter order
	return "wss://voisa.stivisto.com/" + SockPath + "/?cookie=" + url.QueryEscape(cookie) +
		"&version=" + AppVersion + "&platform=" + Platform +
		"&rawLanguage=en-GB&language=en&currentTheme=system&EIO=4&transport=websocket"
}
