"use strict";
// Incoming-audio waveform.

// live incoming-audio waveform
// Fed from the server's `call` messages with phase:"level" (one per ~50ms).
// If the line stays flat you are receiving no audio, whatever the logs say.
const WAVE = (() => {
  const HIST = 180;                 // ~9s of history at 20 msg/s
  const levels = new Array(HIST).fill(0);
  let peak = 0, peakHold = 0, peakAt = 0, lastMsg = 0, drawn = 0, got = 0;

  const cv = () => document.getElementById("wave");
  const ctx = () => cv().getContext("2d");

  function fit() {
    const c = cv();
    if (!c) return 0;
    const w = c.clientWidth || 380;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(80 * dpr);
    }
    return dpr;
  }

  let stEl = null;
  function els() {
    if (!stEl) stEl = document.getElementById("wavestate");
  }
  function push(level, samples) {
    got++;
    lastMsg = performance.now();
    levels.push(level); levels.shift();
    peak = level;
    if (level >= peakHold - 0.001) { peakHold = level; peakAt = lastMsg; }
    els();
    if (stEl) {
      stEl.textContent = level > 0.001 ? "Receiving audio" : "Silent";
      stEl.className = level > 0.001 ? "live" : "idle";
    }
  }
  function reset(label) {
    levels.fill(0); peak = 0; peakHold = 0; got = 0;
    els();
    if (stEl) { stEl.textContent = label || "No audio"; stEl.className = "idle"; }
  }

  function draw() {
    const c = cv(); if (!c) return;
    const dpr = fit();
    const g = ctx();
    const W = c.width, H = c.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);

    // grid: centre line + quarters
    const css = getComputedStyle(document.documentElement);
    const WV = (css.getPropertyValue("--wave") || "254,127,45").trim();
    const WI = (css.getPropertyValue("--wave-idle") || "138,154,167").trim();
    g.strokeStyle = css.getPropertyValue("--grid").trim() || "rgba(255,255,255,.07)"; g.lineWidth = 1;
    [0.25, 0.5, 0.75].forEach(f => {
      g.beginPath(); g.moveTo(0, H * f); g.lineTo(W, H * f); g.stroke();
    });

    const barW = W / HIST;
    const mid = H / 2;
    levels.forEach((v, i) => {
      const h = Math.max(1, v * mid * 0.95);
      const x = i * barW;
      // fresh messages bright, stale history dimmed
      const age = (i / HIST);
      g.fillStyle = v > 0.001
        ? `rgba(${WV},${0.9 - age * 0.55})`
        : `rgba(${WI},.25)`;
      g.fillRect(x, mid - h, Math.max(1, barW - 1), h * 2);
    });

    // peak-hold line, decays after 1.2s
    if (peakAt && performance.now() - peakAt < 1200 && peakHold > 0.001) {
      g.strokeStyle = `rgba(${WV},.95)`; g.lineWidth = 1.5;
      const y = mid - peakHold * mid * 0.95;
      g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      g.beginPath(); g.moveTo(0, H - y); g.lineTo(W, H - y); g.stroke();
    }

    // stale: no level message for 2s -> say so explicitly
    if (lastMsg && performance.now() - lastMsg > 2000) {
      els();
      if (stEl) { stEl.textContent = "No audio"; stEl.className = "dead"; }
    }
    requestAnimationFrame(draw);
  }

  reset();
  window.addEventListener("resize", fit);
  requestAnimationFrame(draw);
  return { push, reset };
})();
