"use strict";
// Browser WebRTC peer: connection, mic, playback, meter.

// browser WebRTC peer
// The browser — not the server — terminates the call. Audio decodes straight to
// the local <audio> element, so there is no PCM relay, no resampler, and no
// host sound card: pitch is correct because nothing re-times the samples.
const rtc = {
  pc: null,
  matchId: null,
  rec: null,          // MediaRecorder
  chunks: [],
  micStream: null,
  micTrack: null,
  micState: "off",    // off | live | muted
  micDenied: false,
  pendingCandidates: [],
  waveCtx: null,
  waveSrc: null,
  waveAn: null,
  waveRaf: 0,
};

function rtcAttachAudio(stream) {
  const el = $("peerAudio");
  if (!el || !stream) return;
  el.srcObject = stream;
  const p = el.play();
  if (p && p.catch) p.catch((e) => logLine(`audio play blocked: ${e.message}`, "err"));
  logLine("rtc: partner audio -> playing on THIS device", "sys");
  waveStart(stream);
  if (rtc.recording) rtcRecordStart(stream);
}
// Local meter: the server never sends phase:"level" in browser-peer mode, so
// the wavebox reads the peer stream directly. No signalling change.
function waveStart(stream) {
  waveStop();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !stream.getAudioTracks().length) return;
    const ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 1024;
    src.connect(an);
    rtc.waveCtx = ctx; rtc.waveSrc = src; rtc.waveAn = an;
    const buf = new Float32Array(an.fftSize);
    const tick = () => {
      if (!rtc.waveAn) return;
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      WAVE.push(Math.min(1, Math.sqrt(sum / buf.length) * 3), buf.length);
      rtc.waveRaf = requestAnimationFrame(tick);
    };
    WAVE.reset("Receiving audio");
    tick();
  } catch (_) {}
}
function waveStop() {
  if (rtc.waveRaf) cancelAnimationFrame(rtc.waveRaf);
  rtc.waveRaf = 0; rtc.waveAn = null; rtc.waveSrc = null;
  if (rtc.waveCtx) { try { rtc.waveCtx.close(); } catch (_) {} rtc.waveCtx = null; }
}

function rtcSend(obj) {
  if (ws && ws.readyState === 1) send(Object.assign({ cmd: "webrtc" }, obj));
}
// Mic capture with standard VoIP processing. Single track only.
async function micEnsure() {
  const live = rtc.micStream?.getAudioTracks()?.find((t) => t.readyState === "live");
  if (live) { rtc.micTrack = live; rtc.micDenied = false; return rtc.micStream; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      video: false,
    });
    const tracks = stream.getAudioTracks();
    for (let i = 1; i < tracks.length; i++) tracks[i].stop();
    rtc.micStream = stream;
    rtc.micTrack = tracks[0] || null;
    if (rtc.micTrack) rtc.micTrack.enabled = true;
    rtc.micDenied = false;
    micPaint();
    return stream;
  } catch (e) {
    rtc.micStream = null; rtc.micTrack = null; rtc.micDenied = true; rtc.micState = "off";
    micPaint();
    logLine(`Mic blocked: ${e && e.name || e}`, "err");
    throw e;
  }
}
function micCleanup() {
  try { rtc.micStream?.getTracks()?.forEach((t) => t.stop()); } catch (_) {}
  rtc.micStream = null; rtc.micTrack = null; rtc.micState = "off";
  micPaint();
}
// Publish the mic mid-call via renegotiation. Keeps the working recvonly join
// path untouched; adds a send m-line only when the user taps Talk.
async function micAttachRenegotiate() {
  if (!rtc.pc || !rtc.micTrack || CallState.mode !== "active") return;
  if (rtc.pc.getSenders().find((s) => s.track === rtc.micTrack)) return;
  rtc.pc.addTrack(rtc.micTrack, rtc.micStream);
  const offer = await rtc.pc.createOffer();
  await rtc.pc.setLocalDescription(offer);
  await rtcGatherComplete(rtc.pc);
  rtcSend({ offer: { type: "offer", sdp: rtc.pc.localDescription.sdp } });
  logLine("mic: track published, renegotiated", "sys");
}

async function rtcStart(matchId) {
  await rtcStop();
  rtc.matchId = matchId;
  const pc = new RTCPeerConnection({ iceServers: rtc.iceServers || [] });
  rtc.pc = pc;

  // Receive-only: we want the partner's audio. We publish no mic by default,
  // so no permission prompt appears.
  //
  // BOTH audio and video m-lines are required. The server-side path added the
  // same pair; with audio alone the peer completes ICE and DTLS but then tears
  // the call down because its video leg has nowhere to go.
  pc.addTransceiver("audio", { direction: "recvonly" });
  pc.addTransceiver("video", { direction: "recvonly" });

  pc.ontrack = (ev) => {
    // only audio plays; video arrives so the dialog stays alive
    if (ev.track.kind !== "audio") {
      ev.track.enabled = false;
      return;
    }
    rtcAttachAudio(ev.streams[0]);
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      rtcSend({ iceCandidate: {
        candidate: ev.candidate.candidate,
        sdpMid: ev.candidate.sdpMid,
        sdpMLineIndex: ev.candidate.sdpMLineIndex,
      } });
    }
  };

  pc.onconnectionstatechange = () =>
    logLine(`rtc: ${pc.connectionState}`, pc.connectionState === "connected" ? "sys" : "warn");
  pc.oniceconnectionstatechange = () =>
    logLine(`rtc ice: ${pc.iceConnectionState}`, "sys");

  return pc;
}
