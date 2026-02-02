// Simple in-browser karaoke helper
// - Upload an audio file
// - Analyse approximate melody using pitch detection
// - Show a 10s scrolling window of detected notes
// - Track microphone pitch and score generous matches

(function () {
  const fileInput = document.getElementById('audio-file');
  const demoBtn = document.getElementById('demo-btn');
  const analyzeBtn = document.getElementById('analyze-btn');
  const playBtn = document.getElementById('play-btn');
  const stopBtn = document.getElementById('stop-btn');
  const micBtn = document.getElementById('mic-btn');
  const micStatus = document.getElementById('mic-status');
  const analysisStatus = document.getElementById('analysis-status');
  const seekSlider = document.getElementById('seek-slider');
  const timeLabel = document.getElementById('time-label');

  const canvas = document.getElementById('pitch-canvas');
  const ctx = canvas.getContext('2d');

  const scoreMain = document.getElementById('score-main');
  const scoreDetail = document.getElementById('score-detail');

  const lyricsArtistInput = document.getElementById('lyrics-artist');
  const lyricsTitleInput = document.getElementById('lyrics-title');
  const lyricsFetchBtn = document.getElementById('lyrics-fetch-btn');
  const lyricsStatus = document.getElementById('lyrics-status');
  const lyricsText = document.getElementById('lyrics-text');

  let audioContext = null;
  let audioBuffer = null;
  let sourceNode = null;
  let startTime = 0;
  let pauseOffset = 0;
  let isPlaying = false;

  // Analysis: array of { time, midi }
  let melodyPoints = [];
  let melodyMap = new Map(); // time (0.1s precision) -> midi
  let songDuration = 0;

  // Microphone
  let micStream = null;
  let micAnalyser = null;
  let micData = null;
  let micEnabled = false;

  // Scoring (generous)
  let totalFrames = 0;
  let hitFrames = 0;

  const DEMO_SONG = {
    url: 'https://samplelib.com/lib/preview/mp3/sample-15s.mp3',
    label: 'SampleLib 15s demo (instrumental)'
  };

  function formatTime(sec) {
    if (!isFinite(sec)) return '00:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function ensureAudioContext() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioContext;
  }

  function resetScore() {
    totalFrames = 0;
    hitFrames = 0;
    updateScoreDisplay();
  }

  function updateScoreDisplay() {
    const pct = totalFrames > 0 ? Math.round((hitFrames / totalFrames) * 100) : 0;
    scoreMain.textContent = `Score: ${pct}%`;
    if (totalFrames === 0) {
      scoreDetail.textContent = 'Start singing to begin scoring.';
    } else if (pct >= 85) {
      scoreDetail.textContent = 'Amazing! You are right on the melody.';
    } else if (pct >= 60) {
      scoreDetail.textContent = 'Nice! You are following the tune pretty well.';
    } else {
      scoreDetail.textContent = 'Keep going, the scoring is generous – loosen up and match the contour.';
    }
  }

  // --- Pitch utilities ----------------------------------------------------

  function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function noteNameFromMidi(midi) {
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const n = Math.round(midi);
    const name = names[(n + 1200) % 12];
    const octave = Math.floor(n / 12) - 1;
    return `${name}${octave}`;
  }

  // Auto-correlation pitch detection (simple, not a full ML model)
  function detectPitch(timeDomainBuffer, sampleRate) {
    const buf = timeDomainBuffer;
    const size = buf.length;
    let rms = 0;
    for (let i = 0; i < size; i++) {
      const v = buf[i];
      rms += v * v;
    }
    rms = Math.sqrt(rms / size);
    if (rms < 0.01) return null; // too quiet

    let r1 = 0;
    let r2 = size - 1;
    const threshold = 0.2;
    for (let i = 0; i < size / 2; i++) {
      if (Math.abs(buf[i]) < threshold) {
        r1 = i;
        break;
      }
    }
    for (let i = 1; i < size / 2; i++) {
      if (Math.abs(buf[size - i]) < threshold) {
        r2 = size - i;
        break;
      }
    }

    const cropped = buf.slice(r1, r2);
    const csize = cropped.length;
    const correl = new Float32Array(csize);

    let maxCorr = 0;
    let maxIndex = -1;

    for (let lag = 1; lag < csize; lag++) {
      let sum = 0;
      for (let i = 0; i < csize - lag; i++) {
        sum += cropped[i] * cropped[i + lag];
      }
      correl[lag] = sum;
      if (sum > maxCorr) {
        maxCorr = sum;
        maxIndex = lag;
      }
    }

    if (maxIndex <= 0) return null;

    const d = correl[maxIndex + 1] - correl[maxIndex - 1];
    const shift = d / (2 * (2 * correl[maxIndex] - correl[maxIndex - 1] - correl[maxIndex + 1]));
    const lag = maxIndex + (isFinite(shift) ? shift : 0);
    const freq = sampleRate / lag;

    if (freq < 60 || freq > 1200 || !isFinite(freq)) return null;
    return freq;
  }

  // --- Melody analysis -----------------------------------------------------

  function analyzeBufferForMelody(buffer) {
    const ac = ensureAudioContext();
    const sampleRate = ac.sampleRate;
    const channelData = buffer.getChannelData(0);
    const stepSeconds = 0.1; // chart resolution
    const windowSize = 2048;
    const hopSize = Math.floor(stepSeconds * sampleRate);

    const points = [];
    const map = new Map();

    for (let offset = 0; offset + windowSize < channelData.length; offset += hopSize) {
      const slice = channelData.subarray(offset, offset + windowSize);
      const buf = new Float32Array(windowSize);
      buf.set(slice);
      const freq = detectPitch(buf, sampleRate);
      const time = offset / sampleRate;
      if (freq) {
        const midi = freqToMidi(freq);
        // Keep only reasonable singing range
        if (midi >= 40 && midi <= 85) {
          points.push({ time, midi });
          const key = Math.round(time * 10) / 10;
          map.set(key, midi);
        }
      }
    }

    return { points, map };
  }

  function getSongMidiAtTime(t) {
    if (!melodyMap || melodyMap.size === 0) return null;
    const key = Math.round(t * 10) / 10;
    if (melodyMap.has(key)) return melodyMap.get(key);
    // Look a bit around
    const delta = [0.1, 0.2, 0.3];
    for (const d of delta) {
      const k1 = Math.round((t + d) * 10) / 10;
      const k2 = Math.round((t - d) * 10) / 10;
      if (melodyMap.has(k1)) return melodyMap.get(k1);
      if (melodyMap.has(k2)) return melodyMap.get(k2);
    }
    return null;
  }

  // --- Playback ------------------------------------------------------------

  function createSource() {
    if (!audioBuffer) return null;
    const ac = ensureAudioContext();
    const src = ac.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(ac.destination);
    src.onended = () => {
      isPlaying = false;
      playBtn.textContent = 'Play';
      pauseOffset = 0;
    };
    return src;
  }

  function getCurrentSongTime() {
    if (!audioContext || !audioBuffer) return 0;
    if (!isPlaying) return pauseOffset;
    return pauseOffset + (audioContext.currentTime - startTime);
  }

  function startPlayback() {
    if (!audioBuffer) return;
    const ac = ensureAudioContext();
    if (ac.state === 'suspended') {
      ac.resume();
    }
    const currentTime = getCurrentSongTime();
    sourceNode = createSource();
    if (!sourceNode) return;
    startTime = ac.currentTime;
    isPlaying = true;
    sourceNode.start(0, currentTime);
    playBtn.textContent = 'Pause';
    stopBtn.disabled = false;
    animate();
  }

  function pausePlayback() {
    if (!isPlaying) return;
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) {}
      sourceNode.disconnect();
      sourceNode = null;
    }
    pauseOffset = getCurrentSongTime();
    isPlaying = false;
    playBtn.textContent = 'Play';
  }

  function stopPlayback() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) {}
      sourceNode.disconnect();
      sourceNode = null;
    }
    isPlaying = false;
    pauseOffset = 0;
    playBtn.textContent = 'Play';
    updateTimeUI();
  }

  function updateTimeUI() {
    const t = getCurrentSongTime();
    if (songDuration > 0) {
      seekSlider.value = String(t);
      timeLabel.textContent = `${formatTime(t)} / ${formatTime(songDuration)}`;
    }
  }

  // --- Drawing -------------------------------------------------------------

  function clearCanvas() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  function drawChartFrame() {
    clearCanvas();
    const now = getCurrentSongTime();
    const windowSpan = 10; // seconds
    const start = now;
    const end = now + windowSpan;

    const padLeft = 40;
    const padRight = 10;
    const padTop = 10;
    const padBottom = 25;

    const width = canvas.width - padLeft - padRight;
    const height = canvas.height - padTop - padBottom;

    const minMidi = 40;
    const maxMidi = 85;

    // Background
    ctx.fillStyle = '#f9fafb';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Axes
    ctx.strokeStyle = '#d1d5db';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop);
    ctx.lineTo(padLeft, padTop + height);
    ctx.lineTo(padLeft + width, padTop + height);
    ctx.stroke();

    // Horizontal guide lines & labels
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#6b7280';
    const steps = [48, 52, 55, 60, 64, 67, 72, 76, 80];
    steps.forEach((midi) => {
      const y = padTop + height - ((midi - minMidi) / (maxMidi - minMidi)) * height;
      ctx.strokeStyle = 'rgba(148,163,184,0.5)';
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + width, y);
      ctx.stroke();
      ctx.fillStyle = '#4b5563';
      ctx.fillText(noteNameFromMidi(midi), 4, y + 3);
    });

    // Song melody segments
    ctx.strokeStyle = '#1d4ed8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < melodyPoints.length; i++) {
      const p = melodyPoints[i];
      if (p.time < start - 0.1 || p.time > end + 0.1) continue;
      const x = padLeft + ((p.time - start) / windowSpan) * width;
      const y = padTop + height - ((p.midi - minMidi) / (maxMidi - minMidi)) * height;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (started) ctx.stroke();

    // Current time marker at 1 second from left for a sense of motion
    const markerX = padLeft + (1 / windowSpan) * width;
    ctx.strokeStyle = 'rgba(15,118,110,0.7)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(markerX, padTop);
    ctx.lineTo(markerX, padTop + height);
    ctx.stroke();

    // Microphone note icon
    if (micEnabled && micAnalyser && micData) {
      micAnalyser.getFloatTimeDomainData(micData);
      const ac = ensureAudioContext();
      const freq = detectPitch(micData, ac.sampleRate);
      if (freq) {
        const midi = freqToMidi(freq);
        const y = padTop + height - ((midi - minMidi) / (maxMidi - minMidi)) * height;
        ctx.fillStyle = '#10b981';
        ctx.font = '16px system-ui, sans-serif';
        ctx.fillText('♪', markerX + 4, y + 4);

        // Generous scoring vs song melody at current time
        const songMidi = getSongMidiAtTime(now + 1); // match where marker is
        if (songMidi) {
          const diffSemitones = Math.abs(songMidi - midi);
          const withinLoose = diffSemitones <= 1.8; // very generous tolerance
          totalFrames += 1;
          if (withinLoose) hitFrames += 1;
          updateScoreDisplay();
        }
      }
    }
  }

  function animate() {
    updateTimeUI();
    drawChartFrame();
    if (isPlaying || micEnabled) {
      requestAnimationFrame(animate);
    }
  }

  // --- Microphone ----------------------------------------------------------

  async function toggleMic() {
    if (micEnabled) {
      micEnabled = false;
      micStatus.textContent = 'Mic off';
      micStatus.style.color = '';
      micBtn.textContent = 'Enable microphone';
      if (micStream) {
        micStream.getTracks().forEach((t) => t.stop());
      }
      micStream = null;
      micAnalyser = null;
      micData = null;
      return;
    }

    try {
      const ac = ensureAudioContext();
      if (ac.state === 'suspended') await ac.resume();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream = stream;
      const src = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 2048;
      const data = new Float32Array(analyser.fftSize);
      src.connect(analyser);
      micAnalyser = analyser;
      micData = data;
      micEnabled = true;
      micStatus.textContent = 'Mic on';
      micStatus.style.color = '#16a34a';
      micBtn.textContent = 'Disable microphone';
      animate();
    } catch (err) {
      console.error('Mic error', err);
      micStatus.textContent = 'Mic permission denied or unavailable.';
    }
  }

  // --- Lyrics --------------------------------------------------------------

  async function fetchLyrics() {
    const artist = lyricsArtistInput.value.trim();
    const title = lyricsTitleInput.value.trim();
    if (!artist || !title) {
      lyricsStatus.textContent = 'Enter both artist and song title first.';
      return;
    }

    lyricsStatus.textContent = 'Looking up lyrics…';

    try {
      // Simple public API; may fail due to CORS depending on environment.
      const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error('Lyrics not found');
      }
      const data = await res.json();
      if (data && data.lyrics) {
        lyricsText.value = data.lyrics;
        lyricsStatus.textContent = 'Lyrics loaded – feel free to edit them.';
      } else {
        lyricsStatus.textContent = 'No lyrics found. You can paste them manually.';
      }
    } catch (e) {
      console.warn(e);
      lyricsStatus.textContent = 'Could not fetch lyrics (maybe blocked). Paste them manually instead.';
    }
  }

  // --- Event wiring --------------------------------------------------------

  async function loadFromArrayBuffer(arrayBuffer, labelForStatus) {
    try {
      const ac = ensureAudioContext();
      audioBuffer = await ac.decodeAudioData(arrayBuffer);
      songDuration = audioBuffer.duration;
      analyzeBtn.disabled = false;
      playBtn.disabled = true;
      stopBtn.disabled = true;
      micBtn.disabled = false;
      seekSlider.disabled = false;
      seekSlider.min = '0';
      seekSlider.max = String(songDuration);
      seekSlider.value = '0';
      timeLabel.textContent = `00:00 / ${formatTime(songDuration)}`;
      analysisStatus.textContent = `${labelForStatus} Click "Analyse track" to build the melody chart.`;
      melodyPoints = [];
      melodyMap = new Map();
      resetScore();
    } catch (err) {
      console.error(err);
      analysisStatus.textContent = 'Could not decode audio data.';
    }
  }

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    analysisStatus.textContent = 'Loading file…';

    try {
      const arrayBuffer = await file.arrayBuffer();
      await loadFromArrayBuffer(arrayBuffer, 'File loaded.');
    } catch (err) {
      console.error(err);
      analysisStatus.textContent = 'Could not read audio file.';
    }
  });

  analyzeBtn.addEventListener('click', () => {
    if (!audioBuffer) return;
    analysisStatus.textContent = 'Analysing melody in your browser… (this may take a few seconds)';

    // Run in a small timeout to keep UI responsive
    setTimeout(() => {
      const result = analyzeBufferForMelody(audioBuffer);
      melodyPoints = result.points;
      melodyMap = result.map;
      if (melodyPoints.length === 0) {
        analysisStatus.textContent = 'Could not detect a clear melody. You can still sing along with the track.';
      } else {
        analysisStatus.textContent = `Detected approximate melody at ${melodyPoints.length} points. Ready to play!`;
      }
      playBtn.disabled = false;
      drawChartFrame();
    }, 30);
  });

  playBtn.addEventListener('click', () => {
    if (!audioBuffer) return;
    if (!isPlaying) {
      startPlayback();
    } else {
      pausePlayback();
    }
  });

  stopBtn.addEventListener('click', () => {
    stopPlayback();
  });

  micBtn.addEventListener('click', () => {
    toggleMic();
  });

  seekSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    if (!isFinite(val)) return;
    pauseOffset = val;
    if (isPlaying) {
      // Restart playback from new position
      if (sourceNode) {
        try { sourceNode.stop(); } catch (e) {}
        sourceNode.disconnect();
        sourceNode = null;
      }
      startPlayback();
    } else {
      updateTimeUI();
      drawChartFrame();
    }
  });

  demoBtn.addEventListener('click', async () => {
    analysisStatus.textContent = `Loading demo song: ${DEMO_SONG.label}…`;
    try {
      const res = await fetch(DEMO_SONG.url);
      if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      }
      const arrayBuffer = await res.arrayBuffer();
      await loadFromArrayBuffer(arrayBuffer, `Demo song loaded (${DEMO_SONG.label}).`);
    } catch (err) {
      console.error(err);
      analysisStatus.textContent = 'Could not load demo song (maybe blocked). Try uploading a local file instead.';
    }
  });

  lyricsFetchBtn.addEventListener('click', () => {
    fetchLyrics();
  });

  // Initial paint
  drawChartFrame();
})();