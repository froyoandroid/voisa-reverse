"""BridgeCall, split by concern:

    core        lifecycle (start, stop, callbacks, call window)
    signalling  socket, matchmaking events, SDP/ICE relay to the browser
    peer        server-side RTCPeerConnection (when the browser is not the peer)
    recording   live recording of incoming tracks
"""
from voisa_pkg.call.bridge.core import BridgeCall                 # noqa: F401
from voisa_pkg.call.bridge.signalling import _webrtc_dir          # noqa: F401
