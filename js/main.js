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
  let builtinCatalog = [];       // [{id, title, artist, bpm, difficulty, duration, audioUrl, beatmapUrl}]
  let readySongId = null;        // id of the song currently loaded into AudioManager + state.currentBeatmap

  const fileInput = document.getElementById("song-file-input");
  const beatmapFileInput = document.getElementById("song-beatmap-input");
  const uploadPanel = document.getElementById("upload-panel");
  const uploadToggleBtn = document.getElementById("btn-upload-toggle");
  const uploadMp3Name = document.getElementById("upload-mp3-name");
  const uploadJsonName = document.getElementById("upload-json-name");
  const btnUploadConfirm = document.getElementById("btn-upload-confirm");
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
  });

  // mp3 alone → placeholder chart auto-generated so it's still playable;
  // mp3 + matching beatmap.json → chart plays exactly as authored.
  btnUploadConfirm.addEventListener("click", async () => {
    if (!pendingMp3File) return;
    await AudioManager.loadFile(pendingMp3File);

    const id = `upload_${Date.now()}`;
    const title = pendingMp3File.name.replace(/\.(mp3|wav)$/i, "");

    if (pendingBeatmapFile) {
      try {
        const text = await pendingBeatmapFile.text();
        state.currentBeatmap = JSON.parse(text);
      } catch (err) {
        alert("File beatmap.json không hợp lệ — dùng nốt tự động thay thế.");
        state.currentBeatmap = generatePlaceholderBeatmap(AudioManager.getDuration());
      }
    } else {
      state.currentBeatmap = generatePlaceholderBeatmap(AudioManager.getDuration());
    }

    state.library.unshift({ id, title, addedAt: Date.now(), source: "upload" });
    saveLibrary();
    state.selectedSongId = id;
    readySongId = id;

    // reset the pending panel for next time
    pendingMp3File = null;
    pendingBeatmapFile = null;
    fileInput.value = "";
    beatmapFileInput.value = "";
    uploadMp3Name.textContent = "Chưa chọn file";
    uploadJsonName.textContent = "Không có — sẽ tự tạo nốt ngẫu nhiên";
    btnUploadConfirm.disabled = true;
    uploadPanel.hidden = true;

    renderSongList();
    btnStartSong.disabled = false;
  });

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
      const meta = song.source === "builtin"
        ? `${tag} · ${song.difficulty || "?"} · ${song.bpm} BPM`
        : `${tag} · Đã thêm ${new Date(song.addedAt).toLocaleDateString("vi-VN")}`;
      card.innerHTML = `
        <div>
          <div class="song-card__title">${escapeHtml(song.title)}</div>
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
      // Only playable this session if it's the file just uploaded —
      // audio isn't persisted across reloads on a $0-backend site.
      btnStartSong.disabled = readySongId !== song.id;
      if (readySongId !== song.id) {
        songHighscoreEl.textContent += " — hãy tải lại file mp3 này để chơi";
      }
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
  // matching .json yet. Full custom charting happens in the Editor —
  // this just makes sure an upload is playable immediately.
  function generatePlaceholderBeatmap(durationSec, bpm = 120) {
    const notes = [];
    const beatSec = 60 / bpm;
    const laneCount = state.settings.keyMode;
    for (let t = 2; t < durationSec - 2; t += beatSec) {
      if (Math.random() < 0.6) {
        const lane = Math.floor(Math.random() * laneCount);
        const isHold = Math.random() < 0.15;
        notes.push(isHold
          ? { time: t, lane, type: "hold", duration: beatSec * 2 }
          : { time: t, lane, type: "tap" });
      }
    }
    return { songTitle: "Placeholder", bpm, offset: 0, notes };
  }

  btnStartSong.addEventListener("click", () => {
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

  function startGameplay() {
    goScreen("screen-gameplay");
    AudioManager.ensureContext();
    AudioManager.setVolume(state.settings.musicVolume);

    if (!gameplayInitialized) {
      GameEngine.init(canvas, {
        laneCount: state.settings.keyMode,
        keymap: GameEngine.KEYMAPS[state.settings.keyMode],
        noteSpeed: state.settings.noteSpeed,
        getSongTime: AudioManager.getSongTime,
        onFinish: handleSongFinish,
      });
      gameplayInitialized = true;
    } else {
      GameEngine.setNoteSpeed(state.settings.noteSpeed);
      GameEngine.resize();
    }

    document.getElementById("hud-song-title").textContent =
      combinedSongList().find((s) => s.id === state.selectedSongId)?.title || "—";

    GameEngine.loadBeatmap(state.currentBeatmap);
    AudioManager.play(0);
    GameEngine.start();
  }

  function handleSongFinish(stats) {
    AudioManager.stop();
    if (state.selectedSongId) setHighScore(state.selectedSongId, stats);

    document.getElementById("result-rank").textContent = stats.rank;
    document.getElementById("result-song-title").textContent =
      combinedSongList().find((s) => s.id === state.selectedSongId)?.title || "—";
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
  });

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
  // Boot
  // ------------------------------------------------------------------
  loadState();
  loadCatalog();
  loadBackgroundCatalog();
  initSettingsUI();
  Editor.init();
})();
