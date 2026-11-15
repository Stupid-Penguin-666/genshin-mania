/* ==========================================================================
   EDITOR.JS
   Beatmap editor with two authoring modes over the same note data:
     - Manual Timeline: waveform + beat grid, click/drag to place notes
     - Live Recording: play the song and tap the lane keys in real time

   The timeline canvas is only as wide as the visible area and is redrawn
   with the scroll offset (a spacer element provides the scrollbar), so a
   long song at high zoom never hits the browser's canvas size limit.

   Exposes a single global: window.Editor
   ========================================================================== */

const Editor = (() => {

  let LANE_COUNT = 6;
  let KEY_LABELS = [];
  let laneH = 60;                  // px per lane row, derived from available height
  const LANE_H_MIN = 34, LANE_H_MAX = 70;
  const HOLD_MIN_S = 0.12;         // a recorded key held longer than this becomes a hold note
  const MIN_DRAG_HOLD_S = 0.15;

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let canvas, gfx, wrapEl, stageEl, spacerEl;
  let dpr = 1;
  let buffer = null;               // decoded audio for the song being edited
  let sourceFile = null;           // the File it came from, needed to save into the library
  let waveformPeaks = null;
  let duration = 0;
  let bpm = 120, offsetMs = 0, snapDivisor = 4;
  let pxPerSecond = 140;
  let notes = [];
  let mode = "manual";
  let playSpeed = 1;
  let isPlaying = false;
  let editorPos = 0;               // playhead while not playing
  let audioLoadedOnce = false;

  let dragStart = null;            // { lane, time } while creating a hold
  let dragNow = null;              // snapped time under the pointer while dragging
  let liveHeld = new Map();        // lane -> song time the key went down
  let liveKeymap = {};             // "KeyA" -> lane

  let colors = { accent: "#ffd98f", note: "#ffb04a", hold: "#ff7468" };
  let frame = 0;

  let el = {};

  // ------------------------------------------------------------------
  // Undo / redo (snapshots; a chart has at most a few hundred notes)
  // ------------------------------------------------------------------
  const HISTORY_LIMIT = 100;
  let history = [];
  let historyIndex = -1;

  const clone = (v) => JSON.parse(JSON.stringify(v));

  function resetHistory() {
    history = [clone(notes)];
    historyIndex = 0;
    updateHistoryButtons();
  }
  function pushHistory() {
    history = history.slice(0, historyIndex + 1);
    history.push(clone(notes));
    if (history.length > HISTORY_LIMIT) history.shift();
    else historyIndex++;
    updateHistoryButtons();
  }
  function undo() {
    if (historyIndex <= 0) return;
    notes = clone(history[--historyIndex]);
    updateHistoryButtons();
  }
  function redo() {
    if (historyIndex >= history.length - 1) return;
    notes = clone(history[++historyIndex]);
    updateHistoryButtons();
  }
  function updateHistoryButtons() {
    el.undo.disabled = historyIndex <= 0;
    el.redo.disabled = historyIndex >= history.length - 1;
  }

  // ------------------------------------------------------------------
  // Init
  // ------------------------------------------------------------------
  function init() {
    canvas = document.getElementById("editor-timeline-canvas");
    gfx = canvas.getContext("2d");
    wrapEl = document.getElementById("editor-timeline-wrap");
    stageEl = document.getElementById("editor-stage");
    spacerEl = document.getElementById("editor-spacer");

    const id = (x) => document.getElementById(x);
    el = {
      bpm: id("editor-bpm"), offset: id("editor-offset"), snap: id("editor-snap"), zoom: id("editor-zoom"),
      keymode: id("editor-keymode"), title: id("editor-title"),
      playPause: id("btn-editor-playpause"), time: id("editor-time-display"), hint: id("editor-record-hint"),
      lanes: id("editor-lane-labels"), empty: id("editor-empty-hint"),
      fileInput: id("editor-file-input"), importInput: id("editor-import-input"),
      catalogHint: id("editor-catalog-hint"), catalogSnippet: id("editor-catalog-snippet"),
      undo: id("btn-editor-undo"), redo: id("btn-editor-redo"),
    };

    setKeyMode(App.getSettings().keyMode);
    bindToolbar();
    bindTransport();
    bindTimeline();
    bindFileActions();
    bindModeTabs();
    bindKeyboard();
    resetHistory();

    window.addEventListener("resize", () => { if (isActive()) resizeCanvas(); });
    document.addEventListener("languagechange", () => {
      setPlayIcon(isPlaying);
      if (mode === "live") el.hint.textContent = isPlaying ? t("ed.recording") : liveHint();
    });
    wrapEl.addEventListener("scroll", () => { /* the render loop reads scrollLeft each frame */ });
    requestAnimationFrame(renderLoop);
  }

  const isActive = () => document.getElementById("screen-editor").classList.contains("screen--active");
  const currentTime = () => (isPlaying ? AudioManager.getPosition() : editorPos);

  // Called when the editor screen opens. With nothing placed yet, follow the
  // default key count from Settings; never touch a chart in progress.
  function onEnter() {
    const wanted = App.getSettings().keyMode;
    if (!notes.length && LANE_COUNT !== wanted) setKeyMode(wanted);
  }

  // Called by the app shell when the editor screen is left (including for
  // Test Play), so the editor never keeps playing behind another screen.
  function suspend() {
    if (isPlaying) stopPlayback();
  }

  function setKeyMode(count) {
    LANE_COUNT = count;
    const keymap = App.getKeymapFor(count);
    KEY_LABELS = keymap.map((code) => UI.keyLabel(code));
    liveKeymap = {};
    keymap.forEach((code, i) => { liveKeymap[code] = i; });
    el.keymode.value = String(count);
    buildLaneLabels();
    resizeCanvas();
  }

  function buildLaneLabels() {
    el.lanes.replaceChildren();
    KEY_LABELS.forEach((k) => {
      const s = document.createElement("span");
      s.textContent = k;
      el.lanes.appendChild(s);
    });
  }

  // ------------------------------------------------------------------
  // Loading audio
  // ------------------------------------------------------------------
  function bindToolbar() {
    el.fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;

      if (audioLoadedOnce && notes.length) {
        const ok = await UI.confirm({
          title: t("ed.newAudioTitle"),
          text: t("ed.newAudioText"),
          okLabel: t("ed.newAudioOk"),
        });
        if (!ok) return;
      }

      let decoded;
      try { decoded = await AudioManager.decodeFile(file); }
      catch { UI.toast(t("up.badAudio"), "error"); return; }

      suspend();
      buffer = decoded;
      sourceFile = file;
      duration = decoded.duration;
      editorPos = 0;
      if (audioLoadedOnce) { notes = []; }
      audioLoadedOnce = true;
      resetHistory();
      buildWaveform(decoded);
      if (!el.title.value.trim() || el.title.value === "Custom Beatmap") {
        el.title.value = file.name.replace(/\.[a-z0-9]+$/i, "");
      }
      el.empty.hidden = true;
      wrapEl.scrollLeft = 0;
      resizeCanvas();
    });

    el.bpm.addEventListener("input", () => { bpm = Math.max(20, +el.bpm.value || 120); });
    el.offset.addEventListener("input", () => { offsetMs = +el.offset.value || 0; });
    el.snap.addEventListener("change", () => { snapDivisor = +el.snap.value; });
    el.zoom.addEventListener("input", () => {
      const centerTime = (wrapEl.scrollLeft + wrapEl.clientWidth / 2) / pxPerSecond;
      pxPerSecond = +el.zoom.value;
      resizeCanvas();
      wrapEl.scrollLeft = centerTime * pxPerSecond - wrapEl.clientWidth / 2;
      paintRange(el.zoom);
    });
    paintRange(el.zoom);

    el.keymode.addEventListener("change", async () => {
      const next = +el.keymode.value;
      if (next === LANE_COUNT) return;
      if (notes.length) {
        const ok = await UI.confirm({
          title: t("ed.keysTitle"),
          text: t("ed.keysText"),
          okLabel: t("ed.keysOk"), danger: true,
        });
        if (!ok) { el.keymode.value = String(LANE_COUNT); return; }
      }
      notes = [];
      resetHistory();
      setKeyMode(next);
    });
  }

  function paintRange(input) {
    const min = +input.min || 0, max = +input.max || 100;
    input.style.setProperty("--p", `${((+input.value - min) / (max - min)) * 100}%`);
  }

  // Peak amplitude per bucket (~400 per second, one per pixel at max zoom),
  // so drawing the waveform never means plotting every sample.
  function buildWaveform(decoded) {
    const raw = decoded.getChannelData(0);
    const bucketCount = Math.max(1, Math.ceil(decoded.duration * 400));
    const bucketSize = Math.max(1, Math.floor(raw.length / bucketCount));
    const peaks = new Float32Array(bucketCount);
    for (let b = 0; b < bucketCount; b++) {
      let max = 0;
      const start = b * bucketSize;
      const end = Math.min(raw.length, start + bucketSize);
      for (let i = start; i < end; i++) {
        const v = Math.abs(raw[i]);
        if (v > max) max = v;
      }
      peaks[b] = max;
    }
    waveformPeaks = peaks;
  }

  // ------------------------------------------------------------------
  // Transport
  // ------------------------------------------------------------------
  function bindTransport() {
    el.playPause.addEventListener("click", togglePlay);

    document.querySelectorAll(".editor-speed [data-speed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".editor-speed [data-speed]").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        playSpeed = +btn.dataset.speed;
        if (isPlaying) AudioManager.setRate(playSpeed);
      });
    });
  }

  function setPlayIcon(playing) {
    el.playPause.querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");
    el.playPause.setAttribute("aria-label", t(playing ? "ed.pause" : "ed.play"));
  }

  function startPlayback() {
    if (!buffer) return;
    AudioManager.useBuffer(buffer);
    if (editorPos >= duration - 0.05) editorPos = 0;
    AudioManager.play(editorPos, playSpeed);
    isPlaying = true;
    setPlayIcon(true);
    if (mode === "live") startLive();
  }

  function stopPlayback() {
    if (isPlaying) {
      editorPos = Math.min(duration, AudioManager.getPosition());
      AudioManager.pause();
    }
    isPlaying = false;
    setPlayIcon(false);
    if (mode === "live") stopLive();
  }

  function togglePlay() {
    if (!buffer) { UI.toast(t("ed.loadFirst")); return; }
    if (isPlaying) stopPlayback(); else startPlayback();
  }

  function seekTo(t) {
    editorPos = Math.max(0, Math.min(duration, t));
    if (isPlaying) { AudioManager.useBuffer(buffer); AudioManager.play(editorPos, playSpeed); }
  }

  // ------------------------------------------------------------------
  // Mode tabs
  // ------------------------------------------------------------------
  function liveHint() { return t("ed.liveHint", { keys: KEY_LABELS.join(" ") }); }

  function bindModeTabs() {
    document.querySelectorAll(".editor-tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        if (isPlaying) stopPlayback();
        document.querySelectorAll(".editor-tab").forEach((t) => t.classList.remove("is-active"));
        tab.classList.add("is-active");
        mode = tab.dataset.mode;
        el.hint.textContent = mode === "live" ? liveHint() : "";
        el.hint.classList.remove("recording");
      });
    });
  }

  // ------------------------------------------------------------------
  // Manual timeline
  // ------------------------------------------------------------------
  function bindTimeline() {
    canvas.addEventListener("pointerdown", (e) => {
      if (mode !== "manual" || !buffer || e.button !== 0) return;
      const { lane, time } = pick(e);
      if (lane === null) return;

      const existing = noteAt(lane, time);
      if (existing) {
        notes = notes.filter((n) => n !== existing);
        pushHistory();
        return;
      }
      dragStart = { lane, time: snapTime(time) };
      dragNow = dragStart.time;
      canvas.setPointerCapture(e.pointerId);
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!dragStart) return;
      dragNow = snapTime(pick(e, true).time);
    });

    const finish = (e) => {
      if (!dragStart) return;
      const start = dragStart;
      dragStart = null;
      const endTime = snapTime(pick(e, true).time);
      dragNow = null;
      const length = endTime - start.time;
      if (length > MIN_DRAG_HOLD_S) addNote({ time: start.time, lane: start.lane, type: "hold", duration: length });
      else addNote({ time: start.time, lane: start.lane, type: "tap" });
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", () => { dragStart = null; dragNow = null; });

    canvas.addEventListener("dblclick", (e) => {
      if (!buffer) return;
      seekTo((e.offsetX + wrapEl.scrollLeft) / pxPerSecond);
    });
  }

  // `clamp` keeps a drag that leaves the canvas inside the song.
  function pick(e, clamp = false) {
    const time = (e.offsetX + wrapEl.scrollLeft) / pxPerSecond;
    const lane = Math.floor(e.offsetY / laneH);
    if (clamp) return { lane, time: Math.max(0, Math.min(duration, time)) };
    if (lane < 0 || lane >= LANE_COUNT || time < 0 || time > duration) return { lane: null, time: null };
    return { lane, time };
  }

  function noteAt(lane, time) {
    const tol = 9 / pxPerSecond; // about 9px either side
    return notes.find((n) =>
      n.lane === lane &&
      (Math.abs(n.time - time) <= tol || (n.type === "hold" && time >= n.time && time <= n.time + n.duration)));
  }

  // Same rule as the generator and the validator (ChartGen.conflicts):
  // after a hold ends, its lane stays empty for half a second.
  function overlaps(candidate) {
    return notes.some((n) => n.lane === candidate.lane && ChartGen.conflicts(n, candidate));
  }

  function addNote(note, quiet = false) {
    if (overlaps(note)) {
      if (!quiet) UI.toast(t("ed.overlap"), "error", 4200);
      return false;
    }
    notes.push(note);
    pushHistory();
    return true;
  }

  function snapTime(t) {
    const gridSec = 60 / bpm / snapDivisor;
    const offsetSec = offsetMs / 1000;
    return Math.max(0, Math.round((t - offsetSec) / gridSec) * gridSec + offsetSec);
  }

  // ------------------------------------------------------------------
  // Live recording. Notes are recorded in song time (position corrected by
  // the player's calibration offset), exactly what the game grades against.
  // ------------------------------------------------------------------
  function startLive() {
    liveHeld.clear();
    el.hint.textContent = t("ed.recording");
    el.hint.classList.add("recording");
  }
  function stopLive() {
    liveHeld.clear();
    el.hint.textContent = liveHint();
    el.hint.classList.remove("recording");
  }

  function bindKeyboard() {
    document.addEventListener("keydown", (e) => {
      if (!isActive()) return;
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);

      if ((e.ctrlKey || e.metaKey) && !typing) {
        if (e.code === "KeyZ" && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (e.code === "KeyY" || (e.code === "KeyZ" && e.shiftKey)) { e.preventDefault(); redo(); return; }
      }
      if (e.code === "Space" && !typing && document.activeElement?.tagName !== "BUTTON") {
        e.preventDefault();
        togglePlay();
        return;
      }
      if (mode !== "live" || !isPlaying || e.repeat) return;
      const lane = liveKeymap[e.code];
      if (lane === undefined) return;
      e.preventDefault();
      if (!liveHeld.has(lane)) liveHeld.set(lane, AudioManager.getSongTime());
    });

    document.addEventListener("keyup", (e) => {
      if (!isActive() || mode !== "live" || !isPlaying) return;
      const lane = liveKeymap[e.code];
      if (lane === undefined || !liveHeld.has(lane)) return;
      const startT = Math.max(0, liveHeld.get(lane));
      liveHeld.delete(lane);
      const held = AudioManager.getSongTime() - startT;
      addNote(held >= HOLD_MIN_S
        ? { time: startT, lane, type: "hold", duration: held }
        : { time: startT, lane, type: "tap" }, true);
    });

    el.undo.addEventListener("click", undo);
    el.redo.addEventListener("click", redo);
  }

  // ------------------------------------------------------------------
  // Import / export / save / test play
  // ------------------------------------------------------------------
  function buildBeatmapObject() {
    return {
      songTitle: el.title.value.trim() || "Custom Beatmap",
      bpm, offset: offsetMs, laneCount: LANE_COUNT,
      notes: [...notes].sort((a, b) => a.time - b.time),
    };
  }

  function slugify(str) {
    return str.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "custom-beatmap";
  }

  function bindFileActions() {
    document.getElementById("btn-editor-import").addEventListener("click", () => el.importInput.click());
    el.importInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      let data;
      try {
        data = ChartGen.validateBeatmap(JSON.parse(await file.text()));
      } catch (err) {
        UI.toast(err instanceof SyntaxError ? t("ed.badJson") : App.describeError(err), "error");
        return;
      }
      suspend();
      bpm = data.bpm;
      offsetMs = data.offset;
      el.bpm.value = bpm;
      el.offset.value = offsetMs;
      if (data.songTitle) el.title.value = data.songTitle;
      if (data.laneCount !== LANE_COUNT) setKeyMode(data.laneCount);
      notes = data.notes;
      resetHistory();
      if (data.dropped) UI.toast(t("up.dropped", { n: data.dropped }), "error", 5000);
      if (data.adjusted) UI.toast(t("up.adjusted", { n: data.adjusted }), "info", 5000);
    });

    document.getElementById("btn-editor-export").addEventListener("click", exportJson);
    document.getElementById("btn-editor-save").addEventListener("click", saveToLibrary);
    document.getElementById("btn-editor-testplay").addEventListener("click", testPlay);

    document.getElementById("btn-copy-catalog-snippet").addEventListener("click", () => {
      el.catalogSnippet.select();
      navigator.clipboard?.writeText(el.catalogSnippet.value)
        .then(() => UI.toast(t("ed.copied"), "success"))
        .catch(() => { document.execCommand("copy"); });
    });
  }

  function exportJson() {
    if (!notes.length) { UI.toast(t("ed.nothingExport"), "error"); return; }
    const data = buildBeatmapObject();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug = slugify(data.songTitle);
    a.href = url;
    a.download = `${slug}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // Convenience entry for beatmaps/catalog.json. The audio and beatmap
    // files still have to be placed at these paths by hand.
    const ext = (sourceFile?.name.match(/\.[a-z0-9]+$/i)?.[0] || ".mp3").toLowerCase();
    el.catalogSnippet.value = JSON.stringify({
      id: `builtin_${slug.replace(/-/g, "_")}`,
      title: data.songTitle,
      artist: "",
      bpm: Math.round(data.bpm),
      difficulty: "?",
      laneCount: data.laneCount,
      audioUrl: `audio/${slug}${ext}`,
      beatmapUrl: `beatmaps/${slug}.json`,
    }, null, 2);
    el.catalogHint.hidden = false;
  }

  async function saveToLibrary() {
    if (!sourceFile) { UI.toast(t("ed.needAudioSave"), "error"); return; }
    if (!notes.length) { UI.toast(t("ed.nothingSave"), "error"); return; }
    try {
      const data = buildBeatmapObject();
      await App.addSong({ file: sourceFile, beatmap: data, title: data.songTitle });
      App.refreshSongs();
      UI.toast(t("ed.saved"), "success");
    } catch (err) {
      UI.toast(App.describeError(err), "error");
    }
  }

  function testPlay() {
    if (!buffer) { UI.toast(t("ed.loadFirst"), "error"); return; }
    if (!notes.length) { UI.toast(t("ed.placeNotes"), "error"); return; }
    let beatmap;
    try { beatmap = ChartGen.validateBeatmap(buildBeatmapObject()); }
    catch (err) { UI.toast(App.describeError(err), "error"); return; }
    App.playBeatmap({ beatmap, buffer, title: t("ed.testTitle", { title: beatmap.songTitle || "Beatmap" }), returnScreen: "screen-editor" });
  }

  // ------------------------------------------------------------------
  // Layout + render
  // ------------------------------------------------------------------
  function computeLaneHeight() {
    const top = stageEl.getBoundingClientRect().top;
    const avail = window.innerHeight - top - 96; // room for the hint line below
    return Math.max(LANE_H_MIN, Math.min(LANE_H_MAX, Math.floor(avail / LANE_COUNT)));
  }

  function resizeCanvas() {
    if (!isActive()) { pendingResize = true; return; }
    pendingResize = false;
    laneH = computeLaneHeight();
    const h = laneH * LANE_COUNT;
    stageEl.style.height = `${h + 2}px`;
    el.lanes.querySelectorAll("span").forEach((s) => { s.style.height = `${laneH}px`; });

    dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, wrapEl.clientWidth);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    spacerEl.style.width = `${Math.ceil(duration * pxPerSecond)}px`;
  }
  let pendingResize = false;

  function refreshColors() {
    const css = getComputedStyle(document.documentElement);
    colors = {
      accent: css.getPropertyValue("--accent-hi").trim() || colors.accent,
      note: css.getPropertyValue("--accent").trim() || colors.note,
      hold: css.getPropertyValue("--accent-lo").trim() || colors.hold,
    };
  }

  function renderLoop() {
    if (isActive()) {
      if (pendingResize) resizeCanvas();
      if (frame++ % 90 === 0) refreshColors();
      if (buffer) {
        // Playback reached the end of the song.
        if (isPlaying && AudioManager.getPosition() >= duration) stopPlayback();
        draw();
        el.time.textContent = `${formatTime(currentTime())} / ${formatTime(duration)}`;
        if (isPlaying) followPlayhead();
      } else {
        gfx.setTransform(dpr, 0, 0, dpr, 0, 0);
        gfx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    requestAnimationFrame(renderLoop);
  }

  function followPlayhead() {
    const x = currentTime() * pxPerSecond;
    const left = wrapEl.scrollLeft, view = wrapEl.clientWidth;
    if (x < left || x > left + view - 70) wrapEl.scrollLeft = x - 70;
  }

  function draw() {
    const w = wrapEl.clientWidth, h = laneH * LANE_COUNT;
    const scroll = wrapEl.scrollLeft;
    gfx.setTransform(dpr, 0, 0, dpr, 0, 0);
    gfx.clearRect(0, 0, w, h);

    for (let lane = 0; lane < LANE_COUNT; lane++) {
      if (lane % 2 === 0) { gfx.fillStyle = "rgba(255,255,255,0.03)"; gfx.fillRect(0, lane * laneH, w, laneH); }
    }
    drawWaveform(w, h, scroll);
    drawBeatGrid(w, h, scroll);
    drawLaneLines(w);
    drawNotes(w, scroll);
    drawGhost(scroll);
    drawPlayhead(h, scroll);
  }

  function drawWaveform(w, h, scroll) {
    if (!waveformPeaks) return;
    gfx.fillStyle = "rgba(244,236,219,0.16)";
    const mid = h / 2;
    const perSec = waveformPeaks.length / duration;
    for (let px = 0; px < w; px++) {
      const t = (scroll + px) / pxPerSecond;
      if (t > duration) break;
      const amp = waveformPeaks[Math.min(waveformPeaks.length - 1, Math.floor(t * perSec))] || 0;
      const barH = amp * h * 0.9;
      gfx.fillRect(px, mid - barH / 2, 1, barH);
    }
  }

  function drawBeatGrid(w, h, scroll) {
    const gridSec = 60 / bpm / snapDivisor;
    const offsetSec = offsetMs / 1000;
    const tStart = scroll / pxPerSecond, tEnd = (scroll + w) / pxPerSecond;
    // Skip lines when they would be closer than ~5px.
    const stride = Math.max(1, Math.ceil(5 / (gridSec * pxPerSecond)));
    let i = Math.ceil((tStart - offsetSec) / gridSec);
    i += (stride - (i % stride)) % stride;
    for (; ; i += stride) {
      const t = i * gridSec + offsetSec;
      if (t > tEnd || t > duration) break;
      if (t < 0) continue;
      const beat = i % snapDivisor === 0;
      gfx.strokeStyle = beat ? "rgba(255,217,143,0.3)" : "rgba(244,236,219,0.08)";
      gfx.lineWidth = beat ? 1.2 : 0.7;
      const x = Math.round(t * pxPerSecond - scroll) + 0.5;
      gfx.beginPath();
      gfx.moveTo(x, 0);
      gfx.lineTo(x, h);
      gfx.stroke();
    }
  }

  function drawLaneLines(w) {
    gfx.strokeStyle = "rgba(244,236,219,0.14)";
    gfx.lineWidth = 1;
    for (let lane = 1; lane < LANE_COUNT; lane++) {
      const y = lane * laneH + 0.5;
      gfx.beginPath();
      gfx.moveTo(0, y);
      gfx.lineTo(w, y);
      gfx.stroke();
    }
  }

  function drawNotes(w, scroll) {
    const r = Math.min(12, laneH * 0.32);
    for (const n of notes) {
      const x = n.time * pxPerSecond - scroll;
      const len = n.type === "hold" ? n.duration * pxPerSecond : 0;
      if (x > w + r || x + len < -r) continue;
      const y = n.lane * laneH + laneH / 2;
      if (n.type === "hold") {
        gfx.fillStyle = colors.hold;
        gfx.globalAlpha = 0.5;
        gfx.fillRect(x, y - r * 0.8, len, r * 1.6);
        gfx.globalAlpha = 1;
      }
      gfx.beginPath();
      gfx.arc(x, y, r, 0, Math.PI * 2);
      gfx.fillStyle = colors.note;
      gfx.fill();
      gfx.lineWidth = 2;
      gfx.strokeStyle = "rgba(0,0,0,0.35)";
      gfx.stroke();
    }
  }

  function drawGhost(scroll) {
    if (!dragStart || dragNow === null) return;
    const x0 = dragStart.time * pxPerSecond - scroll;
    const x1 = dragNow * pxPerSecond - scroll;
    const y = dragStart.lane * laneH + laneH / 2;
    const r = Math.min(12, laneH * 0.32);
    gfx.globalAlpha = 0.55;
    gfx.fillStyle = colors.accent;
    if (x1 - x0 > 2) gfx.fillRect(x0, y - r * 0.8, x1 - x0, r * 1.6);
    gfx.beginPath();
    gfx.arc(x0, y, r, 0, Math.PI * 2);
    gfx.fill();
    gfx.globalAlpha = 1;
  }

  function drawPlayhead(h, scroll) {
    const x = Math.round(currentTime() * pxPerSecond - scroll) + 0.5;
    gfx.strokeStyle = colors.accent;
    gfx.lineWidth = 2;
    gfx.beginPath();
    gfx.moveTo(x, 0);
    gfx.lineTo(x, h);
    gfx.stroke();
  }

  function formatTime(sec) {
    const s = Math.max(0, sec);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  }

  return { init, onEnter, suspend };
})();

window.Editor = Editor;
