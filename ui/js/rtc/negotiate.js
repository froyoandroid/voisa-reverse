"use strict";
// SDP/ICE negotiation with the Voisa peer.

// The server tells us who offers. If it is us, create the offer.
// Wait for ICE gathering to finish, then return the SDP with every candidate
// inlined. The server-side path did the same (non-trickle). Sending an SDP with
// no candidates and relying on trickle made some peers complete ICE and then
// drop the call, because their video leg never got a usable candidate pair.
// Candidates also trickle as they are found, so this only waits long enough to
// inline the fast host/srflx ones; waiting for every TURN allocation delayed
// the offer by seconds while the peer sat in silence.
function rtcGatherComplete(pc, ms = 1200) {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener("icegatheringstatechange", done);
        resolve();
      }
    };
    pc.addEventListener("icegatheringstatechange", done);
    setTimeout(() => { pc.removeEventListener("icegatheringstatechange", done); resolve(); }, ms);
  });
}

async function rtcOffer() {
  const pc = rtc.pc || (await rtcStart(currentMatchId));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await rtcGatherComplete(pc);
  const sdp = pc.localDescription.sdp;
  const n = sdp.split("\n").filter((l) => l.startsWith("a=candidate")).length;
  rtcSend({ offer: { type: "offer", sdp } });
  logLine(`rtc: offer -> server (${n} candidate(s))`, "sys");
}

// Handle a `webrtc` message relayed from the peer.
async function rtcHandle(m) {
  const p = m.payload || {};
  if (p.matchId && !rtc.matchId) await rtcStart(p.matchId);

  if (p.offer) {
    const pc = rtc.pc || (await rtcStart(p.matchId));
    await pc.setRemoteDescription({ type: "offer", sdp: p.offer.sdp });
    await rtcFlushCandidates();
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await rtcGatherComplete(pc);
    const asdp = pc.localDescription.sdp;
    const an = asdp.split("\n").filter((l) => l.startsWith("a=candidate")).length;
    rtcSend({ answer: { type: "answer", sdp: asdp } });
    logLine(`rtc: answer -> server (${an} candidate(s))`, "sys");
  } else if (p.answer) {
    if (rtc.pc && rtc.pc.signalingState !== "stable") {
      await rtc.pc.setRemoteDescription({ type: "answer", sdp: p.answer.sdp });
      await rtcFlushCandidates();
      logLine("rtc: remote answer applied", "sys");
    }
  } else if (p.iceCandidate) {
    // Candidates can arrive BEFORE the offer/answer is applied (trickle ICE).
    // addIceCandidate then throws "remote description was null" and the
    // candidate is lost, which stalls ICE on a slow or TURN-only path. Queue
    // them and drain once a remote description exists.
    const cand = {
      candidate: p.iceCandidate.candidate,
      sdpMid: p.iceCandidate.sdpMid,
      sdpMLineIndex: p.iceCandidate.sdpMLineIndex,
    };
    if (!rtc.pc || !rtc.pc.remoteDescription) {
      rtc.pendingCandidates.push(cand);
      return;
    }
    await rtcAddCandidate(cand);
  }
}

async function rtcAddCandidate(cand) {
  try {
    await rtc.pc.addIceCandidate(cand);
  } catch (e) {
    logLine(`rtc addIceCandidate: ${e.message}`, "warn");
  }
}

async function rtcFlushCandidates() {
  const q = rtc.pendingCandidates.splice(0);
  if (q.length) logLine(`rtc: applying ${q.length} queued candidate(s)`, "sys");
  for (const c of q) await rtcAddCandidate(c);
}
