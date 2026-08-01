/* ==========================================================================
   AUDIO.JS
   Everything related to Web Audio API playback + precise timing.

   Why AudioContext instead of <audio>.currentTime?
   - <audio>.currentTime updates in ~250ms chunks and drifts under load.
   - AudioContext.currentTime is a sample-accurate clock driven by the
     audio hardware itself, which is what rhythm games need to compare
     note timestamps against.

   Exposes a single global: window.AudioManager
   ========================================================================== */

const AudioManager = (() => {

  // ------------------------------------------------------------------
  // Internal state
  // ------------------------------------------------------------------
  let ctx = null;                 // AudioContext instance
  let sourceNode = null;          // current AudioBufferSourceNode
  let gainNode = null;            // master music gain (volume control)
  let audioBuffer = null;         // decoded song buffer
  let startCtxTime = 0;           // ctx.currentTime at the moment playback started
  let startOffset = 0;            // seconds into the buffer playback started at (for resume)
  let isPlaying = false;

  // User-calibrated latency compensation, in seconds.
  // Positive offset = notes should be judged as if they arrived "later"
  // (i.e. subtract from song time before comparing to note.time).
  let userOffsetSec = 0;

  const STORAGE_KEY_OFFSET = "tant_audio_offset_ms";

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------
  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
    }
    // Browsers suspend AudioContext until a user gesture — call this
    // from a click handler (e.g. "Start Song" button) to unlock it.
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function loadStoredOffset() {
    const raw = localStorage.getItem(STORAGE_KEY_OFFSET);
    userOffsetSec = raw ? parseFloat(raw) / 1000 : 0;
    return userOffsetSec;
  }

  function saveOffset(offsetMs) {
    userOffsetSec = offsetMs / 1000;
    localStorage.setItem(STORAGE_KEY_OFFSET, String(offsetMs));
  }

  function getOffsetMs() {
    return userOffsetSec * 1000;
  }

  // ------------------------------------------------------------------
  // Loading a song file
  // User picks an .mp3 from disk. We NEVER upload it anywhere — just
  // decode it client-side via the File/Blob → ArrayBuffer → AudioBuffer
  // pipeline. URL.createObjectURL is used by main.js only to preview
  // the raw file (e.g. attaching to an <audio> tag for song-select
  // scrubbing); actual gameplay playback goes through this decoded
  // AudioBuffer for sample-accurate timing.
  // ------------------------------------------------------------------
  async function loadFile(file) {
    ensureContext();
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  // Same decode pipeline as loadFile(), but for built-in catalog songs
  // shipped alongside the site (e.g. beatmaps/../audio/demo.wav) rather
  // than a user-picked File. Nothing is uploaded anywhere either way —
  // this is a same-origin fetch of a static asset.
  async function loadFromUrl(url) {
    ensureContext();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Không tải được file nhạc: ${url} (${res.status})`);
    const arrayBuffer = await res.arrayBuffer();
    audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    return audioBuffer;
  }

  function getDuration() {
    return audioBuffer ? audioBuffer.duration : 0;
  }

  // ------------------------------------------------------------------
  // Playback control
  // ------------------------------------------------------------------
  function play(fromSeconds = 0) {
    if (!audioBuffer) return;
    ensureContext();
    stop(); // clean up any previous source

    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(gainNode);
    sourceNode.start(0, fromSeconds);

    startCtxTime = ctx.currentTime;
    startOffset = fromSeconds;
    isPlaying = true;
  }

  function pause() {
    if (!isPlaying) return;
    // AudioBufferSourceNode has no native pause — capture position,
    // stop the node, and resume() will re-start from that position.
    startOffset = getSongTime();
    sourceNode?.stop();
    isPlaying = false;
  }

  function resume() {
    if (isPlaying) return;
    play(startOffset);
  }

  function stop() {
    if (sourceNode) {
      try { sourceNode.stop(); } catch (e) { /* already stopped */ }
      sourceNode.disconnect();
      sourceNode = null;
    }
    isPlaying = false;
  }

  function setVolume(percent0to100) {
    if (!gainNode) return;
    gainNode.gain.value = Math.max(0, Math.min(1, percent0to100 / 100));
  }

  // ------------------------------------------------------------------
  // THE core timing function gameplay code should call every frame.
  // Returns current playback position in seconds, corrected by the
  // user's calibrated offset — this is the single source of truth
  // that js/engine.js compares note.time against.
  // ------------------------------------------------------------------
  function getSongTime() {
    if (!isPlaying) return startOffset;
    const elapsed = ctx.currentTime - startCtxTime;
    return startOffset + elapsed + userOffsetSec;
  }

  // Raw context clock, uncorrected — used internally by the
  // calibration screen, which measures offset itself rather than
  // applying it.
  function getRawContextTime() {
    ensureContext();
    return ctx.currentTime;
  }

  // ==================================================================
  // CALIBRATION MODE
  // Plays a short click sample on a fixed interval (metronome). The
  // caller (main.js) records ctx.currentTime when the click fires and
  // when the player presses SPACE, then feeds the deltas back here
  // via recordTap() to compute a suggested offset.
  // ==================================================================
  let calibIntervalId = null;
  let calibBeatTimes = [];   // ctx.currentTime of each click
  let calibTapDeltas = [];   // (tapTime - nearestBeatTime) per tap, ms

  function startCalibration(bpm = 100, onBeat = () => {}) {
    ensureContext();
    stopCalibration();
    calibBeatTimes = [];
    calibTapDeltas = [];
    const intervalSec = 60 / bpm;

    const clickBuffer = generateClickBuffer();

    calibIntervalId = setInterval(() => {
      const beatTime = ctx.currentTime;
      calibBeatTimes.push(beatTime);
      playClick(clickBuffer);
      onBeat(beatTime);
    }, intervalSec * 1000);
  }

  function stopCalibration() {
    if (calibIntervalId) clearInterval(calibIntervalId);
    calibIntervalId = null;
  }

  // Call this from the SPACE keydown handler during calibration.
  function recordTap() {
    if (!calibBeatTimes.length) return null;
    const tapTime = ctx.currentTime;
    const nearestBeat = calibBeatTimes.reduce((closest, t) =>
      Math.abs(t - tapTime) < Math.abs(closest - tapTime) ? t : closest
    );
    const deltaMs = (tapTime - nearestBeat) * 1000;
    calibTapDeltas.push(deltaMs);
    return deltaMs;
  }

  function getSuggestedOffsetMs() {
    if (!calibTapDeltas.length) return 0;
    const avg = calibTapDeltas.reduce((a, b) => a + b, 0) / calibTapDeltas.length;
    return Math.round(avg);
  }

  function getCalibTapCount() {
    return calibTapDeltas.length;
  }

  // Tiny synthesized "tick" so calibration doesn't need an asset file.
  function generateClickBuffer() {
    const sr = ctx.sampleRate;
    const durationSec = 0.05;
    const buf = ctx.createBuffer(1, sr * durationSec, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // short decaying sine burst
      const t = i / sr;
      data[i] = Math.sin(2 * Math.PI * 1000 * t) * Math.exp(-t * 60);
    }
    return buf;
  }

  function playClick(buffer) {
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(gainNode);
    node.start();
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  return {
    ensureContext,
    loadFile,
    loadFromUrl,
    getDuration,
    play,
    pause,
    resume,
    stop,
    setVolume,
    getSongTime,
    getRawContextTime,
    isPlaying: () => isPlaying,

    loadStoredOffset,
    saveOffset,
    getOffsetMs,

    startCalibration,
    stopCalibration,
    recordTap,
    getSuggestedOffsetMs,
    getCalibTapCount,
  };
})();

window.AudioManager = AudioManager;
