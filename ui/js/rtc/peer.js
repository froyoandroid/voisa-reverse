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
  audioSender: null,  // the call's one outgoing audio sender
  upCtx: null,        // silent placeholder track until Talk
  upStream: null,
  upTrack: null,
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
  if (rtc.audioSender && rtc.upTrack) rtc.audioSender.replaceTrack(rtc.upTrack).catch(() => {});
  micPaint();
}
// The call always carries one outgoing audio track: a silent placeholder until
// the user taps Talk, then the mic, swapped in with replaceTrack. The peer
// app ignores a mid-call renegotiation that adds a new audio m-line, so the
// old "add the mic, then re-offer" path never reached them.
function rtcSilentTrack() {
  if (rtc.upTrack && rtc.upTrack.readyState === "live") return rtc.upTrack;
  try {
    const ctx = rtc.upCtx || (rtc.upCtx = new AudioContext());
    const src = ctx.createConstantSource();
    src.offset.value = 0;
    const dst = ctx.createMediaStreamDestination();
    src.connect(dst);
    src.start();
    rtc.upStream = dst.stream;
    rtc.upTrack = dst.stream.getAudioTracks()[0] || null;
  } catch (_) {
    rtc.upStream = null; rtc.upTrack = null;
  }
  return rtc.upTrack;
}
async function micAttach() {
  if (!rtc.audioSender || !rtc.micTrack) return;
  if (rtc.audioSender.track === rtc.micTrack) return;
  await rtc.audioSender.replaceTrack(rtc.micTrack);
  logLine("mic: on the outgoing audio track", "sys");
}

async function rtcStart(matchId) {
  await rtcStop();
  rtc.matchId = matchId;
  const pc = new RTCPeerConnection({ iceServers: rtc.iceServers || [] });
  rtc.pc = pc;

  // Audio is sendrecv from the first offer. It carries a silent track (so no
  // mic prompt) until Talk swaps the mic in with replaceTrack.
  //
  // BOTH audio and video m-lines are required. The server-side path added the
  // same pair; with audio alone the peer completes ICE and DTLS but then tears
  // the call down because its video leg has nowhere to go.
  const up = rtcSilentTrack();
  rtc.audioSender = up
    ? pc.addTrack(up, rtc.upStream)
    : pc.addTransceiver("audio", { direction: "sendrecv" }).sender;
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
