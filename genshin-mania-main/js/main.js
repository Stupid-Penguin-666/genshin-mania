/* ==========================================================================
   MAIN.JS
   App shell: screen navigation, song library, play sessions (start,
   pause, resume, finish), settings, calibration, background and skin.
   Gameplay itself lives in engine.js; audio clock in audio.js; the cloud
   catalog in beatmaps.js.

   Exposes window.App for the editor and the Download Beatmaps screen.
   ========================================================================== */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const LEAD_IN_S = 2;          // silent run-up so the first notes fall into view
  const RESUME_COUNTDOWN_S = 3;

  // ------------------------------------------------------------------
  // Storage
  // ------------------------------------------------------------------
  const KEY = {
    library: "tant_library",
    highscores: "tant_highscores",
    settings: "tant_settings",
    keymaps: "tant_keymaps",
    background: "tant_background_id",
    skin: "tant_skin_id",
  };

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked or full */ }
  }

  const DEFAULT_SETTINGS = {
    language: "en",
    musicVolume: 80,
    sfxVolume: 90,
    noteSpeed: 10,
    keyMode: 6,          // default for new songs and the editor; each song plays in its own key count
    connectors: true,
    lowLag: false,
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    library: [],              // saved songs: metadata only, files live in IndexedDB
    selectedSongId: null,
  };

  function loadState() {
    const saved = readJson(KEY.settings, null);
    if (saved && typeof saved === "object") state.settings = { ...DEFAULT_SETTINGS, ...saved };
    if (!ChartGen.SUPPORTED_KEYS.includes(state.settings.keyMode)) state.settings.keyMode = 6;
    const lib = readJson(KEY.library, []);
    state.library = Array.isArray(lib) ? lib.filter((s) => s && s.id && s.title) : [];
    AudioManager.loadStoredOffset();
    AudioManager.setVolume(state.settings.musicVolume);
    AudioManager.setSfxVolume(state.settings.sfxVolume);
    I18n.setLang(state.settings.language);
  }
  const saveSettings = () => writeJson(KEY.settings, state.settings);
  const saveLibrary = () => writeJson(KEY.library, state.library);

  // Saved audio + beatmap live in IndexedDB so they survive a reload.
  // If IndexedDB is unavailable (some private modes) songs fall back to a
  // session-only cache and the player is told.
  const SongStore = (() => {
    let dbPromise = null;
    const sessionCache = new Map();

    function open() {
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
          const req = indexedDB.open("tant-songs", 1);
          req.onupgradeneeded = () => req.result.createObjectStore("songs", { keyPath: "id" });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      }
      return dbPromise;
    }

    async function run(mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("songs", mode);
        const req = fn(tx.objectStore("songs"));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    }

    return {
      async put(rec) {
        sessionCache.set(rec.id, rec);
        try { await run("readwrite", (s) => s.put(rec)); return true; } catch { return false; }
      },
      async get(id) {
        if (sessionCache.has(id)) return sessionCache.get(id);
        try { return (await run("readonly", (s) => s.get(id))) || null; } catch { return null; }
      },
      async del(id) {
        sessionCache.delete(id);
        try { await run("readwrite", (s) => s.delete(id)); } catch { /* nothing to remove */ }
      },
      async clear() {
        sessionCache.clear();
        try { await run("readwrite", (s) => s.clear()); } catch { /* nothing to remove */ }
      },
    };
  })();

  // ------------------------------------------------------------------
  // Text helpers
  // ------------------------------------------------------------------
  // Turns any error the app can throw into a sentence in the current language.
  function describeError(err) {
    if (err instanceof ChartGen.ChartError) return t(`err.${err.code}`, err.params);
    if (err instanceof Cloud.CloudError) return t(`cloud.err.${err.code}`, { detail: err.detail });
    return (err && err.message) || t("err.unknown");
  }

  function difficultyLabel(code) {
    if (!code) return "";
    const key = `diff.${String(code).toLowerCase()}`;
    const label = t(key);
    return label === key ? String(code) : label;
  }

  const formatNumber = (n) => Number(n).toLocaleString(I18n.locale());
  const formatTime = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

  // ------------------------------------------------------------------
  // Navigation
  // ------------------------------------------------------------------
  const onEnter = {};
  const onLeave = {};

  function goScreen(id) {
    const current = document.querySelector(".screen--active");
    if (current && current.id !== id) onLeave[current.id]?.();
    document.querySelectorAll(".screen").forEach((el) => el.classList.remove("screen--active"));
    $(id).classList.add("screen--active");
    onEnter[id]?.();
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (!el) return;
    const action = el.dataset.action;
    if (action.startsWith("go-")) goScreen("screen-" + action.slice(3));
  });

  // Arrow keys move through the main menu like the in-game one.
  $("menu-nav").addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...$("menu-nav").querySelectorAll(".nav-item")];
    const i = items.indexOf(document.activeElement);
    const next = items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    next.focus();
    e.preventDefault();
  });

  // ------------------------------------------------------------------
  // Keymaps (per key count). Shared with the editor through localStorage.
  // ------------------------------------------------------------------
  function getKeymapFor(laneCount) {
    const saved = readJson(KEY.keymaps, {})[laneCount];
    return (Array.isArray(saved) && saved.length === laneCount) ? saved : GameEngine.KEYMAPS[laneCount];
  }

  // ------------------------------------------------------------------
  // High scores
  // ------------------------------------------------------------------
  const getHighScore = (songId) => readJson(KEY.highscores, {})[songId] || null;

  // Returns true when this run beat the stored best (or was the first).
  function saveHighScore(songId, stats) {
    const all = readJson(KEY.highscores, {});
    const prev = all[songId];
    if (prev && stats.score <= prev.score) return false;
    all[songId] = { score: stats.score, rank: stats.rank, accuracy: stats.accuracy, maxCombo: stats.maxCombo };
    writeJson(KEY.highscores, all);
    return true;
  }

  // ==================================================================
  // SONG LIBRARY
  // ==================================================================
  const CATALOG_URL = "beatmaps/catalog.json";
  let builtinCatalog = [];
  let ready = null;          // { songId, beatmap, buffer, duration } for the selected song
  let selectToken = 0;       // guards against out-of-order async loads
  let lastDetail = null;     // what the detail panel shows, so a language change can redraw it

  const songListEl = $("song-list");
  const detailEmpty = $("song-detail-empty");
  const detailBody = $("song-detail-body");
  const btnStartSong = $("btn-start-song");
  const btnDeleteSong = $("btn-delete-song");

  async function loadCatalog() {
    try {
      const res = await fetch(CATALOG_URL);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) builtinCatalog = data.filter((s) => s && s.id && s.audioUrl && s.beatmapUrl);
      }
    } catch (err) {
      console.warn("Could not load the built-in song list:", err);
    }
    renderSongList();
  }

  function allSongs() {
    const builtins = builtinCatalog.map((s) => ({ ...s, source: "builtin", laneCount: s.laneCount || 6 }));
    const uploads = state.library.map((s) => ({ ...s, source: "upload", laneCount: s.laneCount || 6 }));
    return [...builtins, ...uploads];
  }
  const findSong = (id) => allSongs().find((s) => s.id === id) || null;

  function songMeta(song) {
    if (song.source === "builtin" || song.cloudId) {
      return [song.artist, difficultyLabel(song.difficulty), song.bpm ? `${song.bpm} BPM` : ""].filter(Boolean).join(" · ")
        || t("song.builtin");
    }
    const date = song.addedAt ? new Date(song.addedAt).toLocaleDateString(I18n.locale()) : "";
    return [t("song.uploaded"), date].filter(Boolean).join(" · ");
  }

  function renderSongList() {
    const songs = allSongs();
    songListEl.replaceChildren();

    if (!songs.length) {
      const empty = document.createElement("div");
      empty.className = "song-list__empty";
      const p = document.createElement("p");
      p.textContent = t("song.empty");
      const btn = document.createElement("button");
      btn.className = "btn btn--primary";
      btn.textContent = t("song.add");
      btn.addEventListener("click", openUploadModal);
      empty.append(p, btn);
      songListEl.appendChild(empty);
      return;
    }

    const bests = readJson(KEY.highscores, {});
    songs.forEach((song) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "song-card";
      card.setAttribute("role", "option");
      card.setAttribute("aria-selected", String(song.id === state.selectedSongId));

      const main = document.createElement("span");
      main.className = "song-card__main";
      const title = document.createElement("b");
      title.className = "song-card__title";
      title.textContent = song.title;
      const meta = document.createElement("small");
      meta.className = "song-card__meta";
      meta.textContent = songMeta(song);
      main.append(title, meta);

      const side = document.createElement("span");
      side.className = "song-card__side";
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = `${song.laneCount}K`;
      side.appendChild(chip);
      const best = bests[song.id];
      if (best) {
        const rank = document.createElement("span");
        rank.className = "song-card__rank";
        rank.textContent = best.rank;
        side.appendChild(rank);
      }

      card.append(main, side);
      card.addEventListener("click", () => selectSong(song));
      songListEl.appendChild(card);
    });
  }

  function setHint(text) { $("detail-hint").textContent = text || ""; }

  function renderDetail(song, status, message) {
    lastDetail = { song, status, message };
    detailEmpty.hidden = true;
    detailBody.hidden = false;

    $("detail-source").textContent = song.source === "builtin" ? t("song.builtin")
      : song.cloudId ? t("song.cloud") : t("song.uploaded");
    $("detail-title").textContent = song.title;

    const isReady = ready && ready.songId === song.id;
    const keys = isReady ? ready.beatmap.laneCount : song.laneCount;
    const chips = $("detail-chips");
    chips.replaceChildren();
    const addChip = (text) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = text;
      chips.appendChild(c);
    };
    addChip(`${keys}K`);
    if (song.bpm) addChip(`${song.bpm} BPM`);
    if (song.difficulty) addChip(difficultyLabel(song.difficulty));
    if (isReady && ready.duration) addChip(formatTime(ready.duration));

    const best = getHighScore(song.id);
    const bestEl = $("detail-best");
    bestEl.replaceChildren();
    if (best) {
      bestEl.append(`${t("song.best")} `);
      const b = document.createElement("b");
      b.textContent = formatNumber(best.score);
      bestEl.append(b, ` · ${t("song.rank", { rank: best.rank })} · ${best.accuracy.toFixed(1)}%`);
    } else {
      bestEl.textContent = t("song.noScore");
    }

    btnDeleteSong.hidden = song.source !== "upload";
    btnStartSong.disabled = status !== "ready";
    if (status === "loading") setHint(t("song.loading"));
    else if (status === "error") setHint(message || t("song.loadError"));
    else setHint("");
  }

  // Everything needed to play a song, loaded without touching global audio
  // state, so a slow load of song A can never replace the choice of song B.
  async function loadSongAssets(song) {
    if (song.source === "builtin") {
      const [rawText, buffer] = await Promise.all([
        fetch(song.beatmapUrl).then((r) => {
          if (!r.ok) throw new Error(t("song.beatmapMissing", { status: r.status }));
          return r.text();
        }),
        AudioManager.decodeUrl(song.audioUrl),
      ]);
      let raw;
      try { raw = JSON.parse(rawText); } catch { throw new Error(t("song.beatmapBad")); }
      return { beatmap: ChartGen.validateBeatmap(raw), buffer };
    }

    const rec = await SongStore.get(song.id);
    if (!rec || !rec.file) throw new Error(t("song.noFile"));
    let buffer;
    try { buffer = await AudioManager.decodeFile(rec.file); }
    catch { throw new Error(t("up.badAudio")); }
    return { beatmap: ChartGen.validateBeatmap(rec.beatmap), buffer };
  }

  async function selectSong(song) {
    const token = ++selectToken;
    state.selectedSongId = song.id;
    ready = null;
    renderSongList();
    renderDetail(song, "loading");
    try {
      const { beatmap, buffer } = await loadSongAssets(song);
      if (token !== selectToken) return;
      ready = { songId: song.id, beatmap, buffer, duration: buffer.duration };
      renderDetail(song, "ready");
      syncPracticeDefaults();
    } catch (err) {
      if (token !== selectToken) return;
      console.error(err);
      renderDetail(song, "error", describeError(err));
    }
  }

  // ---- practice + autoplay toggles ----
  const practiceToggle = $("practice-toggle");
  const practiceStart = $("practice-start");
  const practiceEnd = $("practice-end");

  function syncPracticeDefaults() {
    if (!ready) return;
    const max = Math.floor(ready.duration);
    practiceEnd.max = String(max);
    practiceStart.max = String(Math.max(0, max - 1));
    if (!(+practiceEnd.value > +practiceStart.value) || +practiceEnd.value > max) {
      practiceStart.value = "0";
      practiceEnd.value = String(Math.min(max, 30));
    }
  }
  practiceToggle.addEventListener("change", () => {
    $("practice-range").hidden = !practiceToggle.checked;
    syncPracticeDefaults();
  });

  // ---- delete ----
  btnDeleteSong.addEventListener("click", async () => {
    const song = findSong(state.selectedSongId);
    if (!song || song.source !== "upload") return;
    const ok = await UI.confirm({
      title: t("song.deleteTitle"),
      text: t("song.deleteText", { title: song.title }),
      okLabel: t("song.deleteBtn"), danger: true,
    });
    if (!ok) return;
    await SongStore.del(song.id);
    state.library = state.library.filter((s) => s.id !== song.id);
    saveLibrary();
    clearSelection();
    renderSongList();
  });

  $("btn-clear-library").addEventListener("click", async () => {
    if (!state.library.length) { UI.toast(t("song.clearNone")); return; }
    const ok = await UI.confirm({
      title: t("song.clearTitle"),
      text: t("song.clearText"),
      okLabel: t("song.clearOk"), danger: true,
    });
    if (!ok) return;
    await SongStore.clear();
    state.library = [];
    saveLibrary();
    clearSelection();
    renderSongList();
  });

  function clearSelection() {
    selectToken++;
    state.selectedSongId = null;
    ready = null;
    lastDetail = null;
    detailBody.hidden = true;
    detailEmpty.hidden = false;
    btnStartSong.disabled = true;
  }

  // ---- upload modal ----
  const uploadModal = $("upload-modal");
  const fileInput = $("song-file-input");
  const beatmapInput = $("song-beatmap-input");
  const btnUploadConfirm = $("btn-upload-confirm");
  let pendingMp3 = null;
  let pendingBeatmap = null;

  function updateUploadTexts() {
    $("upload-mp3-name").textContent = pendingMp3 ? pendingMp3.name : t("up.noFile");
    $("upload-json-name").textContent = pendingBeatmap ? pendingBeatmap.name : t("up.noBeatmap");
  }

  function openUploadModal() {
    pendingMp3 = null;
    pendingBeatmap = null;
    fileInput.value = "";
    beatmapInput.value = "";
    $("upload-keys").value = String(state.settings.keyMode);
    btnUploadConfirm.disabled = true;
    btnUploadConfirm.textContent = t("up.confirm");
    updateUploadTexts();
    updateAutogenVisibility();
    UI.openModal(uploadModal);
  }
  $("btn-upload-open").addEventListener("click", openUploadModal);
  $("btn-upload-cancel").addEventListener("click", () => UI.closeModal(uploadModal));

  function updateAutogenVisibility() {
    $("upload-autogen").hidden = !!pendingBeatmap;
    $("upload-onset-options").hidden = $("upload-genmode").value !== "onset";
  }
  $("upload-genmode").addEventListener("change", updateAutogenVisibility);

  fileInput.addEventListener("change", (e) => {
    pendingMp3 = e.target.files[0] || null;
    updateUploadTexts();
    btnUploadConfirm.disabled = !pendingMp3;
  });
  beatmapInput.addEventListener("change", (e) => {
    pendingBeatmap = e.target.files[0] || null;
    updateUploadTexts();
    updateAutogenVisibility();
  });

  async function buildBeatmapForUpload(file, buffer) {
    const bpm = +$("upload-bpm").value || 120;
    const offsetMs = +$("upload-offset").value || 0;
    const noteType = $("upload-notetype").value;
    const laneCount = +$("upload-keys").value;
    const grid = () => ChartGen.generateGridChart(buffer.duration, bpm, noteType, laneCount, offsetMs);

    if (pendingBeatmap) {
      try {
        const chart = ChartGen.validateBeatmap(JSON.parse(await pendingBeatmap.text()));
        if (chart.dropped) UI.toast(t("up.dropped", { n: chart.dropped }), "error", 5000);
        if (chart.adjusted) UI.toast(t("up.adjusted", { n: chart.adjusted }), "info", 5000);
        return chart;
      } catch (err) {
        const reason = err instanceof SyntaxError ? t("song.beatmapBad") : describeError(err);
        UI.toast(t("up.badBeatmap", { reason }), "error", 5200);
        return grid();
      }
    }
    if ($("upload-genmode").value === "onset") {
      try {
        const chart = await ChartGen.generateOnsetChart(file, {
          bpm, offsetMs, noteType, laneCount,
          sensitivity: $("upload-sensitivity").value,
          snapDivisor: +$("upload-snap").value,
          minDistanceMs: +$("upload-mindist").value || 120,
          maxNotesPerSec: +$("upload-maxrate").value || 6,
        });
        if (chart.notes.length) return chart;
        UI.toast(t("up.noOnsets"), "error", 5000);
      } catch (err) {
        console.error(err);
        UI.toast(t("up.onsetFail"), "error");
      }
    }
    return grid();
  }

  // Shared by the upload dialog, the editor and the cloud downloader.
  // `meta` carries optional extras such as artist, difficulty and cloudId.
  async function addSong({ file, beatmap, title, meta = {} }) {
    const clean = ChartGen.validateBeatmap(beatmap);
    const id = `upload_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const persisted = await SongStore.put({ id, file, beatmap: clean });
    state.library.unshift({
      id, title, addedAt: Date.now(), laneCount: clean.laneCount, bpm: Math.round(clean.bpm), ...meta,
    });
    saveLibrary();
    renderSongList();
    if (!persisted) UI.toast(t("song.storeFail"), "error", 5200);
    return id;
  }

  btnUploadConfirm.addEventListener("click", async () => {
    if (!pendingMp3) return;
    btnUploadConfirm.disabled = true;
    btnUploadConfirm.textContent = t("up.working");
    try {
      let buffer;
      try { buffer = await AudioManager.decodeFile(pendingMp3); }
      catch { UI.toast(t("up.badAudio"), "error"); return; }

      const beatmap = await buildBeatmapForUpload(pendingMp3, buffer);
      const title = pendingMp3.name.replace(/\.[a-z0-9]+$/i, "");
      const id = await addSong({ file: pendingMp3, beatmap, title });
      UI.closeModal(uploadModal);
      const song = findSong(id);
      if (song) selectSong(song);
    } catch (err) {
      console.error(err);
      UI.toast(describeError(err), "error");
    } finally {
      btnUploadConfirm.textContent = t("up.confirm");
      btnUploadConfirm.disabled = !pendingMp3;
    }
  });

  // ---- start button ----
  btnStartSong.addEventListener("click", () => {
    const song = findSong(state.selectedSongId);
    if (!song || !ready || ready.songId !== song.id) return;

    let loop = null;
    if (practiceToggle.checked) {
      const start = Math.max(0, +practiceStart.value || 0);
      const end = +practiceEnd.value || 0;
      if (!(end > start)) { UI.toast(t("song.practiceOrder"), "error"); return; }
      if (end > ready.duration) { UI.toast(t("song.practiceTooLong", { sec: ready.duration.toFixed(1) }), "error"); return; }
      loop = { start, end };
    }

    // The song decides how many keys are used; the keys bound for that
    // layout are picked up automatically.
    startSession({
      songId: song.id,
      title: song.title,
      beatmap: ready.beatmap,
      buffer: ready.buffer,
      laneCount: ready.beatmap.laneCount,
      autoplay: $("autoplay-toggle").checked,
      loop,
      returnScreen: "screen-songselect",
      isTest: false,
    });
  });

  // ==================================================================
  // PLAY SESSION
  // ==================================================================
  const canvas = $("game-canvas");
  const pauseOverlay = $("pause-overlay");
  const countdownEl = $("countdown");
  const keyRow = $("key-row");

  let session = null;
  let paused = false;
  let countdownTimer = null;

  const isGameplayActive = () => $("screen-gameplay").classList.contains("screen--active");

  function startSession(next) {
    session = next;
    beginPlay();
  }

  function beginPlay() {
    const s = session;
    if (!s) return;
    cancelCountdown();
    paused = false;
    pauseOverlay.hidden = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

    goScreen("screen-gameplay");
    AudioManager.ensureContext();
    AudioManager.setVolume(state.settings.musicVolume);
    AudioManager.setSfxVolume(state.settings.sfxVolume);
    if (s.buffer) AudioManager.useBuffer(s.buffer);

    GameEngine.stop();
    GameEngine.init(canvas, {
      laneCount: s.laneCount,
      keymap: getKeymapFor(s.laneCount),
      noteSpeed: state.settings.noteSpeed,
      getSongTime: AudioManager.getSongTime,
      getDuration: AudioManager.getDuration,
      onFinish: handleFinish,
      connectors: state.settings.connectors,
      lowLag: state.settings.lowLag,
      skin: currentSkin || undefined,
    });
    $("hud-song-title").textContent = s.title;
    GameEngine.loadBeatmap(s.beatmap);
    GameEngine.setAutoplay(s.autoplay);

    // Always set or clear the loop: the engine keeps it as module state, so a
    // stale practice region would otherwise leak into a normal run.
    GameEngine.setLoopRegion(s.loop
      ? { start: s.loop.start, end: s.loop.end, onLoop: () => AudioManager.play(s.loop.start - 1) }
      : null);

    AudioManager.play(s.loop ? s.loop.start - 1 : -LEAD_IN_S);
    GameEngine.start();
  }

  // ---- touch / pointer input on the key buttons ----
  const pointerLanes = new Map();
  keyRow.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(".key-indicator");
    if (!el || paused) return;
    e.preventDefault();
    const lane = +el.dataset.lane;
    pointerLanes.set(e.pointerId, lane);
    el.setPointerCapture?.(e.pointerId);
    GameEngine.handleLaneDown(lane, e.timeStamp);
  });
  const releasePointer = (e) => {
    const lane = pointerLanes.get(e.pointerId);
    if (lane === undefined) return;
    pointerLanes.delete(e.pointerId);
    GameEngine.handleLaneUp(lane, e.timeStamp);
  };
  keyRow.addEventListener("pointerup", releasePointer);
  keyRow.addEventListener("pointercancel", releasePointer);

  // ---- input method (IME) detection ----
  // Vietnamese input methods such as Unikey can swallow or rewrite quick
  // repeated presses of one key before the browser ever sees them, so the
  // page cannot repair that. What it can do is notice the signs and say so.
  const looksLikeIme = (e) => e.key === "Process" || e.isComposing || e.keyCode === 229;
  let imeWarned = false;
  function warnIme() {
    if (imeWarned) return;
    imeWarned = true;
    UI.toast(t("ime.toast"), "error", 8000);
  }

  // ---- keyboard input ----
  document.addEventListener("keydown", (e) => {
    if (!isGameplayActive()) return;
    if (e.code === "Escape") {
      e.preventDefault();
      if (!e.repeat) { paused && !countdownTimer ? resumeGame() : pauseGame(); }
      return;
    }
    if (looksLikeIme(e) || (e.key === "Backspace" && !paused)) warnIme();
    if (e.repeat || paused || e.ctrlKey || e.metaKey || e.altKey) return;
    if (GameEngine.hasKey(e.code)) {
      e.preventDefault();
      GameEngine.handleKeyDown(e.code, e.timeStamp);
    }
  });
  document.addEventListener("keyup", (e) => {
    if (!isGameplayActive() || paused) return;
    if (GameEngine.hasKey(e.code)) GameEngine.handleKeyUp(e.code, e.timeStamp);
  });

  // ---- pause / resume ----
  function pauseGame() {
    if (!session || !isGameplayActive() || !GameEngine.isRunning()) return;
    if (paused && !countdownTimer) return;
    cancelCountdown();
    if (!paused) {
      paused = true;
      GameEngine.pause();      // before the audio pause, so held notes grade at the right time
      AudioManager.pause();
    }
    pauseOverlay.hidden = false;
    $("btn-resume").focus({ preventScroll: true });
  }

  function resumeGame() {
    if (!paused || countdownTimer) return;
    pauseOverlay.hidden = true;
    let n = RESUME_COUNTDOWN_S;
    const tick = () => {
      if (n === 0) {
        countdownTimer = null;
        countdownEl.hidden = true;
        paused = false;
        AudioManager.resume();
        GameEngine.resume();
        return;
      }
      showCountdown(n);
      n--;
      countdownTimer = setTimeout(tick, 800);
    };
    tick();
  }

  function showCountdown(n) {
    countdownEl.hidden = false;
    const b = document.createElement("b");
    b.textContent = n;
    countdownEl.replaceChildren(b); // a fresh element restarts the animation
  }

  function cancelCountdown() {
    clearTimeout(countdownTimer);
    countdownTimer = null;
    countdownEl.hidden = true;
  }

  $("btn-pause").addEventListener("click", pauseGame);
  $("btn-resume").addEventListener("click", resumeGame);
  $("btn-restart").addEventListener("click", beginPlay);
  $("btn-quit").addEventListener("click", () => leaveSession());

  function leaveSession() {
    cancelCountdown();
    GameEngine.stop();
    AudioManager.stop();
    paused = false;
    pauseOverlay.hidden = true;
    goScreen(session ? session.returnScreen : "screen-mainmenu");
  }

  // A run should never keep going while nobody is watching it.
  window.addEventListener("blur", () => { if (!paused) pauseGame(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && !paused) pauseGame(); });

  // ---- finish ----
  function handleFinish(stats) {
    AudioManager.stop();
    const s = session;

    if (s.isTest) {
      UI.toast(t("game.testDone", { rank: stats.rank, acc: stats.accuracy.toFixed(1), combo: stats.maxCombo }), "success", 4200);
      goScreen(s.returnScreen);
      return;
    }

    const counted = !s.autoplay && !s.loop && s.songId;
    const isNewBest = counted ? saveHighScore(s.songId, stats) : false;

    $("result-rank").textContent = stats.rank;
    $("result-song-title").textContent = s.autoplay ? `${s.title} (Autoplay)` : s.title;
    $("result-perfect").textContent = stats.perfect;
    $("result-great").textContent = stats.great;
    $("result-miss").textContent = stats.miss;
    $("result-maxcombo").textContent = stats.maxCombo;
    $("result-accuracy").textContent = `${stats.accuracy.toFixed(1)}%`;
    $("result-score").textContent = formatNumber(stats.score);

    const badges = [];
    if (isNewBest) badges.push(t("result.newBest"));
    if (stats.allPerfect) badges.push("All Perfect");
    else if (stats.fullCombo) badges.push("Full Combo");
    if (s.autoplay || s.loop) badges.push(t("result.noRecord"));
    $("result-badges").textContent = badges.join(" · ");

    const bar = $("result-acc-bar");
    bar.style.width = "0";
    goScreen("screen-result");
    requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = `${stats.accuracy.toFixed(1)}%`; }));
  }

  $("btn-retry").addEventListener("click", beginPlay);
  $("btn-result-back").addEventListener("click", () => goScreen("screen-songselect"));

  onEnter["screen-songselect"] = renderSongList;

  // ==================================================================
  // SETTINGS
  // ==================================================================
  function paintSlider(input) {
    const min = +input.min || 0, max = +input.max || 100;
    input.style.setProperty("--p", `${((+input.value - min) / (max - min)) * 100}%`);
  }

  function bindSlider(inputId, outId, key, apply) {
    const input = $(inputId), out = $(outId);
    input.addEventListener("input", () => {
      state.settings[key] = +input.value;
      out.textContent = input.value;
      paintSlider(input);
      apply?.(state.settings[key]);
      saveSettings();
    });
  }
  bindSlider("setting-music-volume", "out-music-volume", "musicVolume", AudioManager.setVolume);
  bindSlider("setting-sfx-volume", "out-sfx-volume", "sfxVolume", AudioManager.setSfxVolume);

  function setNoteSpeed(v) {
    state.settings.noteSpeed = Math.max(5, Math.min(20, v));
    $("out-note-speed").textContent = state.settings.noteSpeed;
    saveSettings();
  }
  $("btn-speed-minus").addEventListener("click", () => setNoteSpeed(state.settings.noteSpeed - 1));
  $("btn-speed-plus").addEventListener("click", () => setNoteSpeed(state.settings.noteSpeed + 1));

  const offsetInput = $("setting-offset");
  function setOffset(ms) {
    offsetInput.value = AudioManager.saveOffset(ms);
    $("calib-current").textContent = `${AudioManager.getOffsetMs()} ms`;
  }
  $("btn-offset-minus").addEventListener("click", () => setOffset(AudioManager.getOffsetMs() - 5));
  $("btn-offset-plus").addEventListener("click", () => setOffset(AudioManager.getOffsetMs() + 5));
  offsetInput.addEventListener("change", () => setOffset(+offsetInput.value));

  function bindToggle(id, key) {
    const el = $(id);
    el.addEventListener("change", () => { state.settings[key] = el.checked; saveSettings(); });
  }
  bindToggle("setting-connectors", "connectors");
  bindToggle("setting-lowlag", "lowLag");

  $("setting-keymode").addEventListener("change", (e) => {
    state.settings.keyMode = +e.target.value;
    saveSettings();
  });

  $("setting-language").addEventListener("change", (e) => {
    state.settings.language = e.target.value;
    saveSettings();
    I18n.setLang(state.settings.language);
  });

  function syncSettingsUI() {
    const s = state.settings;
    $("setting-music-volume").value = s.musicVolume;
    $("out-music-volume").textContent = s.musicVolume;
    paintSlider($("setting-music-volume"));
    $("setting-sfx-volume").value = s.sfxVolume;
    $("out-sfx-volume").textContent = s.sfxVolume;
    paintSlider($("setting-sfx-volume"));
    $("out-note-speed").textContent = s.noteSpeed;
    $("setting-keymode").value = s.keyMode;
    $("setting-connectors").checked = s.connectors;
    $("setting-lowlag").checked = s.lowLag;
    $("setting-language").value = s.language;
    offsetInput.value = AudioManager.getOffsetMs();
    renderKeys();
  }

  // ---- tabs ----
  function showTab(name) {
    document.querySelectorAll(".side-nav__item").forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === name));
    if (name === "look") renderSkinPicker();
    if (name !== "keys") cancelRebind();
  }
  document.querySelectorAll(".side-nav__item").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  onEnter["screen-settings"] = () => { keysMode = state.settings.keyMode; syncSettingsUI(); };
  onLeave["screen-settings"] = () => cancelRebind();
  onLeave["screen-editor"] = () => Editor.suspend();
  onEnter["screen-editor"] = () => Editor.onEnter();
  onEnter["screen-beatmaps"] = () => Beatmaps.onEnter();

  // ---- key bindings ----
  // The layout being edited (4K, 6K or 8K) is independent of the default.
  let keysMode = state.settings.keyMode;
  const keybindList = $("keybind-list");
  const keyPreview = $("key-preview");
  let rebind = null; // { handler }
  const RESERVED_CODES = new Set(["Tab", "Enter", "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
    "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "ContextMenu"]);

  function renderKeys() {
    const keymap = getKeymapFor(keysMode);
    $("keys-mode").querySelectorAll("[data-keys]").forEach((b) => b.classList.toggle("is-active", +b.dataset.keys === keysMode));
    keybindList.replaceChildren();
    keyPreview.replaceChildren();

    keymap.forEach((code, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row row--key";
      const label = document.createElement("span");
      label.textContent = t("set.keyN", { n: i + 1 });
      const chip = document.createElement("span");
      chip.className = "key-chip";
      chip.textContent = UI.keyLabel(code);
      row.append(label, chip);
      row.addEventListener("click", () => startRebind(keysMode, i));
      keybindList.appendChild(row);

      const lane = document.createElement("div");
      lane.className = "kp-lane";
      const dot = document.createElement("span");
      dot.className = "kp-dot";
      const key = document.createElement("span");
      key.className = "kp-key";
      key.textContent = UI.keyLabel(code);
      lane.append(dot, key);
      keyPreview.appendChild(lane);
    });
  }

  $("keys-mode").querySelectorAll("[data-keys]").forEach((b) => b.addEventListener("click", () => {
    cancelRebind();
    keysMode = +b.dataset.keys;
    renderKeys();
  }));

  function cancelRebind() {
    if (!rebind) return;
    document.removeEventListener("keydown", rebind.handler, true);
    rebind = null;
    renderKeys();
  }

  function startRebind(laneCount, laneIndex) {
    cancelRebind();
    keybindList.children[laneIndex].classList.add("is-listening");
    keybindList.children[laneIndex].querySelector(".key-chip").textContent = "...";
    keyPreview.children[laneIndex]?.classList.add("is-listening");

    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") { cancelRebind(); return; }
      if (RESERVED_CODES.has(e.code)) { UI.toast(t("set.keyReserved"), "error"); return; }

      const current = [...getKeymapFor(laneCount)];
      const clash = current.indexOf(e.code);
      if (clash !== -1 && clash !== laneIndex) {
        UI.toast(t("set.keyClash", { key: UI.keyLabel(e.code), lane: clash + 1 }), "error");
        return;
      }
      current[laneIndex] = e.code;
      const all = readJson(KEY.keymaps, {});
      all[laneCount] = current;
      writeJson(KEY.keymaps, all);
      cancelRebind();
    };
    rebind = { handler };
    document.addEventListener("keydown", handler, true);
  }

  $("btn-keys-reset").addEventListener("click", () => {
    cancelRebind();
    const all = readJson(KEY.keymaps, {});
    delete all[keysMode];
    writeJson(KEY.keymaps, all);
    renderKeys();
  });

  // ---- key test: shows exactly what the browser receives ----
  const keyTest = { code: "", count: 0 };
  document.addEventListener("keydown", (e) => {
    if (rebind || !$("screen-settings").classList.contains("screen--active")) return;
    if (!document.querySelector('.tab-panel[data-panel="keys"]').classList.contains("is-active")) return;
    if (e.code === "Tab") return;
    keyTest.count = e.code === keyTest.code && e.timeStamp - (keyTest.at || 0) < 1500 ? keyTest.count + 1 : 1;
    keyTest.code = e.code;
    keyTest.at = e.timeStamp;
    $("key-test-out").textContent = `${UI.keyLabel(e.code)}${keyTest.count > 1 ? `  ×${keyTest.count}` : ""}`;
    $("key-test-detail").textContent = `code: ${e.code || "(none)"}   key: ${e.key}${e.repeat ? "   repeat" : ""}${e.isComposing ? "   composing" : ""}`;
    $("key-test-warn").hidden = !looksLikeIme(e);
    if (looksLikeIme(e)) e.preventDefault();
  });

  // ---- background ----
  const BG_CATALOG_URL = "images/catalog.json";
  let bgCatalog = [];
  let bgSelectedId = null;

  async function loadBackgroundCatalog() {
    try {
      const res = await fetch(BG_CATALOG_URL);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) bgCatalog = data.filter((b) => b && b.id && b.file);
      }
    } catch (err) {
      console.warn("Could not load the background list:", err);
    }
    $("bg-picker-empty-hint").hidden = bgCatalog.length > 0;
    let savedId = null;
    try { savedId = localStorage.getItem(KEY.background); } catch { /* ignore */ }
    const chosen = bgCatalog.find((b) => b.id === savedId) || bgCatalog.find((b) => b.default) || null;
    applyBackground(chosen);
  }

  function applyBackground(entry) {
    $("bg-layer").style.backgroundImage = entry ? `url("images/${encodeURI(entry.file)}")` : "";
    document.documentElement.classList.toggle("has-bg-image", !!entry);
    bgSelectedId = entry ? entry.id : null;
    renderBackgroundPicker();
  }

  function renderBackgroundPicker() {
    const grid = $("bg-picker-grid");
    grid.replaceChildren();

    const make = (label, entry) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "thumb";
      const on = entry ? entry.id === bgSelectedId : !bgSelectedId;
      btn.setAttribute("aria-pressed", String(on));
      if (entry) {
        btn.style.backgroundImage = `url("images/${encodeURI(entry.file)}")`;
        const span = document.createElement("span");
        span.textContent = label;
        btn.appendChild(span);
      } else {
        btn.textContent = label;
      }
      btn.addEventListener("click", () => {
        try {
          if (entry) localStorage.setItem(KEY.background, entry.id);
          else localStorage.removeItem(KEY.background);
        } catch { /* ignore */ }
        applyBackground(entry);
      });
      grid.appendChild(btn);
    };
    make(t("set.noBg"), null);
    bgCatalog.forEach((b) => make(b.name || b.id, b));
  }

  // ---- skin ----
  const SKIN_CATALOG_URL = "skins/catalog.json";
  let skinCatalog = [];
  let currentSkin = null;
  let skinThemeLink = null;
  const rendererLoads = new Map();

  // A renderer registers itself on window.GenshinManiaSkinRenderers[skin.id].
  function loadSkinRenderer(skin) {
    const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
    if (registry[skin.id]) return Promise.resolve(registry[skin.id]);
    if (!skin.rendererFile) return Promise.reject(new Error(`Skin ${skin.id} has no rendererFile`));
    if (rendererLoads.has(skin.id)) return rendererLoads.get(skin.id);

    const load = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = skin.rendererFile;
      script.onload = () => registry[skin.id] ? resolve(registry[skin.id]) : reject(new Error(`Renderer ${skin.id} did not register`));
      script.onerror = () => reject(new Error(`Could not load ${skin.rendererFile}`));
      document.head.appendChild(script);
    });
    rendererLoads.set(skin.id, load);
    load.catch(() => rendererLoads.delete(skin.id));
    return load;
  }

  async function loadSkinCatalog() {
    try {
      const res = await fetch(SKIN_CATALOG_URL);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) skinCatalog = data.filter((s) => s && s.id);
      }
    } catch (err) {
      console.warn("Could not load the skin list:", err);
    }
    if (!skinCatalog.length) return; // the engine draws a plain fallback note

    let savedId = null;
    try { savedId = localStorage.getItem(KEY.skin); } catch { /* ignore */ }
    const chosen = skinCatalog.find((s) => s.id === savedId) || skinCatalog.find((s) => s.default) || skinCatalog[0];
    await applySkinChoice(chosen);
  }

  async function applySkinChoice(skin) {
    let renderer;
    try {
      renderer = await loadSkinRenderer(skin);
    } catch (err) {
      console.error(err);
      UI.toast(t("set.skinFail", { name: skin.name || skin.id }), "error");
      return;
    }
    currentSkin = { ...skin, noteRenderer: renderer };

    if (skin.cssFile) {
      if (!skinThemeLink) {
        skinThemeLink = document.createElement("link");
        skinThemeLink.rel = "stylesheet";
      }
      skinThemeLink.href = skin.cssFile;
      if (!skinThemeLink.isConnected) document.head.appendChild(skinThemeLink);
    } else if (skinThemeLink) {
      skinThemeLink.remove();
    }
    document.querySelectorAll("#skin-picker-grid .skin-card").forEach((c) =>
      c.setAttribute("aria-pressed", String(c.dataset.id === skin.id)));
  }

  // Previews are drawn by the real renderers, so what you pick is what you get.
  function drawSkinPreview(canvasEl, skin, renderer, variant) {
    const size = 54, dpr = 2;
    canvasEl.width = size * dpr;
    canvasEl.height = size * dpr;
    const ctx = canvasEl.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.translate(size / 2, size / 2);
    const color = variant === "hold" ? (skin.holdColor || skin.noteColor) : skin.noteColor;
    try {
      renderer.draw(ctx, { radius: 20, color, centerColor: skin.noteCenterColor || "#fff", useGlow: false, variant, active: false });
    } catch (err) {
      console.error(err);
    }
  }

  function renderSkinPicker() {
    const grid = $("skin-picker-grid");
    grid.replaceChildren();
    skinCatalog.forEach((skin) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "skin-card";
      card.dataset.id = skin.id;
      card.setAttribute("aria-pressed", String(currentSkin?.id === skin.id));

      const preview = document.createElement("span");
      preview.className = "skin-card__preview";
      const tap = document.createElement("canvas");
      const hold = document.createElement("canvas");
      preview.append(tap, hold);
      const name = document.createElement("span");
      name.textContent = skin.name || skin.id;
      card.append(preview, name);

      card.addEventListener("click", () => {
        try { localStorage.setItem(KEY.skin, skin.id); } catch { /* ignore */ }
        applySkinChoice(skin);
      });
      grid.appendChild(card);

      loadSkinRenderer(skin).then((renderer) => {
        drawSkinPreview(tap, skin, renderer, "tap");
        drawSkinPreview(hold, skin, renderer, "hold");
      }).catch(() => { preview.textContent = t("set.skinErr"); });
    });
  }

  // ==================================================================
  // CALIBRATION (tap along with a metronome)
  // ==================================================================
  const calibPad = $("calib-pad");
  const calib = { running: false, deltas: [], suggestion: null };

  function setPadText() {
    $("calib-pad-text").textContent = t(calib.running ? "calib.padRun" : "calib.padStart");
  }

  function updateCalibReadout() {
    const n = calib.deltas.length;
    $("calib-count").textContent = n;
    if (n < 3) { $("calib-avg").textContent = "-"; calib.suggestion = null; $("btn-calib-apply").disabled = true; return; }
    const recent = calib.deltas.slice(-16).sort((a, b) => a - b);
    const median = recent[Math.floor(recent.length / 2)];
    calib.suggestion = Math.max(-500, Math.min(500, Math.round(median * 1000)));
    $("calib-avg").textContent = `${calib.suggestion > 0 ? "+" : ""}${calib.suggestion} ms`;
    $("btn-calib-apply").disabled = n < 6;
  }

  function startCalibration() {
    AudioManager.ensureContext();
    AudioManager.startMetronome(100);
    calib.running = true;
    calib.deltas = [];
    calibPad.classList.add("is-running");
    setPadText();
    updateCalibReadout();
  }

  function stopCalibration() {
    AudioManager.stopMetronome();
    calib.running = false;
    calibPad.classList.remove("is-running", "is-hit");
    setPadText();
  }

  function calibTap(timeStamp) {
    if (!calib.running) { startCalibration(); return; }
    const lag = Math.max(0, Math.min(0.05, (performance.now() - timeStamp) / 1000));
    const delta = AudioManager.metronomeDelta(AudioManager.getContextTime() - lag);
    calibPad.classList.add("is-hit");
    setTimeout(() => calibPad.classList.remove("is-hit"), 80);
    if (delta === null || Math.abs(delta) > 0.25) return; // wildly off-beat taps would skew the average
    calib.deltas.push(delta);
    updateCalibReadout();
  }

  calibPad.addEventListener("pointerdown", (e) => { e.preventDefault(); calibTap(e.timeStamp); });
  document.addEventListener("keydown", (e) => {
    if (!$("screen-calibration").classList.contains("screen--active")) return;
    if (e.repeat || e.code === "Escape" || e.code === "Tab") return;
    const onOtherButton = e.target instanceof HTMLElement && e.target.closest("button") && e.target !== calibPad;
    if (onOtherButton && (e.code === "Space" || e.code === "Enter")) return;
    e.preventDefault();
    calibTap(e.timeStamp);
  });

  $("btn-calib-reset").addEventListener("click", () => { setOffset(0); UI.toast(t("calib.resetDone")); });
  $("btn-calib-apply").addEventListener("click", () => {
    if (calib.suggestion === null) return;
    setOffset(calib.suggestion);
    UI.toast(t("calib.applied", { ms: calib.suggestion }), "success");
    goScreen("screen-settings");
  });
  onEnter["screen-calibration"] = () => {
    calib.deltas = [];
    updateCalibReadout();
    $("calib-current").textContent = `${AudioManager.getOffsetMs()} ms`;
  };
  onLeave["screen-calibration"] = stopCalibration;

  // ==================================================================
  // LANGUAGE CHANGE: redraw everything built by script
  // ==================================================================
  document.addEventListener("languagechange", () => {
    renderSongList();
    if (lastDetail) renderDetail(lastDetail.song, lastDetail.status, lastDetail.message);
    renderKeys();
    renderBackgroundPicker();
    setPadText();
    updateUploadTexts();
    if (!uploadModal.hidden) btnUploadConfirm.textContent = t("up.confirm");
  });

  // ==================================================================
  // PUBLIC API for the editor and the Download Beatmaps screen
  // ==================================================================
  window.App = {
    goScreen,
    getKeymapFor,
    getSettings: () => state.settings,
    getLibrary: () => state.library,
    getLibraryAssets: async (id) => {
      const rec = await SongStore.get(id);
      return rec && rec.file ? { file: rec.file, beatmap: rec.beatmap } : null;
    },
    addSong,
    refreshSongs: renderSongList,
    openSong(id) {
      goScreen("screen-songselect");
      const song = findSong(id);
      if (song) selectSong(song);
    },
    describeError,
    difficultyLabel,
    playBeatmap({ beatmap, buffer, title, returnScreen }) {
      startSession({
        songId: null, title, beatmap, buffer: buffer || null,
        laneCount: beatmap.laneCount, autoplay: false, loop: null,
        returnScreen, isTest: true,
      });
    },
  };

  // ==================================================================
  // BOOT
  // ==================================================================
  loadState();
  syncSettingsUI();
  loadCatalog();
  loadBackgroundCatalog();
  loadSkinCatalog();
  Beatmaps.init();
  Editor.init();
})();
