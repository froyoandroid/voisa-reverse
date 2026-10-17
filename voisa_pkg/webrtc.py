"""WebRTC helpers shared by the call classes."""
import asyncio

from aiortc import RTCIceCandidate

async def _gather_complete(pc, timeout: float = 4.0) -> None:
    """Wait until ICE gathering finishes so localDescription holds candidates.

    aiortc 1.15 does NOT emit per-candidate "icecandidate" events (the handler
    never fires), and ``createOffer().sdp`` is built BEFORE gathering starts, so
    it contains no ``a=candidate`` lines. Trickle therefore never delivers
    anything and the peer is left with a candidate-less offer -> ICE hangs in
    "connecting" and no media ever flows. Sending the post-gathering
    ``localDescription.sdp`` (non-trickle ICE) fixes it.
    """
    if pc.iceGatheringState == "complete":
        return
    loop = asyncio.get_event_loop()
    done = loop.create_future()

    @pc.on("icegatheringstatechange")
    def _on_change():
        if pc.iceGatheringState == "complete" and not done.done():
            done.set_result(True)

    try:
        await asyncio.wait_for(done, timeout=timeout)
    except asyncio.TimeoutError:
        pass




def parse_ice_candidate(raw: str, sdp_mid=None, sdp_mline=None) -> RTCIceCandidate | None:
    """Parse an SDP candidate line into aiortc's RTCIceCandidate.

    Format: candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type>
            [raddr <addr>] [rport <port>] [tcptype <t>]
    """
    try:
        parts = raw.replace("candidate:", "").split()
        if len(parts) < 8 or parts[6] != "typ":
            return None
        d = {
            "foundation": parts[0], "component": int(parts[1]), "protocol": parts[2],
            "priority": int(parts[3]), "ip": parts[4], "port": int(parts[5]),
            "type": parts[7],
        }
        for i in range(8, len(parts) - 1):
            k, v = parts[i], parts[i + 1]
            if k == "raddr": d["relatedAddress"] = v
            elif k == "rport": d["relatedPort"] = int(v)
            elif k == "tcptype": d["tcpType"] = v
        return RTCIceCandidate(
            component=d["component"], foundation=d["foundation"], ip=d["ip"],
            port=d["port"], priority=d["priority"], protocol=d["protocol"],
            type=d["type"], relatedAddress=d.get("relatedAddress"),
            relatedPort=d.get("relatedPort"), sdpMid=sdp_mid,
            sdpMLineIndex=sdp_mline, tcpType=d.get("tcpType"))
    except Exception:
        return None




# ── loopback guard ───────────────────────────────────────────────────────────
# Two relays we run must never end up talking to each other. If they do, the
# bridge feeds each leg's audio into the other's outbound — a closed loop that
# echoes and can run away.
#
# The match payload carries no peer account id (only {matchId, username,
# premium, avatar}), so we cannot ask "is this peer one of mine?" directly.
# Instead, correlate what the legs report about themselves:
#
#   * two legs of one browser emit ICE candidates from the SAME host addresses
#     (they run in the same process, on the same machine)
#   * a genuine remote peer comes from somewhere else
#
# So: if leg X's remote peer candidates and leg Y's remote peer candidates share
# a local/host address, X and Y are almost certainly on the same machine — i.e.
# facing each other. Treat that as loopback and break the match.

def candidate_addr(candidate: str):
    """Pull the address out of an SDP candidate line, or None.

    `candidate:842163049 1 udp 1677729535 203.0.113.9 54321 typ srflx ...`
    """
    if not candidate:
        return None
    parts = candidate.split()
    # c, component, transport, priority, addr, port, "typ", type
    for i, p in enumerate(parts):
        if p == "typ" and i >= 2:
            return parts[i - 2] or None
    return None


def is_private(addr: str) -> bool:
    """RFC1918 / link-local / loopback — an address only meaningful on a LAN."""
    if not addr:
        return False
    if addr.startswith(("10.", "192.168.", "127.", "169.254.", "0.")):
        return True
    if addr.startswith("172."):
        try:
            return 16 <= int(addr.split(".")[1]) <= 31
        except (IndexError, ValueError):
            return False
    if addr in ("::1",) or addr.lower().startswith(("fe80:", "fc", "fd")):
        return True
    return False


def peer_candidates(msg: dict) -> list:
    """Addresses from an ICE message, if it carries any."""
    c = (msg or {}).get("iceCandidate") or {}
    addr = candidate_addr(c.get("candidate", ""))
    return [addr] if addr else []


def looks_like_loopback(legs: dict) -> list:
    """Return pairs of leg keys whose peers appear to be on the same machine.

    `legs` maps a leg key to {"local": [...addrs], "remote": [...addrs]} where
    `local` are addresses we advertised and `remote` are addresses the peer
    advertised. A shared private address between two legs' remotes means both
    "peers" are behind the same NAT as us — almost certainly our own legs.
    """
    pairs = []
    keys = [k for k, v in legs.items() if v.get("remote")]
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            ra = set(legs[a].get("remote") or [])
            rb = set(legs[b].get("remote") or [])
            # Any shared address is suspicious, private or not: two unrelated
            # strangers do not advertise the same public IP unless they are the
            # same machine or the same NAT.
            shared = ra & rb
            # A shared PRIVATE address is the strong signal — two legs in one
            # browser advertise the same LAN address, and a far-away stranger
            # cannot share it. A shared public address is weaker (one household,
            # one office, one VPN) and worth flagging rather than acting on
            # blindly, so report which kind it was.
            if shared:
                priv = {x for x in shared if is_private(x)}
                pairs.append({"legs": (a, b), "shared": sorted(shared),
                              "private": sorted(priv),
                              "confidence": "high" if priv else "low"})
    return pairs
