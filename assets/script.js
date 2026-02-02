// Simple browser-only karaoke prototype.
// - Upload audio file
// - Extract a rough melody track via autocorrelation
// - Play song + capture mic
// - Compare your pitch to the target melody and compute a lenient score

(function () {
  const fileInput = document.getElementById("song-file");
  const analyzeBtn = document.getElementById("analyze-btn");
  const statusEl = document.getElementById("status");
  const fileNameEl = document.getElementById("file-name");
  const canvas = document.getElementById("pitch-canvas");
  const ctx = canvas.getContext("2d");
  const audioEl = document.getElementById("player");
  const startSingingBtn = document.getElementById("start-singing-btn");
  const stopSingingBtn = document.getElementById("stop-singing-btn");
  const scoreEl = document.getElementById("score");

  let audioContext = null;
  let decodedBuffer = null;
  let pitchTrack = []; // { time, midi }

  let micStream = null;
  let micSource = null;
  let scriptNode = null;

  let scoring = {
    totalFrames: 0,
    hitFrames: 0,
  };

  let objectUrl = null;

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", !!isError);
  }

  function setScoreText(text) {
    if (scoreEl) {
      scoreEl.textContent = text;
    }
  }

  function ensureAudioContext() {
    if (!audioContext) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) {
        throw new Error("Web Audio API not supported in this browser.");
      }
      audioContext = new AC();
    }
    return audioContext;
  }

  // --- Pitch detection helpers ---

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  function detectPitch(frame, sampleRate) {
    // Basic autocorrelation-based pitch detector.
    const size = frame.length;
    let rms = 0;
    for (let i = 0; i < size; i++) {
      const v = frame[i];
      rms += v * v;
    }
    rms = Math.sqrt(rms / size);
    if (rms < 0.01) return null; // too quiet / silence

    const corr = new Float32Array(size);
    for (let lag = 0; lag < size; lag++) {
      let sum = 0;
      for (let i = 0; i < size - lag; i++) {
        sum += frame[i] * frame[i + lag];
      }
      corr[lag] = sum;
    }

    let d = 0;
    while (d < size - 1 && corr[d] > corr[d + 1]) {
      d++;
    }

    let maxIndex = -1;
    let maxVal = -1;
    for (let i = d; i < size; i++) {
      if (corr[i] > maxVal) {
        maxVal = corr[i];
        maxIndex = i;
      }
    }

    if (maxIndex <= 0) return null;

    const freq = sampleRate / maxIndex;
    if (freq < 60 || freq > 2000) return null;
    return freq;
  }

  function buildPitchTrackFromBuffer(buffer) {
    const channelData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;

    const frameSize = 2048;
    const hopSize = 1024;

    const track = [];
    const len = channelData.length;

    const frame = new Float32Array(frameSize);
    let frameIndex = 0;

    for (let offset = 0; offset + frameSize < len; offset += hopSize) {
      for (let i = 0; i < frameSize; i++) {
        frame[i] = channelData[offset + i];
      }
      const freq = detectPitch(frame, sampleRate);
      if (freq) {
        const midi = freqToMidi(freq);
        const time = offset / sampleRate;
        track.push({ time, midi });
      }
      frameIndex++;
    }
    return track;
  }

  function drawPitchTrack(track) {
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = "rgba(15,23,42,0.04)";
    ctx.fillRect(0, 0, w, h);

    if (!track || track.length === 0) {
      ctx.fillStyle = "#6b7280";
      ctx.font = "13px system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      ctx.fillText("Run analysis to see a rough melody curve.", 16, h / 2);
      return;
    }

    const minTime = track[0].time;
    const maxTime = track[track.length - 1].time;

    let minMidi = Infinity;
    let maxMidi = -Infinity;
    for (const p of track) {
      if (p.midi < minMidi) minMidi = p.midi;
      if (p.midi > maxMidi) maxMidi = p.midi;
    }

    if (!isFinite(minMidi) || !isFinite(maxMidi) || maxTime <= minTime) {
      return;
    }

    const padding = 20;

    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding);
    ctx.lineTo(padding, h - padding);
    ctx.lineTo(w - padding, h - padding);
    ctx.stroke();

    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 2;
    ctx.beginPath();

    track.forEach((p, idx) => {
      const x = padding + ((p.time - minTime) / (maxTime - minTime)) * (w - 2 * padding);
      const y =
        h -
        padding -
        ((p.midi - minMidi) / Math.max(1, maxMidi - minMidi)) * (h - 2 * padding);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
  }

  function handleFileChange() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      fileNameEl.textContent = "No file selected yet.";
      analyzeBtn.disabled = true;
      setStatus("");
      return;
    }

    fileNameEl.textContent = file.name;
    analyzeBtn.disabled = false;
    setStatus("Ready to analyze melody.");

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }

    objectUrl = URL.createObjectURL(file);
    audioEl.src = objectUrl;
  }

  async function analyzeSong() {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;

    analyzeBtn.disabled = true;
    startSingingBtn.disabled = true;
    stopSingingBtn.disabled = true;
    setStatus("Decoding audio and extracting melody… this can take a few seconds.");

    try {
      const ac = ensureAudioContext();
      const arrayBuffer = await file.arrayBuffer();
      decodedBuffer = await ac.decodeAudioData(arrayBuffer);
      pitchTrack = buildPitchTrackFromBuffer(decodedBuffer);

      if (!pitchTrack.length) {
        setStatus(
          "Could not detect a stable melody in this file. Try a track with clear vocals.",
          true
        );
        drawPitchTrack([]);
        analyzeBtn.disabled = false;
        return;
      }

      drawPitchTrack(pitchTrack);
      setStatus(
        `Analysis complete. Found ${pitchTrack.length} pitch samples over ${decodedBuffer.duration.toFixed(
          1
        )}s.`,
        false
      );

      startSingingBtn.disabled = false;
      setScoreText("Score: –");
    } catch (err) {
      console.error(err);
      setStatus("Error analyzing audio. This file type might not be supported.", true);
    } finally {
      analyzeBtn.disabled = false;
    }
  }

  function getTargetMidiAtTime(time) {
    if (!pitchTrack || pitchTrack.length === 0) return null;

    let lo = 0;
    let hi = pitchTrack.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = pitchTrack[mid].time;
      if (t < time) lo = mid + 1;
      else if (t > time) hi = mid - 1;
      else return pitchTrack[mid].midi;
    }

    const i1 = Math.max(0, Math.min(pitchTrack.length - 1, lo));
    const i0 = Math.max(0, i1 - 1);
    const p0 = pitchTrack[i0];
    const p1 = pitchTrack[i1];

    if (!p0 || !p1) return p0 ? p0.midi : p1.midi;

    const span = p1.time - p0.time;
    if (span <= 0) return p0.midi;
    const ratio = (time - p0.time) / span;
    return p0.midi + (p1.midi - p0.midi) * Math.min(1, Math.max(0, ratio));
  }

  function startScoringSession() {
    scoring = { totalFrames: 0, hitFrames: 0 };
    setScoreText("Score: listening…");
  }

  async function startSinging() {
    if (!decodedBuffer || !pitchTrack.length) {
      setStatus("Analyze a song first.", true);
      return;
    }

    const ac = ensureAudioContext();

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error(err);
      setStatus("Microphone access was denied. Enable it to get a score.", true);
      return;
    }

    micSource = ac.createMediaStreamSource(micStream);
    const bufferSize = 2048;
    scriptNode = ac.createScriptProcessor(bufferSize, 1, 1);

    startScoringSession();

    scriptNode.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      const freq = detectPitch(input, ac.sampleRate);
      if (!freq) return;

      const midi = freqToMidi(freq);
      const time = audioEl.currentTime;
      const targetMidi = getTargetMidiAtTime(time);
      if (targetMidi == null) return;

      const diff = Math.abs(midi - targetMidi);
      const toleranceSemitones = 1.8;

      scoring.totalFrames += 1;
      if (diff <= toleranceSemitones) scoring.hitFrames += 1;
    };

    micSource.connect(scriptNode);
    scriptNode.connect(ac.destination);

    audioEl.currentTime = 0;
    audioEl.play().catch((err) => {
      console.error(err);
      setStatus("Could not start playback. Try clicking the audio controls first.", true);
    });

    startSingingBtn.disabled = true;
    stopSingingBtn.disabled = false;
  }

  function stopSinging() {
    if (scriptNode && micSource) {
      micSource.disconnect(scriptNode);
      scriptNode.disconnect();
    }
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
    }

    scriptNode = null;
    micSource = null;
    micStream = null;

    stopSingingBtn.disabled = true;
    startSingingBtn.disabled = false;

    if (scoring.totalFrames > 0) {
      const ratio = scoring.hitFrames / scoring.totalFrames;
      const percentage = Math.round(50 + ratio * 50);
      setScoreText(`Score: ${percentage} / 100`);
    } else {
      setScoreText("Score: – (not enough data)");
    }
  }

  function setup() {
    if (!fileInput) return;

    drawPitchTrack([]);

    fileInput.addEventListener("change", handleFileChange);
    analyzeBtn.addEventListener("click", () => {
      analyzeSong();
    });

    startSingingBtn.addEventListener("click", () => {
      startSinging();
    });

    stopSingingBtn.addEventListener("click", () => {
      stopSinging();
      audioEl.pause();
    });

    audioEl.addEventListener("ended", () => {
      if (micStream || scriptNode) {
        stopSinging();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setup);
  } else {
    setup();
  }
})();