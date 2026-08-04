/* ==========================================================================
   MAIN.JS
   Owns screen navigation (MainMenu → SongSelect → Calibration → Gameplay
   → Result / Settings / Editor) and glues AudioManager + GameEngine to
   the DOM. Nothing gameplay-specific lives here — that's engine.js.
   ========================================================================== */

(() => {
  const STORAGE_LIBRARY = "tant_library";     // [{id, title, addedAt}]
  const STORAGE_HIGHSCORES = "tant_highscores"; // { [songId]: bestStats }
  const STORAGE_SETTINGS = "tant_settings";

  let state = {
    library: [],
    selectedSongId: null,
    settings: {
      musicVolume: 80,
      sfxVolume: 90,
      noteSpeed: 10,
      keyMode: 6,
    },
    // Runtime-only, not persisted: generated/loaded beatmap for whichever
    // song is currently ready to play (see readySongId below)
    currentBeatmap: null,
  };

  // ------------------------------------------------------------------
  // Screen switching
  // ------------------------------------------------------------------
  function goScreen(id) {
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("screen--active"));
    document.getElementById(id).classList.add("screen--active");
  }

  document.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", () => {
      const action = el.dataset.action;
      if (action.startsWith("go-")) goScreen("screen-" + action.slice(3));
    });
  });

  // ------------------------------------------------------------------
  // TOAST NOTIFICATIONS — non-blocking replacement for alert(). Toasts
  // stack (each manages its own timer independently) rather than
  // replacing one another, so back-to-back errors don't get swallowed.
  // ------------------------------------------------------------------
  const toastContainer = document.getElementById("toast-container");
  function showToast(message, type = "info", durationMs = 3500) {
    const el = document.createElement("div");
    el.className = `toast${type === "error" ? " toast--error" : type === "success" ? " toast--success" : ""}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    // rAF so the initial (pre-transition) state paints before adding
    // the class that triggers the transition — otherwise the browser
    // may coalesce both states into one frame and skip the animation.
    requestAnimationFrame(() => el.classList.add("toast--show"));
    setTimeout(() => {
      el.classList.remove("toast--show");
      setTimeout(() => el.remove(), 250); // matches the CSS transition duration
    }, durationMs);
  }

  // ------------------------------------------------------------------
  // Persistence helpers
  // ------------------------------------------------------------------
  function loadState() {
    state.library = JSON.parse(localStorage.getItem(STORAGE_LIBRARY) || "[]");
    const savedSettings = JSON.parse(localStorage.getItem(STORAGE_SETTINGS) || "null");
    if (savedSettings) state.settings = { ...state.settings, ...savedSettings };
    AudioManager.loadStoredOffset();
  }

  function saveSettings() {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(state.settings));
  }

  function saveLibrary() {
    localStorage.setItem(STORAGE_LIBRARY, JSON.stringify(state.library));
  }

  function getHighScore(songId) {
    const all = JSON.parse(localStorage.getItem(STORAGE_HIGHSCORES) || "{}");
    return all[songId] || null;
  }

  function setHighScore(songId, stats) {
    const all = JSON.parse(localStorage.getItem(STORAGE_HIGHSCORES) || "{}");
    const prevBest = all[songId];
    if (!prevBest || stats.score > prevBest.score) {
      all[songId] = stats;
      localStorage.setItem(STORAGE_HIGHSCORES, JSON.stringify(all));
    }
  }

  // ------------------------------------------------------------------
  // SONG SELECT — merges two sources into one list:
  //   1. Built-in catalog (beatmaps/catalog.json) — pre-made songs
  //      shipped with the site (royalty-free audio + matching beatmap),
  //      fetched same-origin, no upload needed, always playable.
  //   2. User uploads — dropped in via file input, custom-only for now.
  //      NOTE: uploaded audio is NOT persisted (no server, and storing
  //      multi-MB audio in localStorage isn't viable) — only metadata
  //      survives a refresh. Re-upload the same file to play it again
  //      in a future session, OR use the Editor to build & export a
  //      proper beatmap.json for it (custom beatmap creation stays
  //      fully supported, independent of the built-in catalog).
  // ------------------------------------------------------------------
  const CATALOG_URL = "beatmaps/catalog.json";
  let builtinCatalog = [];       // [{id, title, artist, bpm, difficulty, duration, audioUrl, beatmapUrl, laneCount}]
  let readySongId = null;        // id of the song currently loaded into AudioManager + state.currentBeatmap

  // Session-only cache of uploaded songs' raw File + parsed beatmap, so
  // switching back to a previously uploaded song doesn't lose its
  // "ready to play" state just because a different song was uploaded
  // after it. Cleared on page refresh (never persisted — no server).
  const uploadedAssets = new Map(); // id -> { file, beatmap }

  const fileInput = document.getElementById("song-file-input");
  const beatmapFileInput = document.getElementById("song-beatmap-input");
  const uploadPanel = document.getElementById("upload-panel");
  const uploadToggleBtn = document.getElementById("btn-upload-toggle");
  const uploadMp3Name = document.getElementById("upload-mp3-name");
  const uploadJsonName = document.getElementById("upload-json-name");
  const btnUploadConfirm = document.getElementById("btn-upload-confirm");
  const btnClearLibrary = document.getElementById("btn-clear-library");
  const songListEl = document.getElementById("song-list");
  const songListEmpty = document.getElementById("song-list-empty");
  const btnStartSong = document.getElementById("btn-start-song");
  const songHighscoreEl = document.getElementById("song-highscore");

  let pendingMp3File = null;
  let pendingBeatmapFile = null;

  async function loadCatalog() {
    try {
      const res = await fetch(CATALOG_URL);
      if (res.ok) builtinCatalog = await res.json();
    } catch (err) {
      // Catalog is optional — site still works with upload-only songs
      // if beatmaps/catalog.json is missing or fails to fetch.
      console.warn("Không tải được catalog bài có sẵn:", err);
    }
    renderSongList();
  }

  uploadToggleBtn.addEventListener("click", () => {
    uploadPanel.hidden = !uploadPanel.hidden;
  });

  btnClearLibrary.addEventListener("click", () => {
    if (!state.library.length) return;
    if (!confirm("Xoá toàn bộ danh sách bài tự tải lên? (Bài Có Sẵn không bị ảnh hưởng)")) return;
    state.library = [];
    uploadedAssets.clear();
    saveLibrary();
    if (readySongId && !builtinCatalog.some((s) => s.id === readySongId)) readySongId = null;
    state.selectedSongId = null;
    state.currentBeatmap = null;
    btnStartSong.disabled = true;
    songHighscoreEl.textContent = "";
    renderSongList();
  });

  const uploadGenModeSelect = document.getElementById("upload-genmode");
  const uploadBpmInput = document.getElementById("upload-bpm");
  const uploadOffsetInput = document.getElementById("upload-offset");
  const uploadNoteTypeSelect = document.getElementById("upload-notetype");
  const uploadAutogenOptions = document.getElementById("upload-autogen-options");
  const uploadOnsetOptions = document.getElementById("upload-onset-options");
  const uploadSensitivitySelect = document.getElementById("upload-sensitivity");
  const uploadSnapSelect = document.getElementById("upload-snap");
  const uploadMinDistInput = document.getElementById("upload-mindist");
  const uploadMaxRateInput = document.getElementById("upload-maxrate");

  function updateAutogenVisibility() {
    const hasJson = !!pendingBeatmapFile;
    uploadAutogenOptions.style.display = hasJson ? "none" : "flex";
    uploadOnsetOptions.style.display =
      (!hasJson && uploadGenModeSelect.value === "onset") ? "flex" : "none";
  }
  uploadGenModeSelect.addEventListener("change", updateAutogenVisibility);

  fileInput.addEventListener("change", (e) => {
    pendingMp3File = e.target.files[0] || null;
    uploadMp3Name.textContent = pendingMp3File ? pendingMp3File.name : "Chưa chọn file";
    btnUploadConfirm.disabled = !pendingMp3File;
  });

  beatmapFileInput.addEventListener("change", (e) => {
    pendingBeatmapFile = e.target.files[0] || null;
    uploadJsonName.textContent = pendingBeatmapFile
      ? pendingBeatmapFile.name
      : "Không có — sẽ tự tạo nốt ngẫu nhiên";
    updateAutogenVisibility();
  });

  // mp3 alone → placeholder chart auto-generated so it's still playable;
  // mp3 + matching beatmap.json → chart plays exactly as authored.
  btnUploadConfirm.addEventListener("click", async () => {
    if (!pendingMp3File) return;
    await AudioManager.loadFile(pendingMp3File);

    const id = `upload_${Date.now()}`;
    const title = pendingMp3File.name.replace(/\.(mp3|wav)$/i, "");
    let laneCount;
    const bpmVal = +uploadBpmInput.value || 120;
    const offsetVal = +uploadOffsetInput.value || 0;

    if (pendingBeatmapFile) {
      try {
        const text = await pendingBeatmapFile.text();
        state.currentBeatmap = JSON.parse(text);
        laneCount = state.currentBeatmap.laneCount || inferLaneCount(state.currentBeatmap.notes);
      } catch (err) {
        showToast("File beatmap.json không hợp lệ — dùng nốt tự động thay thế.", "error");
        laneCount = state.settings.keyMode;
        state.currentBeatmap = generatePlaceholderBeatmap(
          AudioManager.getDuration(), bpmVal, uploadNoteTypeSelect.value, laneCount, offsetVal);
      }
    } else {
      laneCount = state.settings.keyMode;

      if (uploadGenModeSelect.value === "onset") {
        btnUploadConfirm.disabled = true;
        const originalLabel = btnUploadConfirm.textContent;
        btnUploadConfirm.textContent = "Đang phân tích âm thanh...";
        try {
          state.currentBeatmap = await generateOnsetBeatmap(
            pendingMp3File, bpmVal, offsetVal, uploadNoteTypeSelect.value, laneCount,
            uploadSensitivitySelect.value, +uploadSnapSelect.value,
            +uploadMinDistInput.value || 120, +uploadMaxRateInput.value || 6);
          if (!state.currentBeatmap.notes.length) {
            showToast("Không phát hiện được điểm nhạc nào — dùng Beat Grid thay thế. Thử giảm Độ Nhạy hoặc Khoảng Cách Tối Thiểu.", "error");
            state.currentBeatmap = generatePlaceholderBeatmap(
              AudioManager.getDuration(), bpmVal, uploadNoteTypeSelect.value, laneCount, offsetVal);
          }
        } catch (err) {
          console.error(err);
          showToast("Phân tích âm thanh lỗi — dùng Beat Grid thay thế.", "error");
          state.currentBeatmap = generatePlaceholderBeatmap(
            AudioManager.getDuration(), bpmVal, uploadNoteTypeSelect.value, laneCount, offsetVal);
        }
        btnUploadConfirm.textContent = originalLabel;
      } else {
        // Beat Grid — unchanged algorithm from before.
        state.currentBeatmap = generatePlaceholderBeatmap(
          AudioManager.getDuration(), bpmVal, uploadNoteTypeSelect.value, laneCount, offsetVal);
      }
    }

    state.library.unshift({ id, title, addedAt: Date.now(), source: "upload", laneCount });
    saveLibrary();
    uploadedAssets.set(id, { file: pendingMp3File, beatmap: state.currentBeatmap });
    state.selectedSongId = id;
    readySongId = id;

    // reset the pending panel for next time
    pendingMp3File = null;
    pendingBeatmapFile = null;
    fileInput.value = "";
    beatmapFileInput.value = "";
    uploadMp3Name.textContent = "Chưa chọn file";
    uploadJsonName.textContent = "Không có — sẽ tự tạo nốt ngẫu nhiên";
    updateAutogenVisibility();
    btnUploadConfirm.disabled = true;
    uploadPanel.hidden = true;

    renderSongList();
    btnStartSong.disabled = false;
  });

  // Beatmaps authored elsewhere (or by hand) may not declare laneCount
  // explicitly — fall back to inferring it from the highest lane index
  // actually used, rounded up to the nearest supported key mode.
  function inferLaneCount(notes) {
    const maxLane = notes.reduce((max, n) => Math.max(max, n.lane), 0);
    if (maxLane <= 3) return 4;
    if (maxLane <= 5) return 6;
    return 8;
  }

  function combinedSongList() {
    const builtins = builtinCatalog.map((s) => ({ ...s, source: "builtin" }));
    const uploads = state.library.filter((s) => s.source !== "builtin");
    return [...builtins, ...uploads];
  }

  function renderSongList() {
    const songs = combinedSongList();
    songListEl.querySelectorAll(".song-card").forEach((el) => el.remove());
    songListEmpty.style.display = songs.length ? "none" : "block";

    songs.forEach((song) => {
      const card = document.createElement("div");
      card.className = "song-card" + (song.id === state.selectedSongId ? " song-card--selected" : "");
      const tag = song.source === "builtin" ? "Có Sẵn" : "Tự Tải Lên";
      const laneCount = song.laneCount || 6;
      const meta = song.source === "builtin"
        ? `${tag} · ${song.difficulty || "?"} · ${song.bpm} BPM`
        : `${tag} · Đã thêm ${new Date(song.addedAt).toLocaleDateString("vi-VN")}`;
      card.innerHTML = `
        <div>
          <div class="song-card__title">${escapeHtml(song.title)}<span class="song-card__badge">${laneCount}K</span></div>
          <div class="song-card__meta" data-role="meta">${escapeHtml(meta)}</div>
        </div>
      `;
      card.addEventListener("click", () => selectSong(song));
      songListEl.appendChild(card);
    });
  }

  async function selectSong(song) {
    state.selectedSongId = song.id;
    renderSongList();

    const best = getHighScore(song.id);
    songHighscoreEl.textContent = best
      ? `Điểm cao: ${best.score} (Rank ${best.rank})`
      : "Chưa có điểm";

    if (song.source === "upload") {
      const cached = uploadedAssets.get(song.id);
      if (!cached) {
        // Shouldn't normally happen (cache only clears on Xoá Danh Sách
        // or page refresh, and a refreshed library entry wouldn't be
        // selectable anyway since it's gone from state.library too) —
        // kept as a safety net.
        btnStartSong.disabled = true;
        songHighscoreEl.textContent += " — hãy tải lại file mp3 này để chơi";
        return;
      }
      await AudioManager.loadFile(cached.file);
      state.currentBeatmap = cached.beatmap;
      readySongId = song.id;
      btnStartSong.disabled = false;
      updatePracticeDurationHint();
      return;
    }

    // Built-in song: fetch beatmap json + decode audio, both same-origin.
    btnStartSong.disabled = true;
    const metaEl = songListEl.querySelector(".song-card--selected [data-role='meta']");
    const originalMeta = metaEl.textContent;
    metaEl.textContent = "Đang tải...";
    try {
      const [beatmap] = await Promise.all([
        fetch(song.beatmapUrl).then((r) => r.json()),
        AudioManager.loadFromUrl(song.audioUrl),
      ]);
      state.currentBeatmap = beatmap;
      readySongId = song.id;
      if (state.selectedSongId === song.id) {
        btnStartSong.disabled = false;
        metaEl.textContent = originalMeta;
      }
    } catch (err) {
      metaEl.textContent = "Lỗi tải bài — thử lại";
      console.error(err);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // Fallback beatmap for freshly uploaded songs that don't have a
  // matching .json yet.
  //   bpm       — difficulty (higher BPM = more beats/sec = denser chart)
  //   noteType  — "tap" | "hold" | "mixed"
  // Tracks how long each lane stays "busy" from an active Hold note so
  // a Tap is never dropped on top of one (previously made that section
  // un-hittable). Lead-in/out margin now scales with the clip's actual
  // length instead of a fixed 2s each way — a fixed margin silently
  // produced a completely empty chart for anything under ~4 seconds,
  // which is what "auto-generate makes zero notes" turned out to be.
  function generatePlaceholderBeatmap(durationSec, bpm, noteType, laneCount, offsetMs = 0) {
    const notes = [];
    const beatSec = 60 / bpm;
    const laneBusyUntil = new Array(laneCount).fill(0);

    const margin = Math.min(2, Math.max(0, durationSec * 0.15));
    const start = margin;
    const end = Math.max(start + beatSec, durationSec - margin);

    for (let t = start; t < end; t += beatSec) {
      if (Math.random() < 0.6) {
        const freeLanes = [];
        for (let l = 0; l < laneCount; l++) if (laneBusyUntil[l] <= t) freeLanes.push(l);
        if (!freeLanes.length) continue; // every lane still busy with a hold — skip this beat
        const lane = freeLanes[Math.floor(Math.random() * freeLanes.length)];

        const useHold = noteType === "hold" ? true
          : noteType === "tap" ? false
          : Math.random() < 0.15; // "mixed" — mostly taps, occasional holds

        if (useHold) {
          const duration = beatSec * (1 + Math.floor(Math.random() * 2)); // 1–2 beats long
          notes.push({ time: t, lane, type: "hold", duration });
          laneBusyUntil[lane] = t + duration;
        } else {
          notes.push({ time: t, lane, type: "tap" });
        }
      }
    }

    // Safety net — a pathologically short clip (or an unlucky run of
    // Math.random() misses) should never produce a totally empty chart.
    if (!notes.length) {
      notes.push({ time: Math.min(0.5, durationSec / 2), lane: 0, type: "tap" });
    }

    return { songTitle: "Auto-generated", bpm, offset: offsetMs, laneCount, notes };
  }

  // ==================================================================
  // AUDIO ANALYSIS (Onset Detection) — a second, entirely independent
  // chart-generation path. Does not call or modify generatePlaceholderBeatmap
  // above in any way; Beat Grid stays exactly as it was.
  //
  // Pipeline: decode PCM → 25ms-frame RMS energy → flag frames where
  // energy jumps sharply vs. the previous frame (an "onset") → enforce
  // min-distance + max-notes/sec → optionally snap each onset to the
  // nearest BPM grid line → assign lanes (round-robin, avoids repeating
  // the same lane twice in a row and avoids lanes still busy holding).
  // ==================================================================

  const SENSITIVITY_THRESHOLD = { low: 0.35, medium: 0.2, high: 0.1 };

  async function generateOnsetBeatmap(file, bpm, offsetMs, noteType, laneCount, sensitivity, snapDivisor, minDistanceMs, maxNotesPerSec) {
    const onsetTimes = await detectOnsets(file, sensitivity, minDistanceMs, maxNotesPerSec);
    const snappedTimes = snapDivisor
      ? onsetTimes.map((t) => snapToGrid(t, bpm, offsetMs, snapDivisor))
      : onsetTimes;
    const notes = assignLanesToOnsets(snappedTimes, laneCount, noteType);
    return { songTitle: "Audio Analysis", bpm, offset: offsetMs, laneCount, notes };
  }

  // Independent decode — mirrors the same technique the Beatmap Editor's
  // waveform view already uses (its own short-lived AudioContext), kept
  // separate on purpose so this feature can't accidentally affect that
  // existing decode path.
  async function detectOnsets(file, sensitivity, minDistanceMs, maxNotesPerSec) {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await ctx.decodeAudioData(arrayBuffer);
    const raw = buffer.getChannelData(0);
    const sr = buffer.sampleRate;
    ctx.close();

    const frameSec = 0.025; // 25ms frames per spec
    const frameSize = Math.max(1, Math.floor(sr * frameSec));
    const frameCount = Math.floor(raw.length / frameSize);

    const rms = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      let sum = 0;
      const start = f * frameSize;
      const end = start + frameSize;
      for (let i = start; i < end; i++) sum += raw[i] * raw[i];
      rms[f] = Math.sqrt(sum / frameSize);
    }

    const threshold = SENSITIVITY_THRESHOLD[sensitivity] ?? SENSITIVITY_THRESHOLD.medium;
    const SILENCE_FLOOR = 0.02; // ignore jumps inside near-silent passages (noise, not real onsets)

    const raw_onsets = [];
    let lastOnsetTime = -Infinity;
    for (let f = 1; f < frameCount; f++) {
      const delta = rms[f] - rms[f - 1];
      if (rms[f] < SILENCE_FLOOR) continue;
      if (delta > threshold * (rms[f - 1] + 0.01)) {
        const t = f * frameSec;
        if ((t - lastOnsetTime) * 1000 >= minDistanceMs) {
          raw_onsets.push(t);
          lastOnsetTime = t;
        }
      }
    }

    // Enforce max notes/sec via a trailing 1-second window. Onset list
    // is already time-ordered, so only look backward.
    const accepted = [];
    for (const t of raw_onsets) {
      let windowCount = 0;
      for (let i = accepted.length - 1; i >= 0 && t - accepted[i] < 1; i--) windowCount++;
      if (windowCount < maxNotesPerSec) accepted.push(t);
    }

    return accepted;
  }

  function snapToGrid(t, bpm, offsetMs, snapDivisor) {
    const beatSec = 60 / bpm;
    const gridSec = beatSec / snapDivisor;
    const offsetSec = offsetMs / 1000;
    return Math.round((t - offsetSec) / gridSec) * gridSec + offsetSec;
  }

  // Shuffle-bag lane assignment — guarantees every lane gets picked
  // exactly once per full cycle through the bag (fair distribution,
  // no lane silently starved), while the shuffle order still keeps it
  // feeling natural rather than a rigid 0→1→2→... sequence. Busy-hold
  // lanes and immediate same-lane repeats are deferred by pushing them
  // to the back of the *same* bag and trying the next one — not by
  // filtering into a new array, which is what caused the original bug:
  // filtering re-indexes the array, so a fixed `pointer % length` no
  // longer points at the lane it's supposed to, and one lane ends up
  // never selected.
  function assignLanesToOnsets(times, laneCount, noteType) {
    const notes = [];
    const laneBusyUntil = new Array(laneCount).fill(0);
    let lastLane = -1;
    let bag = [];

    function refillBag() {
      bag = Array.from({ length: laneCount }, (_, i) => i);
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }
    }
    refillBag();

    for (let i = 0; i < times.length; i++) {
      const t = times[i];
      const nextT = times[i + 1] ?? t + 1;

      let lane = null;
      const maxAttempts = laneCount * 4 + 8; // generous bound, just guards against a pathological loop
      for (let attempt = 0; attempt < maxAttempts && lane === null; attempt++) {
        if (bag.length === 0) refillBag();
        const candidate = bag.shift();

        if (laneBusyUntil[candidate] > t) {
          bag.push(candidate); // still holding — try again later, don't drop it
          continue;
        }
        // Defer an immediate repeat only if a different free lane is
        // still available in the bag; otherwise a repeat is the only
        // option and gets accepted rather than looping forever.
        const otherFreeExists = bag.some((l) => laneBusyUntil[l] <= t);
        if (candidate === lastLane && otherFreeExists) {
          bag.push(candidate);
          continue;
        }
        lane = candidate;
      }
      if (lane === null) continue; // every lane busy holding — skip this onset entirely

      const useHold = noteType === "hold" ? true
        : noteType === "tap" ? false
        : Math.random() < 0.15;

      if (useHold) {
        const gap = Math.max(0.15, nextT - t);
        const duration = Math.min(gap * 0.7, 1.2);
        notes.push({ time: t, lane, type: "hold", duration });
        laneBusyUntil[lane] = t + duration;
      } else {
        notes.push({ time: t, lane, type: "tap" });
      }
      lastLane = lane;
    }
    return notes;
  }

  // ------------------------------------------------------------------
  // PRACTICE MODE — loop a chosen [start, end] range of the currently
  // selected song. Actual looping happens in GameEngine (setLoopRegion);
  // this block only owns the Song Select UI for picking the range.
  // ------------------------------------------------------------------
  const practiceToggle = document.getElementById("practice-toggle");
  const autoplayToggle = document.getElementById("autoplay-toggle");
  const practiceStartInput = document.getElementById("practice-start");
  const practiceEndInput = document.getElementById("practice-end");
  const practiceDurationHint = document.getElementById("practice-duration-hint");

  practiceToggle.addEventListener("change", () => {
    practiceStartInput.disabled = !practiceToggle.checked;
    practiceEndInput.disabled = !practiceToggle.checked;
    updatePracticeDurationHint();
  });

  function updatePracticeDurationHint() {
    if (!practiceToggle.checked) { practiceDurationHint.textContent = ""; return; }
    const duration = AudioManager.getDuration();
    practiceDurationHint.textContent = duration
      ? `(bài dài ${duration.toFixed(1)}s)`
      : "(chọn 1 bài trước)";
  }

  // ------------------------------------------------------------------
  // KEY MODE MISMATCH WARNING — a chart authored for one key mode
  // (e.g. 6K) can't play correctly if Settings is on another (e.g. 4K).
  // ------------------------------------------------------------------
  const keymodeModal = document.getElementById("keymode-warning-modal");
  const keymodeModalText = document.getElementById("keymode-warning-text");

  btnStartSong.addEventListener("click", () => {
    const song = combinedSongList().find((s) => s.id === state.selectedSongId);
    const songLaneCount = song?.laneCount || state.currentBeatmap?.laneCount || 6;
    if (songLaneCount !== state.settings.keyMode) {
      keymodeModalText.textContent =
        `Bài này được tạo cho chế độ ${songLaneCount}K, nhưng Cài Đặt hiện đang ở ${state.settings.keyMode}K. ` +
        `Chơi sai chế độ sẽ khiến vài nốt không thể bấm được.`;
      keymodeModal.dataset.targetLaneCount = songLaneCount;
      keymodeModal.hidden = false;
      return;
    }
    startGameplay();
  });

  document.getElementById("btn-keymode-warning-cancel").addEventListener("click", () => {
    keymodeModal.hidden = true;
  });
  document.getElementById("btn-keymode-warning-switch").addEventListener("click", () => {
    const target = +keymodeModal.dataset.targetLaneCount;
    state.settings.keyMode = target;
    document.getElementById("setting-keymode").value = target;
    saveSettings();
    gameplayInitialized = false;
    keymodeModal.hidden = true;
    startGameplay();
  });

  // ------------------------------------------------------------------
  // CALIBRATION — manual entry. The player judges by feel while
  // actually playing a song and nudges this value; no metronome/
  // auto-detect involved.
  // ------------------------------------------------------------------
  const calibInput = document.getElementById("calib-offset-input");
  let calibStep = 5;

  document.querySelector('[data-action="go-calibration"]').addEventListener("click", () => {
    calibInput.value = AudioManager.getOffsetMs();
  });

  document.querySelectorAll(".calib-step-row [data-step]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".calib-step-row [data-step]").forEach((b) =>
        b.classList.remove("calib-step--active"));
      btn.classList.add("calib-step--active");
      calibStep = +btn.dataset.step;
    });
  });

  document.getElementById("btn-calib-minus").addEventListener("click", () => {
    calibInput.value = (+calibInput.value || 0) - calibStep;
  });
  document.getElementById("btn-calib-plus").addEventListener("click", () => {
    calibInput.value = (+calibInput.value || 0) + calibStep;
  });
  document.getElementById("btn-calib-reset").addEventListener("click", () => {
    calibInput.value = 0;
  });
  document.getElementById("btn-calib-save").addEventListener("click", () => {
    AudioManager.saveOffset(+calibInput.value || 0);
    goScreen("screen-mainmenu");
  });

  // ------------------------------------------------------------------
  // GAMEPLAY
  // ------------------------------------------------------------------
  const canvas = document.getElementById("game-canvas");
  const pauseOverlay = document.getElementById("pause-overlay");
  let gameplayInitialized = false;

  let lastRunWasAutoplay = false;

  function startGameplay() {
    // Practice Mode validation happens before switching screens — an
    // invalid range should never silently fall back to normal play,
    // the player would be confused why looping isn't happening.
    const practiceOn = practiceToggle.checked;
    let loopStart = 0, loopEnd = 0;
    if (practiceOn) {
      loopStart = Math.max(0, +practiceStartInput.value || 0);
      loopEnd = +practiceEndInput.value || 0;
      const duration = AudioManager.getDuration();
      if (!(loopEnd > loopStart)) {
        showToast("Luyện Tập: giây kết thúc phải lớn hơn giây bắt đầu.", "error");
        return;
      }
      if (duration && loopEnd > duration) {
        showToast(`Luyện Tập: bài chỉ dài ${duration.toFixed(1)}s, giây kết thúc vượt quá độ dài bài.`, "error");
        return;
      }
    }

    const autoplayOn = autoplayToggle.checked;
    lastRunWasAutoplay = autoplayOn;

    goScreen("screen-gameplay");
    AudioManager.ensureContext();
    AudioManager.setVolume(state.settings.musicVolume);

    if (!gameplayInitialized) {
      GameEngine.init(canvas, {
        laneCount: state.settings.keyMode,
        keymap: getKeymapFor(state.settings.keyMode),
        noteSpeed: state.settings.noteSpeed,
        getSongTime: AudioManager.getSongTime,
        onFinish: handleSongFinish,
      });
      bindTouchControls(); // key indicators only exist after the first init()
      gameplayInitialized = true;
    } else {
      GameEngine.setNoteSpeed(state.settings.noteSpeed);
      GameEngine.resize();
    }

    document.getElementById("hud-song-title").textContent =
      combinedSongList().find((s) => s.id === state.selectedSongId)?.title || "—";

    GameEngine.loadBeatmap(state.currentBeatmap);
    GameEngine.setAutoplay(autoplayOn);
    if (currentSkin) GameEngine.applySkin(currentSkin);

    // Always set/clear the loop region explicitly — GameEngine keeps
    // this as module state, so a stale region from a previous Practice
    // Mode session would otherwise silently leak into normal play.
    GameEngine.setLoopRegion(practiceOn
      ? { start: loopStart, end: loopEnd, onLoop: () => AudioManager.play(loopStart) }
      : null);

    AudioManager.play(practiceOn ? loopStart : 0);
    GameEngine.start();
  }

  // Touch zones reuse the exact same .key-indicator elements the
  // keyboard path highlights — one listener set per element, bound
  // once (elements persist across replays; only rebuilt if key mode
  // changes, which re-runs GameEngine.init → re-triggers this via the
  // !gameplayInitialized branch above).
  function bindTouchControls() {
    const indicators = document.querySelectorAll("#key-row .key-indicator");
    indicators.forEach((el, lane) => {
      el.addEventListener("touchstart", (e) => {
        e.preventDefault();
        GameEngine.handleLaneDown(lane);
      }, { passive: false });
      el.addEventListener("touchend", (e) => {
        e.preventDefault();
        GameEngine.handleLaneUp(lane);
      }, { passive: false });
      el.addEventListener("touchcancel", () => GameEngine.handleLaneUp(lane));
    });
  }

  function handleSongFinish(stats) {
    AudioManager.stop();
    // Autoplay always scores a perfect run — saving that as a "high
    // score" would silently corrupt the player's real best with a fake
    // one every single time autoplay is used.
    if (state.selectedSongId && !lastRunWasAutoplay) setHighScore(state.selectedSongId, stats);

    document.getElementById("result-rank").textContent = stats.rank;
    const songTitle = combinedSongList().find((s) => s.id === state.selectedSongId)?.title || "—";
    document.getElementById("result-song-title").textContent =
      lastRunWasAutoplay ? `${songTitle} (Autoplay)` : songTitle;
    document.getElementById("result-perfect").textContent = stats.perfect;
    document.getElementById("result-great").textContent = stats.great;
    document.getElementById("result-miss").textContent = stats.miss;
    document.getElementById("result-maxcombo").textContent = stats.maxCombo;
    document.getElementById("result-accuracy").textContent = `${stats.accuracy.toFixed(1)}%`;
    document.getElementById("result-score").textContent = stats.score;

    goScreen("screen-result");
  }

  document.getElementById("btn-retry").addEventListener("click", startGameplay);

  // Keyboard → engine input (only while gameplay screen is active)
  document.addEventListener("keydown", (e) => {
    if (!document.getElementById("screen-gameplay").classList.contains("screen--active")) return;
    if (e.repeat) return;
    if (e.code === "Escape") { togglePause(true); return; }
    GameEngine.handleKeyDown(e.code);
  });
  document.addEventListener("keyup", (e) => {
    if (!document.getElementById("screen-gameplay").classList.contains("screen--active")) return;
    GameEngine.handleKeyUp(e.code);
  });

  // Pause menu
  function togglePause(show) {
    pauseOverlay.classList.toggle("show", show);
    if (show) { AudioManager.pause(); GameEngine.stop(); }
  }
  document.getElementById("btn-pause").addEventListener("click", () => togglePause(true));
  document.getElementById("btn-resume").addEventListener("click", () => {
    togglePause(false);
    AudioManager.resume();
    GameEngine.start();
  });
  document.getElementById("btn-restart").addEventListener("click", () => {
    togglePause(false);
    startGameplay();
  });
  document.getElementById("btn-quit").addEventListener("click", () => {
    togglePause(false);
    AudioManager.stop();
    goScreen("screen-songselect");
  });

  // ------------------------------------------------------------------
  // SETTINGS
  // ------------------------------------------------------------------
  const settingMusicVol = document.getElementById("setting-music-volume");
  const settingSfxVol = document.getElementById("setting-sfx-volume");
  const settingNoteSpeed = document.getElementById("setting-note-speed");
  const settingKeymode = document.getElementById("setting-keymode");

  function initSettingsUI() {
    settingMusicVol.value = state.settings.musicVolume;
    settingSfxVol.value = state.settings.sfxVolume;
    settingNoteSpeed.value = state.settings.noteSpeed;
    settingKeymode.value = state.settings.keyMode;
    renderKeybindList();
  }

  settingMusicVol.addEventListener("input", (e) => {
    state.settings.musicVolume = +e.target.value;
    AudioManager.setVolume(state.settings.musicVolume);
    saveSettings();
  });
  settingSfxVol.addEventListener("input", (e) => {
    state.settings.sfxVolume = +e.target.value;
    saveSettings();
  });
  settingNoteSpeed.addEventListener("input", (e) => {
    state.settings.noteSpeed = +e.target.value;
    if (gameplayInitialized) GameEngine.setNoteSpeed(state.settings.noteSpeed);
    saveSettings();
  });
  settingKeymode.addEventListener("change", (e) => {
    state.settings.keyMode = +e.target.value;
    saveSettings();
    // Key mode changes require re-initializing the engine's lane layout
    // next time gameplay starts.
    gameplayInitialized = false;
    renderKeybindList();
  });

  // ------------------------------------------------------------------
  // CUSTOM KEYBINDS — per key mode (4K/6K/8K each keep their own
  // mapping). Stored separately from `state.settings` under its own
  // localStorage key so GameEngine and Editor can both read it directly
  // without needing to import main.js's internal state.
  // ------------------------------------------------------------------
  const STORAGE_KEYMAPS = "tant_keymaps"; // { "4": [...4 codes], "6": [...], "8": [...] }
  const keybindListEl = document.getElementById("keybind-list");
  let rebindCleanup = null; // active keydown listener while "listening" for a new key

  function getCustomKeymaps() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEYMAPS) || "{}"); }
    catch { return {}; }
  }

  // Single source of truth for "what key plays lane i in this key
  // mode" — falls back to GameEngine's default KEYMAPS whenever no
  // valid custom mapping exists (missing, wrong length, etc.).
  function getKeymapFor(laneCount) {
    const custom = getCustomKeymaps();
    const saved = custom[laneCount];
    return (Array.isArray(saved) && saved.length === laneCount) ? saved : GameEngine.KEYMAPS[laneCount];
  }

  function codeToLabel(code) {
    return code.replace("Key", "").replace("Digit", "").replace("Semicolon", ";");
  }

  function renderKeybindList() {
    if (rebindCleanup) { rebindCleanup(); rebindCleanup = null; } // cancel any in-progress rebind
    const laneCount = state.settings.keyMode;
    const keymap = getKeymapFor(laneCount);
    keybindListEl.innerHTML = "";

    keymap.forEach((code, laneIndex) => {
      const btn = document.createElement("button");
      btn.className = "btn btn--small keybind-btn";
      btn.textContent = codeToLabel(code);
      btn.addEventListener("click", () => startRebind(laneCount, laneIndex, btn));
      keybindListEl.appendChild(btn);
    });

    const resetBtn = document.createElement("button");
    resetBtn.className = "btn btn--small";
    resetBtn.textContent = "Đặt Lại Mặc Định";
    resetBtn.addEventListener("click", () => {
      const custom = getCustomKeymaps();
      delete custom[laneCount];
      localStorage.setItem(STORAGE_KEYMAPS, JSON.stringify(custom));
      gameplayInitialized = false;
      renderKeybindList();
    });
    keybindListEl.appendChild(resetBtn);
  }

  function startRebind(laneCount, laneIndex, btn) {
    if (rebindCleanup) rebindCleanup(); // only one rebind listener active at a time

    const originalLabel = btn.textContent;
    btn.textContent = "Nhấn phím...";
    btn.classList.add("keybind-btn--listening");

    const handler = (e) => {
      e.preventDefault();
      cleanup();

      if (e.code === "Escape") return; // cancel, keep old binding

      const current = [...getKeymapFor(laneCount)];
      const clashIndex = current.indexOf(e.code);
      if (clashIndex !== -1 && clashIndex !== laneIndex) {
        showToast(`Phím "${codeToLabel(e.code)}" đang được dùng cho lane khác trong chế độ ${laneCount}K — chọn phím khác.`, "error");
        renderKeybindList();
        return;
      }

      current[laneIndex] = e.code;
      const custom = getCustomKeymaps();
      custom[laneCount] = current;
      localStorage.setItem(STORAGE_KEYMAPS, JSON.stringify(custom));
      // Force GameEngine/Editor to pick up the new mapping next time
      // they (re)initialize rather than keep using an already-bound keymap.
      gameplayInitialized = false;
      renderKeybindList();
    };

    function cleanup() {
      document.removeEventListener("keydown", handler, true);
      btn.classList.remove("keybind-btn--listening");
      rebindCleanup = null;
    }

    rebindCleanup = () => { btn.textContent = originalLabel; cleanup(); };
    document.addEventListener("keydown", handler, true); // capture phase: intercept before any other handler
  }

  document.querySelector('[data-action="go-settings"]')?.addEventListener("click", renderKeybindList);

  // ------------------------------------------------------------------
  // BACKGROUND — images/catalog.json lists whatever images the site
  // owner has placed under images/. Static hosting can't list a
  // directory's contents on its own, hence the manifest (same pattern
  // as beatmaps/catalog.json). One entry may set "default": true.
  // Only the chosen image is ever fetched — picking from a long list
  // doesn't cost bandwidth for images never selected.
  // ------------------------------------------------------------------
  const BG_CATALOG_URL = "images/catalog.json";
  const STORAGE_BG = "tant_background_id";
  let bgCatalog = [];
  const bgLayer = document.getElementById("bg-layer");
  const bgPickerGrid = document.getElementById("bg-picker-grid");
  const bgPickerEmptyHint = document.getElementById("bg-picker-empty-hint");

  async function loadBackgroundCatalog() {
    try {
      const res = await fetch(BG_CATALOG_URL);
      if (res.ok) bgCatalog = await res.json();
    } catch (err) {
      console.warn("Không tải được danh sách ảnh nền:", err);
    }

    bgPickerEmptyHint.style.display = bgCatalog.length ? "none" : "block";
    renderBackgroundPicker();

    const savedId = localStorage.getItem(STORAGE_BG);
    const chosen = bgCatalog.find((b) => b.id === savedId)
      || bgCatalog.find((b) => b.default)
      || null;
    applyBackground(chosen);
  }

  function applyBackground(entry) {
    if (entry) {
      bgLayer.style.backgroundImage = `url(images/${entry.file})`;
      document.documentElement.classList.add("has-bg-image");
    } else {
      bgLayer.style.backgroundImage = "";
      document.documentElement.classList.remove("has-bg-image");
    }
    renderBackgroundPicker(entry?.id ?? null);
  }

  function renderBackgroundPicker(selectedId) {
    bgPickerGrid.querySelectorAll(".bg-picker-thumb").forEach((el) => el.remove());

    // "None" option always available to go back to the plain gradient.
    const noneThumb = document.createElement("div");
    noneThumb.className = "bg-picker-thumb bg-picker-thumb--none" +
      (!selectedId ? " bg-picker-thumb--selected" : "");
    noneThumb.textContent = "Không dùng ảnh";
    noneThumb.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_BG);
      applyBackground(null);
    });
    bgPickerGrid.appendChild(noneThumb);

    bgCatalog.forEach((entry) => {
      const thumb = document.createElement("div");
      thumb.className = "bg-picker-thumb" + (entry.id === selectedId ? " bg-picker-thumb--selected" : "");
      thumb.style.backgroundImage = `url(images/${entry.file})`;
      thumb.innerHTML = `<span>${escapeHtml(entry.name || entry.id)}</span>`;
      thumb.addEventListener("click", () => {
        localStorage.setItem(STORAGE_BG, entry.id);
        applyBackground(entry);
      });
      bgPickerGrid.appendChild(thumb);
    });
  }

  // ------------------------------------------------------------------
  // SKIN — same catalog pattern as songs/backgrounds. Each entry
  // configures note shape/color for GameEngine (applySkin) and,
  // optionally, a small CSS file that retints the general UI accent
  // colors (buttons, glow, headers) via CSS custom properties.
  // ------------------------------------------------------------------
  const SKIN_CATALOG_URL = "skins/catalog.json";
  const STORAGE_SKIN = "tant_skin_id";
  let skinCatalog = [];
  let currentSkin = null; // the applied skin's full config object
  const skinPickerGrid = document.getElementById("skin-picker-grid");
  let skinThemeLinkEl = null; // created/removed dynamically, not a static <link> in index.html

  async function loadSkinCatalog() {
    try {
      const res = await fetch(SKIN_CATALOG_URL);
      if (res.ok) skinCatalog = await res.json();
    } catch (err) {
      console.warn("Không tải được danh sách skin:", err);
    }
    if (!skinCatalog.length) {
      // Hard fallback so the game never has zero skins even if the
      // catalog file is missing/broken — matches GameEngine's own
      // built-in defaults exactly.
      skinCatalog = [{ id: "default", name: "Mặc Định", noteShape: "flower",
        noteColor: "#ff9f6b", noteColorActive: "#ffe6d6", noteCenterColor: "#ffe6d6",
        holdColor: "#ff8a3d", particleColor: "#ffd76b", cssFile: null, default: true }];
    }

    const savedId = localStorage.getItem(STORAGE_SKIN);
    const chosen = skinCatalog.find((s) => s.id === savedId)
      || skinCatalog.find((s) => s.default)
      || skinCatalog[0];
    applySkinChoice(chosen);
  }

  function applySkinChoice(skin) {
    currentSkin = skin;

    if (skin.cssFile) {
      if (!skinThemeLinkEl) {
        skinThemeLinkEl = document.createElement("link");
        skinThemeLinkEl.rel = "stylesheet";
        skinThemeLinkEl.id = "skin-theme-link";
        document.head.appendChild(skinThemeLinkEl);
      }
      skinThemeLinkEl.href = skin.cssFile;
    } else if (skinThemeLinkEl) {
      skinThemeLinkEl.href = ""; // no theme override for this skin — clears the previous one
    }

    // Only affects the *next* GameEngine.start() call — see startGameplay(),
    // which calls GameEngine.applySkin(currentSkin) every time it runs.
    // If gameplay is already initialized and currently visible (e.g.
    // switching skins from the pause menu isn't wired up, but Settings
    // reachable mid-song via other means shouldn't silently no-op),
    // applying immediately is harmless — GameEngine.applySkin() itself
    // is safe to call at any time.
    if (gameplayInitialized) GameEngine.applySkin(skin);

    renderSkinPicker();
  }

  function renderSkinPicker() {
    skinPickerGrid.innerHTML = "";
    skinCatalog.forEach((skin) => {
      const card = document.createElement("div");
      card.className = "skin-picker-card" + (currentSkin?.id === skin.id ? " skin-picker-card--selected" : "");
      const shapeClass = `skin-swatch--${skin.noteShape || "flower"}`;
      card.innerHTML = `
        <div class="skin-swatch ${shapeClass}" style="background:${skin.noteColor || "#ff9f6b"}"></div>
        <span>${escapeHtml(skin.name || skin.id)}</span>
      `;
      card.addEventListener("click", () => {
        localStorage.setItem(STORAGE_SKIN, skin.id);
        applySkinChoice(skin);
      });
      skinPickerGrid.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  loadState();
  loadCatalog();
  loadBackgroundCatalog();
  loadSkinCatalog();
  initSettingsUI();
  Editor.init();
})();
