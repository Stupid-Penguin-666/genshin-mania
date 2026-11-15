/* ==========================================================================
   AUDIO.JS
   Web Audio playback + the single timing clock the game and editor use.

   Why AudioContext instead of <audio>.currentTime?
   - <audio>.currentTime updates in ~250ms chunks and drifts under load.
   - AudioContext.currentTime is a sample-accurate clock driven by the
     audio hardware itself, which is what rhythm games need.

   Two clocks are exposed on purpose:
   - getPosition(): raw playback position of the song (what the editor
     draws its playhead from). Can be negative during a lead-in.
   - getSongTime(): getPosition() corrected by the player's calibration
     offset. This is what judgement and note scrolling compare against.

   Offset sign (fixed: it used to be added, contradicting its own docs):
     positive offset = the player tends to hit LATE, so song time is
     pushed back by that amount: songTime = position - offset.

   Exposes a single global: window.AudioManager
   ========================================================================== */

const AudioManager = (() => {
  let ctx = null;
  let sourceNode = null;
  let gainNode = null;
  let sfxGainNode = null;
  let audioBuffer = null;

  // Playback bookkeeping. While playing, position is derived from the
  // context clock; while paused it is the frozen `pausedPos`.
  let startCtxTime = 0;
  let startPos = 0;
  let rate = 1;
  let playing = false;
  let pausedPos = 0;

  let userOffsetSec = 0;
  let musicVolume = 80;   // remembered so volumes set before the context exists still apply
  let sfxVolume = 90;

  const STORAGE_KEY_OFFSET = "tant_audio_offset_ms";

  function ensureContext() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      gainNode = ctx.createGain();
      gainNode.connect(ctx.destination);
      sfxGainNode = ctx.createGain();
      sfxGainNode.connect(ctx.destination);
      applyVolumes();
    }
    // Browsers suspend AudioContext until a user gesture.
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  function applyVolumes() {
    if (gainNode) gainNode.gain.value = Math.max(0, Math.min(1, musicVolume / 100));
    if (sfxGainNode) sfxGainNode.gain.value = Math.max(0, Math.min(1, sfxVolume / 100));
  }

  // ------------------------------------------------------------------
  // Calibration offset
  // ------------------------------------------------------------------
  function loadStoredOffset() {
    let parsed = NaN;
    try { parsed = parseFloat(localStorage.getItem(STORAGE_KEY_OFFSET)); } catch { /* storage may be blocked */ }
    userOffsetSec = Number.isFinite(parsed) ? parsed / 1000 : 0;
    return userOffsetSec;
  }

  function saveOffset(offsetMs) {
    const clean = Math.max(-500, Math.min(500, Math.round(Number(offsetMs) || 0)));
    userOffsetSec = clean / 1000;
    try { localStorage.setItem(STORAGE_KEY_OFFSET, String(clean)); } catch { /* storage may be blocked */ }
    return clean;
  }

  function getOffsetMs() {
    return Math.round(userOffsetSec * 1000);
  }

  // ------------------------------------------------------------------
  // Loading
  // ------------------------------------------------------------------
  async function decode(arrayBuffer) {
    ensureContext();
    return ctx.decodeAudioData(arrayBuffer);
  }

  // decodeFile/decodeUrl only decode. They never touch the buffer that is
  // currently playing, so two loads racing each other cannot swap songs.
  async function decodeFile(file) {
    return decode(await file.arrayBuffer());
  }

  async function decodeUrl(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Không tải được file nhạc: ${url} (${res.status})`);
    return decode(await res.arrayBuffer());
  }

  // Select which decoded buffer play()/seek() will use.
  function useBuffer(buffer) {
    if (audioBuffer !== buffer) stop();
    audioBuffer = buffer;
  }

  async function loadFile(file) {
    useBuffer(await decodeFile(file));
    return audioBuffer;
  }

  function getDuration() {
    return audioBuffer ? audioBuffer.duration : 0;
  }

  // ------------------------------------------------------------------
  // Playback
  // ------------------------------------------------------------------
  // fromSeconds may be negative: that schedules the song to start after
  // a silent lead-in, so the first notes have time to fall into view.
  function play(fromSeconds = 0, playbackRate = 1) {
    if (!audioBuffer) return;
    ensureContext();
    stopSource();

    rate = playbackRate;
    sourceNode = ctx.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.playbackRate.value = rate;
    sourceNode.connect(gainNode);

    const now = ctx.currentTime;
    if (fromSeconds < 0) {
      sourceNode.start(now + (-fromSeconds / rate), 0);
    } else {
      sourceNode.start(0, Math.min(fromSeconds, Math.max(0, audioBuffer.duration - 0.001)));
    }

    startCtxTime = now;
    startPos = fromSeconds;
    pausedPos = fromSeconds;
    playing = true;
  }

  function stopSource() {
    if (!sourceNode) return;
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }

  function pause() {
    if (!playing) return;
    pausedPos = getPosition();
    stopSource();
    playing = false;
  }

  function resume() {
    if (playing) return;
    play(pausedPos, rate);
  }

  function stop() {
    stopSource();
    playing = false;
  }

  // Jump to a position, keeping the current play/pause state.
  function seek(positionSec, playbackRate = rate) {
    const clamped = Math.max(0, Math.min(getDuration(), positionSec));
    if (playing) play(clamped, playbackRate);
    else { pausedPos = clamped; rate = playbackRate; }
  }

  function setRate(playbackRate) {
    if (playing) play(getPosition(), playbackRate);
    else rate = playbackRate;
  }

  function getRate() { return rate; }

  function setVolume(percent0to100) {
    musicVolume = percent0to100;
    applyVolumes();
  }

  function setSfxVolume(percent0to100) {
    sfxVolume = percent0to100;
    applyVolumes();
  }

  // Two tiny synthesized sounds instead of external files: Perfect and
  // Great share a bright hit, Miss has a short low tone.
  function playSfx(quality) {
    if (!ctx || !sfxGainNode || sfxVolume <= 0) return;
    const isHit = quality === "perfect" || quality === "great";
    const now = ctx.currentTime;
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();

    oscillator.type = isHit ? "sine" : "triangle";
    oscillator.frequency.setValueAtTime(isHit ? 880 : 180, now);
    oscillator.frequency.linearRampToValueAtTime(isHit ? 1180 : 115, now + (isHit ? 0.07 : 0.10));
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(isHit ? 0.10 : 0.065, now + 0.005);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + (isHit ? 0.07 : 0.10));

    oscillator.connect(envelope);
    envelope.connect(sfxGainNode);
    oscillator.start(now);
    oscillator.stop(now + (isHit ? 0.09 : 0.12));
  }

  // ------------------------------------------------------------------
  // Clocks
  // ------------------------------------------------------------------
  function getPosition() {
    if (!playing || !ctx) return pausedPos;
    return startPos + (ctx.currentTime - startCtxTime) * rate;
  }

  function getSongTime() {
    return getPosition() - userOffsetSec;
  }

  function getContextTime() {
    ensureContext();
    return ctx.currentTime;
  }

  // ------------------------------------------------------------------
  // Metronome, used by the calibration screen. Beats are scheduled on
  // the audio clock a little ahead of time so they never jitter.
  // ------------------------------------------------------------------
  let metronome = null;

  function click(atTime, accent) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1500 : 1000;
    env.gain.setValueAtTime(0.0001, atTime);
    env.gain.exponentialRampToValueAtTime(0.22, atTime + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, atTime + 0.05);
    osc.connect(env);
    env.connect(sfxGainNode);
    osc.start(atTime);
    osc.stop(atTime + 0.06);
  }

  function startMetronome(bpm = 100) {
    ensureContext();
    stopMetronome();
    const interval = 60 / bpm;
    const beats = [];
    let next = ctx.currentTime + 0.4;
    let count = 0;
    const id = setInterval(() => {
      while (next < ctx.currentTime + 0.2) {
        click(next, count % 4 === 0);
        beats.push(next);
        if (beats.length > 64) beats.shift();
        next += interval;
        count++;
      }
    }, 25);
    metronome = { id, beats, interval };
  }

  function stopMetronome() {
    if (metronome) clearInterval(metronome.id);
    metronome = null;
  }

  // Signed seconds between `ctxTime` and the nearest scheduled beat
  // (positive = the tap came after the beat).
  function metronomeDelta(ctxTime) {
    if (!metronome || !metronome.beats.length) return null;
    let best = null;
    for (const b of metronome.beats) {
      const d = ctxTime - b;
      if (best === null || Math.abs(d) < Math.abs(best)) best = d;
    }
    return Math.abs(best) <= metronome.interval / 2 ? best : null;
  }

  return {
    ensureContext,
    decodeFile, decodeUrl, useBuffer, loadFile,
    getDuration,
    play, pause, resume, stop, seek, setRate, getRate,
    setVolume, setSfxVolume, playSfx,
    getPosition, getSongTime, getContextTime,
    isPlaying: () => playing,
    loadStoredOffset, saveOffset, getOffsetMs,
    startMetronome, stopMetronome, metronomeDelta,
  };
})();

window.AudioManager = AudioManager;
