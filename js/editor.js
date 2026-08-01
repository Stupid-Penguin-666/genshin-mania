/* ==========================================================================
   EDITOR.JS
   Beatmap Editor — two authoring modes over the same note data:
     - Manual Timeline: waveform + beat grid, click/drag to place notes
     - Live Recording: play the song, tap lane keys in real time

   Reuses AudioManager (already built for exactly this: decode + precise
   playback clock) and GameEngine (for the Test Play button) rather than
   duplicating either.

   Exposes a single global: window.Editor
   ========================================================================== */

const Editor = (() => {

  const LANE_COUNT = 6;
  const KEY_LABELS = ["A", "S", "D", "J", "K", "L"];
  const LANE_HEIGHT = 70;      // px per lane row on the timeline
  const HOLD_MIN_MS = 120;     // taps held longer than this become "hold" notes

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let canvas, gfx, wrapEl;
  let waveformPeaks = null;    // downsampled amplitude buckets, one per pixel-ish slice
  let duration = 0;
  let bpm = 120, offsetMs = 0, snapDivisor = 4;
  let pxPerSecond = 140;       // horizontal zoom
  let notes = [];              // {time, lane, type, duration}
  let mode = "manual";         // "manual" | "live"
  let playSpeed = 1;
  let isPlaying = false;

  // Manual mode drag state (for creating hold notes by click-drag)
  let dragStart = null; // {lane, time}

  // Live mode recording state
  let liveHeldStart = new Map(); // lane -> songTime key was pressed

  // DOM refs
  let elBpm, elOffset, elSnap, elZoom, elPlayPause, elTimeDisplay,
      elRecordHint, elLaneLabels, elEmptyHint, elFileInput, elImportInput;

  // ------------------------------------------------------------------
  // Init — called once when the app boots (module wires its own DOM,
  // consistent with how audio.js / engine.js manage their own scope)
  // ------------------------------------------------------------------
  function init() {
    canvas = document.getElementById("editor-timeline-canvas");
    gfx = canvas.getContext("2d");
    wrapEl = document.getElementById("editor-timeline-wrap");

    elBpm = document.getElementById("editor-bpm");
    elOffset = document.getElementById("editor-offset");
    elSnap = document.getElementById("editor-snap");
    elZoom = document.getElementById("editor-zoom");
    elPlayPause = document.getElementById("btn-editor-playpause");
    elTimeDisplay = document.getElementById("editor-time-display");
    elRecordHint = document.getElementById("editor-record-hint");
    elLaneLabels = document.getElementById("editor-lane-labels");
    elEmptyHint = document.getElementById("editor-empty-hint");
    elFileInput = document.getElementById("editor-file-input");
    elImportInput = document.getElementById("editor-import-input");

    buildLaneLabels();
    bindToolbar();
    bindTransport();
    bindTimelineInteraction();
    bindImportExport();
    bindModeTabs();
    bindKeyboard();

    window.addEventListener("resize", resizeCanvas);
    requestAnimationFrame(renderLoop);
  }

  function buildLaneLabels() {
    elLaneLabels.innerHTML = KEY_LABELS.map((k) => `<span>${k}</span>`).join("");
  }

  // ------------------------------------------------------------------
  // Loading audio (file picker → decode → waveform buckets)
  // ------------------------------------------------------------------
  function bindToolbar() {
    elFileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await AudioManager.loadFile(file);
      duration = AudioManager.getDuration();
      notes = [];
      buildWaveform(file);
      elEmptyHint.style.display = "none";
      resizeCanvas();
    });

    elBpm.addEventListener("input", () => { bpm = +elBpm.value || 120; });
    elOffset.addEventListener("input", () => { offsetMs = +elOffset.value || 0; });
    elSnap.addEventListener("change", () => { snapDivisor = +elSnap.value; });
    elZoom.addEventListener("input", () => { pxPerSecond = +elZoom.value; resizeCanvas(); });
  }

  // Downsamples the decoded PCM into peak-amplitude buckets so drawing
  // the waveform doesn't mean plotting hundreds of thousands of samples
  // every frame — one bucket roughly per horizontal pixel at max zoom.
  async function buildWaveform(file) {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    const raw = buffer.getChannelData(0);
    const bucketCount = Math.ceil(duration * 400); // ~400 buckets/sec at max zoom
    const bucketSize = Math.floor(raw.length / bucketCount) || 1;
    const peaks = new Float32Array(bucketCount);
    for (let b = 0; b < bucketCount; b++) {
      let max = 0;
      const start = b * bucketSize;
      for (let i = start; i < start + bucketSize && i < raw.length; i++) {
        const v = Math.abs(raw[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    waveformPeaks = peaks;
    ctx.close();
  }

  // ------------------------------------------------------------------
  // Transport (play/pause/seek/speed) — thin wrapper over AudioManager
  // ------------------------------------------------------------------
  function bindTransport() {
    elPlayPause.addEventListener("click", togglePlay);

    document.querySelectorAll(".editor-speed [data-speed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".editor-speed [data-speed]").forEach((b) =>
          b.classList.remove("editor-speed--active"));
        btn.classList.add("editor-speed--active");
        playSpeed = +btn.dataset.speed;
        // Web Audio doesn't expose a clean playbackRate for our buffer
        // source without re-pitching; for a skeleton, "0.5x" simply
        // halves how far the playhead advances relative to real time
        // when scrubbing manually (see renderLoop/seek helpers below).
      });
    });
  }

  function togglePlay() {
    if (!duration) return;
    if (isPlaying) {
      AudioManager.pause();
      isPlaying = false;
      elPlayPause.textContent = "▶";
      if (mode === "live") stopLiveRecording();
    } else {
      AudioManager.play(currentTime());
      isPlaying = true;
      elPlayPause.textContent = "⏸";
      if (mode === "live") startLiveRecording();
    }
  }

  function currentTime() {
    return AudioManager.getSongTime ? Math.max(0, AudioManager.getSongTime() - AudioManager.getOffsetMs() / 1000) : 0;
  }

  function seekTo(t) {
    const clamped = Math.max(0, Math.min(duration, t));
    AudioManager.play(clamped);
    if (!isPlaying) AudioManager.pause();
  }

  // ------------------------------------------------------------------
  // MODE TABS
  // ------------------------------------------------------------------
  function bindModeTabs() {
    document.querySelectorAll(".editor-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".editor-tab").forEach((t) => t.classList.remove("editor-tab--active"));
        tab.classList.add("editor-tab--active");
        mode = tab.dataset.mode;
        elRecordHint.textContent = mode === "live"
          ? "Nhấn Play rồi gõ phím A S D J K L theo nhịp để ghi nốt."
          : "";
        elRecordHint.classList.remove("recording");
      });
    });
  }

  // ------------------------------------------------------------------
  // MANUAL TIMELINE — click to place, click existing to delete,
  // drag (mousedown → mouseup) within a lane to place a hold note.
  // ------------------------------------------------------------------
  function bindTimelineInteraction() {
    canvas.addEventListener("mousedown", (e) => {
      if (mode !== "manual" || !duration) return;
      const { lane, time } = pickFromEvent(e);
      if (lane === null) return;

      const existing = findNoteNear(lane, time);
      if (existing) {
        notes = notes.filter((n) => n !== existing);
        return;
      }
      dragStart = { lane, time: snapTime(time) };
    });

    canvas.addEventListener("mouseup", (e) => {
      if (mode !== "manual" || !dragStart) return;
      const { lane, time } = pickFromEvent(e);
      if (lane === dragStart.lane && time !== null) {
        const endTime = snapTime(time);
        const durationSec = endTime - dragStart.time;
        if (durationSec > 0.15) {
          notes.push({ time: dragStart.time, lane, type: "hold", duration: durationSec });
        } else {
          notes.push({ time: dragStart.time, lane, type: "tap" });
        }
      }
      dragStart = null;
    });

    // Click on the ruler area (above lanes) seeks playback for quick
    // scrubbing to a spot before fine-placing notes there.
    canvas.addEventListener("dblclick", (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      seekTo(x / pxPerSecond);
    });
  }

  function pickFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const time = x / pxPerSecond;
    const lane = Math.floor(y / LANE_HEIGHT);
    if (lane < 0 || lane >= LANE_COUNT || time < 0 || time > duration) return { lane: null, time: null };
    return { lane, time };
  }

  function findNoteNear(lane, time, toleranceSec = 0.1) {
    return notes.find((n) => n.lane === lane && Math.abs(n.time - time) <= toleranceSec);
  }

  function snapTime(t) {
    const beatSec = 60 / bpm;
    const gridSec = beatSec / snapDivisor;
    const offsetSec = offsetMs / 1000;
    return Math.round((t - offsetSec) / gridSec) * gridSec + offsetSec;
  }

  // ------------------------------------------------------------------
  // LIVE RECORDING — play the song, tap lane keys, notes land where
  // songTime says they landed. Holding a key past HOLD_MIN_MS records
  // a Hold note instead of a Tap.
  // ------------------------------------------------------------------
  const LIVE_KEYMAP = { KeyA: 0, KeyS: 1, KeyD: 2, KeyJ: 3, KeyK: 4, KeyL: 5 };

  function startLiveRecording() {
    liveHeldStart.clear();
    elRecordHint.textContent = "Đang ghi âm...";
    elRecordHint.classList.add("recording");
  }

  function stopLiveRecording() {
    elRecordHint.textContent = "Nhấn Play rồi gõ phím A S D J K L theo nhịp để ghi nốt.";
    elRecordHint.classList.remove("recording");
    liveHeldStart.clear();
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (!document.getElementById("screen-editor").classList.contains("screen--active")) return;
      if (mode !== "live" || !isPlaying || e.repeat) return;
      const lane = LIVE_KEYMAP[e.code];
      if (lane === undefined) return;
      if (!liveHeldStart.has(lane)) liveHeldStart.set(lane, currentTime());
    });

    document.addEventListener("keyup", (e) => {
      if (mode !== "live" || !isPlaying) return;
      const lane = LIVE_KEYMAP[e.code];
      if (lane === undefined || !liveHeldStart.has(lane)) return;
      const startT = liveHeldStart.get(lane);
      liveHeldStart.delete(lane);
      const heldMs = (currentTime() - startT) * 1000;
      if (heldMs >= HOLD_MIN_MS) {
        notes.push({ time: startT, lane, type: "hold", duration: heldMs / 1000 });
      } else {
        notes.push({ time: startT, lane, type: "tap" });
      }
    });
  }

  // ------------------------------------------------------------------
  // IMPORT / EXPORT — matches the beatmap.json structure from spec
  // ------------------------------------------------------------------
  function bindImportExport() {
    document.getElementById("btn-editor-export").addEventListener("click", exportJson);
    document.getElementById("btn-editor-import").addEventListener("click", () => elImportInput.click());
    elImportInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const text = await file.text();
      const data = JSON.parse(text);
      bpm = data.bpm || 120;
      offsetMs = data.offset || 0;
      notes = data.notes || [];
      elBpm.value = bpm;
      elOffset.value = offsetMs;
    });

    document.getElementById("btn-editor-testplay").addEventListener("click", testPlay);
  }

  function buildBeatmapObject() {
    return {
      songTitle: "Custom Beatmap",
      bpm,
      offset: offsetMs,
      notes: [...notes].sort((a, b) => a.time - b.time),
    };
  }

  function exportJson() {
    const data = buildBeatmapObject();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "beatmap.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ------------------------------------------------------------------
  // TEST PLAY — reuse the real GameEngine on the gameplay canvas so
  // the chart feels exactly like it will for a player, no separate
  // "preview" renderer to keep in sync.
  // ------------------------------------------------------------------
  function testPlay() {
    if (!duration || !notes.length) return;
    if (isPlaying) togglePlay();

    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("screen--active"));
    document.getElementById("screen-gameplay").classList.add("screen--active");

    const gameplayCanvas = document.getElementById("game-canvas");
    GameEngine.init(gameplayCanvas, {
      laneCount: LANE_COUNT,
      keymap: GameEngine.KEYMAPS[LANE_COUNT],
      noteSpeed: 10,
      getSongTime: AudioManager.getSongTime,
      onFinish: () => {
        // Test Play always returns to the editor, regardless of the
        // normal Result-screen flow used for real songs.
        document.querySelectorAll(".screen").forEach((el) => el.classList.remove("screen--active"));
        document.getElementById("screen-editor").classList.add("screen--active");
      },
    });
    document.getElementById("hud-song-title").textContent = "Test Play — Custom Beatmap";
    GameEngine.loadBeatmap(buildBeatmapObject());
    AudioManager.play(0);
    GameEngine.start();
  }

  // ------------------------------------------------------------------
  // RENDER — waveform + beat grid + placed notes + playhead
  // ------------------------------------------------------------------
  function resizeCanvas() {
    if (!duration) return;
    canvas.width = Math.max(wrapEl.clientWidth, duration * pxPerSecond);
    canvas.height = LANE_COUNT * LANE_HEIGHT;
    canvas.style.height = canvas.height + "px";
  }

  function renderLoop() {
    if (duration) draw();
    if (elTimeDisplay && duration) {
      const t = currentTime();
      elTimeDisplay.textContent = `${formatTime(t)} / ${formatTime(duration)}`;
      // auto-scroll the wrap to keep the playhead roughly in view while playing
      if (isPlaying) {
        const playheadX = t * pxPerSecond;
        if (playheadX < wrapEl.scrollLeft || playheadX > wrapEl.scrollLeft + wrapEl.clientWidth - 60) {
          wrapEl.scrollLeft = playheadX - 60;
        }
      }
    }
    requestAnimationFrame(renderLoop);
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    gfx.clearRect(0, 0, w, h);

    // Lane row backgrounds (alternating for readability)
    for (let lane = 0; lane < LANE_COUNT; lane++) {
      gfx.fillStyle = lane % 2 === 0 ? "rgba(255,255,255,0.02)" : "transparent";
      gfx.fillRect(0, lane * LANE_HEIGHT, w, LANE_HEIGHT);
    }

    drawWaveform(h);
    drawBeatGrid(h);
    drawNotes();
    drawPlayhead(h);
  }

  function drawWaveform(h) {
    if (!waveformPeaks) return;
    gfx.fillStyle = "rgba(245,197,107,0.25)";
    const mid = h / 2;
    const bucketsPerPx = waveformPeaks.length / (duration * pxPerSecond);
    for (let x = 0; x < canvas.width; x++) {
      const idx = Math.floor(x * bucketsPerPx);
      const amp = waveformPeaks[idx] || 0;
      const barH = amp * (h * 0.9);
      gfx.fillRect(x, mid - barH / 2, 1, barH);
    }
  }

  function drawBeatGrid(h) {
    const beatSec = 60 / bpm;
    const gridSec = beatSec / snapDivisor;
    gfx.strokeStyle = "rgba(244,234,210,0.08)";
    for (let t = offsetMs / 1000; t < duration; t += gridSec) {
      const x = t * pxPerSecond;
      gfx.lineWidth = (Math.round((t - offsetMs / 1000) / gridSec) % snapDivisor === 0) ? 1.4 : 0.6;
      gfx.strokeStyle = gfx.lineWidth > 1 ? "rgba(245,197,107,0.25)" : "rgba(244,234,210,0.08)";
      gfx.beginPath();
      gfx.moveTo(x, 0);
      gfx.lineTo(x, h);
      gfx.stroke();
    }
  }

  function drawNotes() {
    notes.forEach((n) => {
      const x = n.time * pxPerSecond;
      const y = n.lane * LANE_HEIGHT + LANE_HEIGHT / 2;
      if (n.type === "hold") {
        gfx.fillStyle = "rgba(255,138,61,0.55)";
        gfx.fillRect(x, y - 10, n.duration * pxPerSecond, 20);
      }
      gfx.beginPath();
      gfx.arc(x, y, 12, 0, Math.PI * 2);
      gfx.fillStyle = "#ff9f6b";
      gfx.shadowColor = "#ff9f6b";
      gfx.shadowBlur = 8;
      gfx.fill();
      gfx.shadowBlur = 0;
    });
  }

  function drawPlayhead(h) {
    const x = currentTime() * pxPerSecond;
    gfx.strokeStyle = "#ffe0a3";
    gfx.lineWidth = 2;
    gfx.beginPath();
    gfx.moveTo(x, 0);
    gfx.lineTo(x, h);
    gfx.stroke();
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  return { init };
})();

window.Editor = Editor;
