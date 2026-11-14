/* ==========================================================================
   BEATMAPS.JS
   The Download Beatmaps screen: browse the cloud catalog, download a chart
   plus its audio straight into the local library, and (for the owner only)
   add, edit and delete beatmaps.

   Exposes a single global: window.Beatmaps
   ========================================================================== */

const Beatmaps = (() => {
  const MAX_AUDIO_BYTES = 50 * 1024 * 1024; // the free Supabase plan cannot exceed this per file
  const MAX_CHART_BYTES = 400 * 1024;       // matches the database check on the chart column

  const $ = (id) => document.getElementById(id);

  let rows = [];
  let loaded = false;
  let loading = false;
  let loadError = null;
  let filterKeys = "all";
  let query = "";
  const busy = new Set();      // beatmap ids being downloaded right now

  let editing = null;          // the row open in the publish dialog, or null when adding
  let pub = emptyPublishState();

  function emptyPublishState() {
    return { audio: null, duration: 0, chart: null };
  }

  const describe = (err) => App.describeError(err);

  function formatDuration(sec) {
    const s = Math.round(sec || 0);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  const formatSize = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

  function make(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  // ------------------------------------------------------------------
  // Init + screen lifecycle
  // ------------------------------------------------------------------
  function init() {
    $("bm-search").addEventListener("input", (e) => { query = e.target.value.trim().toLowerCase(); render(); });

    $("bm-keys").querySelectorAll("[data-keys]").forEach((btn) => {
      btn.addEventListener("click", () => {
        filterKeys = btn.dataset.keys;
        $("bm-keys").querySelectorAll("[data-keys]").forEach((b) => b.classList.toggle("is-active", b === btn));
        render();
      });
    });

    $("btn-bm-refresh").addEventListener("click", () => load());
    $("btn-bm-add").addEventListener("click", () => openPublish(null));
    $("btn-bm-admin").addEventListener("click", onAdminButton);

    $("admin-form").addEventListener("submit", onSignIn);
    $("btn-admin-cancel").addEventListener("click", () => UI.closeModal($("admin-modal")));

    $("btn-pub-cancel").addEventListener("click", () => UI.closeModal($("publish-modal")));
    $("btn-pub-submit").addEventListener("click", submitPublish);
    $("pub-library").addEventListener("change", onPickLibrary);
    $("pub-audio-input").addEventListener("change", onPickAudio);
    $("pub-chart-input").addEventListener("change", onPickChart);

    document.addEventListener("languagechange", () => { updateAdminUi(); render(); updatePublishTexts(); });
  }

  function onEnter() {
    updateAdminUi();
    if (!loaded && !loading) load(); else render();
  }

  async function load() {
    if (!Cloud.isConfigured()) { render(); return; }
    loading = true;
    loadError = null;
    render();
    try {
      rows = await Cloud.list();
      loaded = true;
    } catch (err) {
      loadError = err;
    }
    loading = false;
    render();
  }

  // ------------------------------------------------------------------
  // List
  // ------------------------------------------------------------------
  function message(text, withRetry) {
    const box = make("div", "bm-message");
    box.appendChild(make("p", "", text));
    if (withRetry) {
      const retry = make("button", "btn btn--paper btn--small", t("bm.retry"));
      retry.addEventListener("click", () => load());
      box.appendChild(retry);
    }
    return box;
  }

  function render() {
    const list = $("bm-list");
    list.replaceChildren();
    $("btn-bm-refresh").disabled = loading;

    if (!Cloud.isConfigured()) { list.appendChild(message(t("bm.notConfigured"))); return; }
    if (loading) { list.appendChild(message(t("bm.loading"))); return; }
    if (loadError) { list.appendChild(message(t("bm.loadFail", { reason: describe(loadError) }), true)); return; }
    if (!rows.length) { list.appendChild(message(t("bm.emptyAll"))); return; }

    const library = new Map(App.getLibrary().filter((s) => s.cloudId).map((s) => [s.cloudId, s]));
    const admin = Cloud.isAdmin();
    const shown = rows.filter((r) =>
      (filterKeys === "all" || String(r.lane_count) === filterKeys) &&
      (!query || `${r.title} ${r.artist || ""}`.toLowerCase().includes(query)));

    if (!shown.length) { list.appendChild(message(t("bm.empty"))); return; }
    shown.forEach((row) => list.appendChild(buildRow(row, library.get(row.id), admin)));
  }

  function buildRow(row, libraryEntry, admin) {
    const card = make("article", "bm-row");

    const main = make("div", "bm-row__main");
    main.appendChild(make("b", "bm-row__title", row.title));
    if (row.artist) main.appendChild(make("small", "bm-row__artist", row.artist));

    const chips = make("div", "bm-row__chips");
    const addChip = (text) => chips.appendChild(make("span", "chip", text));
    addChip(`${row.lane_count}K`);
    if (row.bpm) addChip(`${Math.round(row.bpm)} BPM`);
    addChip(App.difficultyLabel(row.difficulty));
    addChip(t("bm.notes", { n: row.note_count }));
    if (row.duration_s) addChip(formatDuration(row.duration_s));
    if (row.audio_bytes) addChip(formatSize(row.audio_bytes));

    const actions = make("div", "bm-row__actions");
    if (admin) {
      const edit = make("button", "btn btn--ghost btn--small", t("bm.edit"));
      edit.addEventListener("click", () => openPublish(row));
      const del = make("button", "icon-btn icon-btn--sm icon-btn--ghost");
      del.setAttribute("aria-label", t("bm.deleteAria"));
      del.innerHTML = '<svg class="ic"><use href="#i-trash"/></svg>';
      del.addEventListener("click", () => deleteRow(row));
      actions.append(edit, del);
    }

    const main_btn = make("button", "btn btn--primary btn--small");
    if (libraryEntry) {
      main_btn.textContent = t("bm.play");
      main_btn.addEventListener("click", () => App.openSong(libraryEntry.id));
    } else if (busy.has(row.id)) {
      main_btn.textContent = t("bm.downloading");
      main_btn.disabled = true;
    } else {
      main_btn.textContent = t("bm.download");
      main_btn.addEventListener("click", () => download(row));
    }
    actions.appendChild(main_btn);

    card.append(main, chips, actions);
    return card;
  }

  // Download = chart + audio, then straight into the library.
  async function download(row) {
    busy.add(row.id);
    render();
    try {
      const [chart, blob] = await Promise.all([Cloud.getChart(row.id), Cloud.downloadAudio(row.audio_path)]);
      const beatmap = ChartGen.validateBeatmap(chart);
      const ext = (row.audio_path.match(/\.[a-z0-9]+$/i) || [".mp3"])[0];
      const file = new File([blob], `${row.title}${ext}`, { type: blob.type || "audio/mpeg" });
      await App.addSong({
        file, beatmap, title: row.title,
        meta: { artist: row.artist || "", difficulty: row.difficulty, cloudId: row.id },
      });
      UI.toast(t("bm.downloaded", { title: row.title }), "success");
    } catch (err) {
      console.error(err);
      UI.toast(describe(err), "error", 5000);
    } finally {
      busy.delete(row.id);
      render();
    }
  }

  // ------------------------------------------------------------------
  // Owner: sign in / out
  // ------------------------------------------------------------------
  function updateAdminUi() {
    const configured = Cloud.isConfigured();
    const admin = Cloud.isAdmin();
    $("btn-bm-admin").hidden = !configured;
    $("btn-bm-admin").textContent = admin ? t("bm.adminSignOut") : t("bm.adminSignIn");
    $("btn-bm-add").hidden = !admin;
    $("bm-admin-status").textContent = admin ? t("bm.adminAs", { email: Cloud.adminEmail() }) : "";
  }

  async function onAdminButton() {
    if (Cloud.isAdmin()) {
      await Cloud.signOut();
      UI.toast(t("admin.signedOut"));
      updateAdminUi();
      render();
      return;
    }
    $("admin-error").hidden = true;
    $("admin-password").value = "";
    UI.openModal($("admin-modal"));
    $("admin-email").focus();
  }

  async function onSignIn(e) {
    e.preventDefault();
    const submit = $("btn-admin-submit");
    submit.disabled = true;
    $("admin-error").hidden = true;
    try {
      await Cloud.signIn($("admin-email").value.trim(), $("admin-password").value);
      $("admin-password").value = "";
      UI.closeModal($("admin-modal"));
      UI.toast(t("admin.signedIn"), "success");
      updateAdminUi();
      render();
    } catch (err) {
      $("admin-error").textContent = describe(err);
      $("admin-error").hidden = false;
    } finally {
      submit.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Owner: add / edit / delete
  // ------------------------------------------------------------------
  function showPublishError(text) {
    $("pub-error").textContent = text;
    $("pub-error").hidden = !text;
  }

  function updatePublishTexts() {
    if ($("publish-modal").hidden) return;
    $("pub-heading").textContent = t(editing ? "pub.edit" : "pub.add");
    $("btn-pub-submit").textContent = t(editing ? "pub.save" : "pub.publish");
    fillLibraryOptions();
    updateSummary();
  }

  function fillLibraryOptions() {
    const select = $("pub-library");
    const current = select.value;
    select.replaceChildren(new Option(t("pub.libraryNone"), ""));
    App.getLibrary().filter((s) => !s.cloudId).forEach((s) => select.appendChild(new Option(s.title, s.id)));
    select.value = [...select.options].some((o) => o.value === current) ? current : "";
  }

  function openPublish(row) {
    editing = row;
    pub = emptyPublishState();
    $("pub-title").value = row ? row.title : "";
    $("pub-artist").value = row ? row.artist || "" : "";
    $("pub-difficulty").value = row ? row.difficulty : "normal";
    $("pub-audio-name").textContent = "";
    $("pub-chart-name").textContent = "";
    $("pub-audio-input").value = "";
    $("pub-chart-input").value = "";
    $("pub-library-field").hidden = !!row;
    showPublishError("");
    $("btn-pub-submit").disabled = false;
    UI.openModal($("publish-modal"));
    updatePublishTexts();
  }

  function updateSummary() {
    const parts = [];
    if (pub.chart) {
      parts.push(`${pub.chart.laneCount}K`, `${Math.round(pub.chart.bpm)} BPM`, t("bm.notes", { n: pub.chart.notes.length }));
    }
    if (pub.audio) {
      if (pub.duration) parts.push(formatDuration(pub.duration));
      parts.push(formatSize(pub.audio.size));
    }
    $("pub-summary").textContent = parts.length ? parts.join(" · ") : (editing ? t("pub.keepFiles") : "");
  }

  async function setAudio(file) {
    if (file.size > MAX_AUDIO_BYTES) { showPublishError(t("pub.audioTooBig")); return false; }
    let buffer;
    try { buffer = await AudioManager.decodeFile(file); }
    catch { showPublishError(t("up.badAudio")); return false; }
    pub.audio = file;
    pub.duration = buffer.duration;
    $("pub-audio-name").textContent = file.name;
    updateSummary();
    return true;
  }

  function setChart(beatmap, name) {
    pub.chart = beatmap;
    $("pub-chart-name").textContent = name;
    updateSummary();
  }

  async function onPickAudio(e) {
    const file = e.target.files[0];
    showPublishError("");
    if (!file) return;
    if (!(await setAudio(file))) e.target.value = "";
    else if (!$("pub-title").value.trim()) $("pub-title").value = file.name.replace(/\.[a-z0-9]+$/i, "");
  }

  async function onPickChart(e) {
    const file = e.target.files[0];
    showPublishError("");
    if (!file) return;
    try {
      const text = await file.text();
      if (text.length > MAX_CHART_BYTES) throw new Error(t("pub.chartTooBig"));
      let raw;
      try { raw = JSON.parse(text); } catch { throw new Error(t("song.beatmapBad")); }
      setChart(ChartGen.validateBeatmap(raw), file.name);
    } catch (err) {
      showPublishError(describe(err));
      e.target.value = "";
    }
  }

  async function onPickLibrary(e) {
    showPublishError("");
    const id = e.target.value;
    if (!id) return;
    const assets = await App.getLibraryAssets(id);
    if (!assets) { showPublishError(t("song.noFile")); return; }
    const entry = App.getLibrary().find((s) => s.id === id);
    if (await setAudio(assets.file)) {
      setChart(assets.beatmap, entry ? entry.title : "");
      if (!$("pub-title").value.trim() && entry) $("pub-title").value = entry.title;
    }
  }

  const chartPayload = (beatmap, title) => ({
    songTitle: beatmap.songTitle || title,
    bpm: beatmap.bpm,
    offset: beatmap.offset,
    laneCount: beatmap.laneCount,
    notes: beatmap.notes,
  });

  const newAudioPath = (file) => `${crypto.randomUUID()}${(file.name.match(/\.[a-z0-9]+$/i) || [".mp3"])[0].toLowerCase()}`;

  async function submitPublish() {
    showPublishError("");
    const title = $("pub-title").value.trim();
    const artist = $("pub-artist").value.trim();
    const difficulty = $("pub-difficulty").value;
    if (!title) return showPublishError(t("pub.needTitle"));
    if (!editing && !pub.audio) return showPublishError(t("pub.needAudio"));
    if (!editing && !pub.chart) return showPublishError(t("pub.needChart"));

    const submit = $("btn-pub-submit");
    submit.disabled = true;
    submit.textContent = t("pub.publishing");
    try {
      if (!editing) {
        const chart = chartPayload(pub.chart, title);
        if (JSON.stringify(chart).length > MAX_CHART_BYTES) throw new Error(t("pub.chartTooBig"));
        const path = newAudioPath(pub.audio);
        await Cloud.uploadAudio(path, pub.audio);
        try {
          await Cloud.insert({
            title, artist, difficulty,
            bpm: pub.chart.bpm, lane_count: pub.chart.laneCount, note_count: pub.chart.notes.length,
            duration_s: pub.duration, chart, audio_path: path, audio_bytes: pub.audio.size,
          });
        } catch (err) {
          await Cloud.removeAudio(path).catch(() => {});
          throw err;
        }
        UI.toast(t("pub.published"), "success");
      } else {
        const patch = { title, artist, difficulty, updated_at: new Date().toISOString() };
        if (pub.chart) {
          const chart = chartPayload(pub.chart, title);
          if (JSON.stringify(chart).length > MAX_CHART_BYTES) throw new Error(t("pub.chartTooBig"));
          Object.assign(patch, { chart, bpm: pub.chart.bpm, lane_count: pub.chart.laneCount, note_count: pub.chart.notes.length });
        }
        let newPath = null;
        if (pub.audio) {
          newPath = newAudioPath(pub.audio);
          await Cloud.uploadAudio(newPath, pub.audio);
          Object.assign(patch, { audio_path: newPath, audio_bytes: pub.audio.size, duration_s: pub.duration });
        }
        try {
          await Cloud.update(editing.id, patch);
        } catch (err) {
          if (newPath) await Cloud.removeAudio(newPath).catch(() => {});
          throw err;
        }
        if (newPath) await Cloud.removeAudio(editing.audio_path).catch(() => {});
        UI.toast(t("pub.updated"), "success");
      }
      UI.closeModal($("publish-modal"));
      await load();
    } catch (err) {
      console.error(err);
      showPublishError(describe(err));
    } finally {
      submit.disabled = false;
      submit.textContent = t(editing ? "pub.save" : "pub.publish");
    }
  }

  async function deleteRow(row) {
    const ok = await UI.confirm({
      title: t("bm.deleteTitle"),
      text: t("bm.deleteText", { title: row.title }),
      okLabel: t("song.deleteBtn"), danger: true,
    });
    if (!ok) return;
    try {
      await Cloud.remove(row.id);
      await Cloud.removeAudio(row.audio_path).catch(() => {});
      UI.toast(t("bm.deleted"));
      await load();
    } catch (err) {
      UI.toast(describe(err), "error");
    }
  }

  return { init, onEnter };
})();

window.Beatmaps = Beatmaps;
