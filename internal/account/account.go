// Package account mints and re-fetches Voisa identities.
//
// An account is just a deviceId plus a server-issued cookie:
//
//	POST /api/v0/createAccount {"deviceId": "..."}  ->  {"cookie": "<uuid>"}
//
// The cookie is the whole credential: every socket connection passes it as a
// query parameter. Reusing a deviceId reuses its cookie; a new deviceId mints
// a fresh identity with a fresh server-assigned nickname.
package account

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"voisa/internal/protocol"
)

var httpClient = &http.Client{Timeout: 15 * time.Second}

// Identity is what a browser session holds.
type Identity struct {
	DeviceID string  `json:"deviceId"`
	Cookie   string  `json:"cookie"`
	Created  float64 `json:"created,omitempty"`
}

// Create calls createAccount for a deviceId and returns its cookie.
func Create(deviceID string) (string, error) {
	body, _ := json.Marshal(map[string]string{"deviceId": deviceID})
	req, _ := http.NewRequest("POST", protocol.API, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("createAccount: HTTP %d", resp.StatusCode)
	}
	var out struct {
		Cookie string `json:"cookie"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("createAccount: %w", err)
	}
	if out.Cookie == "" {
		return "", fmt.Errorf("createAccount: no cookie in reply")
	}
	return out.Cookie, nil
}

// NewDeviceID returns an id in the shape the app itself uses: 16 hex chars,
// no prefix (the first half of a v4 UUID, as the Python client minted). Do
// not add a prefix: "voisa-py-" once stamped every account we created.
func NewDeviceID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	return hex.EncodeToString(b)
}

// Fresh mints a brand-new identity.
func Fresh() (Identity, error) {
	did := NewDeviceID()
	c, err := Create(did)
	if err != nil {
		return Identity{}, err
	}
	return Identity{DeviceID: did, Cookie: c, Created: Now()}, nil
}

// Register re-fetches the cookie of a known deviceId (idempotent).
func Register(deviceID string) (Identity, error) {
	c, err := Create(deviceID)
	if err != nil {
		return Identity{}, err
	}
	return Identity{DeviceID: deviceID, Cookie: c}, nil
}

// Now is the current time as Unix seconds with a fraction, the unit every
// stored timestamp uses.
func Now() float64 { return float64(time.Now().UnixNano()) / 1e9 }
