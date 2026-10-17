"""Voisa wire protocol: server endpoints, client identity and event names.

Captured from app.voisa v3.2.0. Every other module takes these from here, so a
version bump is a one-line change.
"""

SERVER = "https://voisa.stivisto.com"
API = SERVER + "/api/v0/createAccount"
SOCK_PATH = "socket.io"
APP_VERSION, PLATFORM = "3.2.0", "android"


def socket_query(cookie: str) -> str:
    """Query string the app sends when it opens its socket."""
    return (f"?cookie={cookie}&version={APP_VERSION}&platform={PLATFORM}"
            f"&rawLanguage=en-GB&language=en&currentTheme=system")


def socket_url(cookie: str) -> str:
    return SERVER + "/" + socket_query(cookie)


# real wire events, both directions
SERVER_EVENTS = [
    "check-version", "fetch-initial-data", "start-dialog", "close-dialog",
    "webrtc", "ban-update", "set-premium", "update-user", "share-contacts",
]


CLIENT_EVENTS = [
    "start-search", "stop-search", "sync-call-state", "start-dialog",
    "close-dialog", "close-dialog-v1", "webrtc", "set-search-language",
    "shuffle-username", "update-avatar",
    # bidirectional: the dialog acknowledgement
    "buffer-dialog",
]


ALL_EVENTS = sorted(set(SERVER_EVENTS + CLIENT_EVENTS))
