/* ==========================================================================
   ENGINE.JS
   Canvas render loop + gameplay logic: lanes, falling notes (tap/hold),
   input judgement, effects, combo, judgement text.

   Exposes a single global: window.GameEngine

   Coordinate model:
   - Lanes are evenly spaced, centered horizontally on the canvas.
   - A note with time T reaches the hit line exactly when song time == T,
     whatever the scroll speed. Speed only changes how early it appears.

   Note lifecycle (note.state):
     "wait"  - on its way down, not yet touched
     "hold"  - a hold note whose head was hit and whose key is down
     "dead"  - a hold note that was missed or released early; its body
               keeps falling (greyed out) but it no longer scores
     "done"  - resolved, removed on the next sweep
   ========================================================================== */

const GameEngine = (() => {

  // ------------------------------------------------------------------
  // Tunables
  // ------------------------------------------------------------------
  const HIT_LINE_RATIO = 0.85;
  const BASE_RADIUS = 26;            // sprite design size; scaled down on narrow screens
  const PERFECT_WINDOW_MS = 45;
  const GREAT_WINDOW_MS = 90;
  const HOLD_END_PERFECT_S = 0.10;   // release this close to the tail keeps the head's grade
  const HOLD_END_GREAT_S = 0.18;     // earlier than that is a "great"; earlier still breaks the hold
  const GROUP_EPSILON_S = 0.006;     // notes closer than this count as simultaneous
  const END_PADDING_S = 1.2;

  const JUDGEMENT_LABEL = { perfect: "PERFECT", great: "GREAT", miss: "MISS" };

  const KEYMAPS = {
    4: ["KeyD", "KeyF", "KeyJ", "KeyK"],
    6: ["KeyA", "KeyS", "KeyD", "KeyJ", "KeyK", "KeyL"],
    8: ["KeyA", "KeyS", "KeyD", "KeyF", "KeyJ", "KeyK", "KeyL", "Semicolon"],
  };

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  let canvas, gfx;
  let laneCount = 6;
  let keymap = KEYMAPS[6].slice();
  let laneX = [];
  let laneGap = 100;
  let noteRadius = BASE_RADIUS;
  let hitLineY = 0;
  let renderDpr = 1;

  let pxPerSecond = 700;
  let beatmap = null;
  let lastEnd = 0;                 // song time at which the last note finishes
  let activeNotes = [];
  let noteCursor = 0;
  let heldLanes = new Set();
  let activeHolds = new Map();     // lane -> hold note currently being held
  let laneGlow = [];               // 0..1 fade for the light beam above each held lane
  let laneFlash = [];              // 0..1 flash when a lane scores

  let particles = [];
  let ripples = [];
  let holdSparkTimer = 0;
  let combo = 0, maxCombo = 0, score = 0;
  let counts = { perfect: 0, great: 0, miss: 0 };
  let totalJudged = 0, accuracySum = 0;

  let running = false;
  let paused = false;
  let rafId = null;
  let onFinish = null;
  let getSongTime = () => 0;
  let getDuration = () => 0;
  let resizeBound = false;
  let lastFrameTime = 0;

  // Options (changeable at any time through setOptions)
  let connectorsEnabled = true;
  let lowLag = false;

  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const glowEnabled = () => !coarsePointer && !lowLag;

  // Skin
  let noteColor = "#ffb04a";
  let noteColorActive = "#ffe6d6";
  let noteCenterColor = "#fff1a8";
  let holdColor = "#ff7468";
  let particleColor = "#ffd76b";
  let noteRenderer = null;
  let noteRendererId = "default";

  // Practice mode loop region, autoplay
  let loopRegion = null;
  let autoplay = false;

  // Cached gradients (rebuilt on resize / skin change)
  let laneGradient = null;
  let hitLineGradient = null;
  let beamGradient = null;

  // DOM refs
  let elCombo, elComboWrap, elScore, elAccuracy, elJudgement, elJudgeWord,
      elKeyRow, elAutoplayWatermark, elProgress;

  // ------------------------------------------------------------------
  // Colour helpers
  // ------------------------------------------------------------------
  function hexToRgb(hex) {
    const clean = String(hex).replace("#", "");
    const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
    const n = parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function withAlpha(hex, alpha) {
    const [r, g, b] = hexToRgb(hex);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  function lightenHex(hex, amount) {
    const [r, g, b] = hexToRgb(hex);
    const mix = (v) => Math.round(v + (255 - v) * amount).toString(16).padStart(2, "0");
    return `#${mix(r)}${mix(g)}${mix(b)}`;
  }

  // ------------------------------------------------------------------
  // Skin / options
  // ------------------------------------------------------------------
  function applySkin(skin = {}) {
    noteColor = skin.noteColor || "#ffb04a";
    noteColorActive = skin.noteColorActive || lightenHex(noteColor, 0.5);
    noteCenterColor = skin.noteCenterColor || "#fff1a8";
    holdColor = skin.holdColor || "#ff7468";
    particleColor = skin.particleColor || "#ffd76b";
    noteRenderer = skin.noteRenderer || null;
    noteRendererId = skin.id || "default";
    spriteCache.clear();
    rebuildGradients();
  }

  function setOptions(opts = {}) {
    if (opts.connectors !== undefined) connectorsEnabled = !!opts.connectors;
    if (opts.lowLag !== undefined && !!opts.lowLag !== lowLag) {
      lowLag = !!opts.lowLag;
      spriteCache.clear();
      if (canvas) resize();
    }
  }

  function setNoteSpeed(settingValue) {
    // settingValue range 5-20 (settings stepper) -> px/sec.
    pxPerSecond = 300 + settingValue * 40;
  }

  function setLoopRegion(region) { loopRegion = region; }

  function setAutoplay(enabled) {
    autoplay = !!enabled;
    if (elAutoplayWatermark) elAutoplayWatermark.hidden = !autoplay;
    if (autoplay) { heldLanes.clear(); activeHolds.clear(); clearIndicators(); }
  }

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------
  function init(canvasEl, opts = {}) {
    canvas = canvasEl;
    gfx = canvas.getContext("2d");

    laneCount = opts.laneCount || 6;
    keymap = (opts.keymap || KEYMAPS[laneCount]).slice();
    getSongTime = opts.getSongTime || (() => 0);
    getDuration = opts.getDuration || (() => 0);
    onFinish = opts.onFinish || null;
    laneGlow = new Array(laneCount).fill(0);
    laneFlash = new Array(laneCount).fill(0);
    setNoteSpeed(opts.noteSpeed || 10);
    setOptions({ connectors: opts.connectors !== false, lowLag: !!opts.lowLag });
    applySkin(opts.skin);

    elCombo = document.getElementById("hud-combo-count");
    elComboWrap = document.getElementById("hud-combo");
    elScore = document.getElementById("hud-score");
    elAccuracy = document.getElementById("hud-accuracy");
    elJudgement = document.getElementById("judgement-text");
    elJudgeWord = elJudgement.querySelector(".judgement__word");
    elKeyRow = document.getElementById("key-row");
    elAutoplayWatermark = document.getElementById("autoplay-watermark");
    elProgress = document.getElementById("hud-progress");

    buildKeyIndicators();
    resize();
    if (!resizeBound) {
      window.addEventListener("resize", resize);
      resizeBound = true;
    }
  }

  function resize() {
    if (!canvas) return;
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (!cw || !ch) return; // hidden screen; init()/start() resizes again once visible

    // Capped at 2: phones often report 3, which doubles the fill cost
    // for no visible gain. Low-lag mode renders at 1x.
    const dpr = lowLag ? 1 : Math.min(2, window.devicePixelRatio || 1);
    if (dpr !== renderDpr) { renderDpr = dpr; spriteCache.clear(); }
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    gfx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const keyHeight = keyIndicatorHeight();
    hitLineY = Math.min(ch * HIT_LINE_RATIO, ch - keyHeight - 34);

    // Spacing grows with the screen but is always squeezed to fit, so an
    // 8-key layout never runs off a phone screen. Notes shrink with it.
    // Dividing by laneCount (not laneCount - 1) leaves half a lane plus a
    // few pixels of room at each edge for the key buttons.
    let gap = Math.max(70, Math.min(160, cw * 0.11));
    gap = Math.min(gap, (cw - 10) / laneCount);
    laneGap = gap;
    noteRadius = Math.min(BASE_RADIUS, gap * 0.42);
    const startX = cw / 2 - (gap * (laneCount - 1)) / 2;
    laneX = Array.from({ length: laneCount }, (_, i) => startX + i * gap);

    rebuildGradients();
    positionKeyIndicators();
  }

  function rebuildGradients() {
    if (!gfx || !laneX.length) return;
    laneGradient = gfx.createLinearGradient(0, 0, 0, hitLineY + 8);
    laneGradient.addColorStop(0, "rgba(255,255,255,0)");
    laneGradient.addColorStop(0.35, "rgba(255,255,255,0.14)");
    laneGradient.addColorStop(1, "rgba(255,255,255,0.62)");

    const x0 = laneX[0] - 70, x1 = laneX[laneX.length - 1] + 70;
    hitLineGradient = gfx.createLinearGradient(x0, 0, x1, 0);
    hitLineGradient.addColorStop(0, "rgba(255,248,229,0)");
    hitLineGradient.addColorStop(0.12, "rgba(255,248,229,0.5)");
    hitLineGradient.addColorStop(0.88, "rgba(255,248,229,0.5)");
    hitLineGradient.addColorStop(1, "rgba(255,248,229,0)");

    beamGradient = gfx.createLinearGradient(0, hitLineY - 280, 0, hitLineY);
    beamGradient.addColorStop(0, withAlpha(particleColor, 0));
    beamGradient.addColorStop(1, withAlpha(particleColor, 0.42));
  }

  function keyIndicatorHeight() { return coarsePointer ? 60 : 38; }

  // Key indicators sit at absolute pixel positions taken from laneX, so
  // they line up with the canvas lanes exactly (CSS flex gap cannot).
  function positionKeyIndicators() {
    if (!elKeyRow || !laneX.length) return;
    const keyHeight = keyIndicatorHeight();
    const labelTop = Math.min(hitLineY + 24, canvas.clientHeight - keyHeight - 8);
    const width = Math.max(30, Math.min(coarsePointer ? 64 : 44, laneGap - 8));
    elKeyRow.style.top = `${labelTop}px`;
    elKeyRow.style.bottom = "auto";
    Array.from(elKeyRow.children).forEach((el, i) => {
      el.style.left = `${laneX[i]}px`;
      el.style.width = `${width}px`;
      el.style.height = `${keyHeight}px`;
    });
  }

  function buildKeyIndicators() {
    elKeyRow.innerHTML = "";
    keymap.forEach((code, lane) => {
      const div = document.createElement("div");
      div.className = "key-indicator";
      div.dataset.lane = lane;
      div.textContent = window.UI ? UI.keyLabel(code) : code.replace("Key", "");
      elKeyRow.appendChild(div);
    });
  }

  function clearIndicators() {
    if (!elKeyRow) return;
    Array.from(elKeyRow.children).forEach((el) => el.classList.remove("active"));
  }

  // ------------------------------------------------------------------
  // Beatmap lifecycle
  // ------------------------------------------------------------------
  function loadBeatmap(map) {
    const notes = [...map.notes].sort((a, b) => a.time - b.time || a.lane - b.lane);
    beatmap = { ...map, notes };

    // Tag simultaneous notes so a connector can be drawn between them.
    let i = 0;
    let groupId = 0;
    while (i < notes.length) {
      let j = i + 1;
      while (j < notes.length && notes[j].time - notes[i].time <= GROUP_EPSILON_S) j++;
      if (j - i >= 2) {
        for (let k = i; k < j; k++) notes[k] = { ...notes[k], group: groupId };
        groupId++;
      } else {
        notes[i] = { ...notes[i], group: -1 };
      }
      i = j;
    }
    lastEnd = notes.reduce((max, n) => Math.max(max, n.time + (n.type === "hold" ? n.duration : 0)), 0);
  }

  function start() {
    activeNotes = [];
    noteCursor = 0;
    // Practice mode: skip straight to the first note at/after the loop's
    // start, otherwise every earlier note would spawn at once and miss.
    if (loopRegion && beatmap) {
      const idx = beatmap.notes.findIndex((n) => n.time >= loopRegion.start);
      noteCursor = idx === -1 ? beatmap.notes.length : idx;
    }
    heldLanes.clear();
    activeHolds.clear();
    clearIndicators();
    particles = [];
    ripples = [];
    laneGlow.fill(0);
    laneFlash.fill(0);
    combo = 0; maxCombo = 0; score = 0;
    counts = { perfect: 0, great: 0, miss: 0 };
    totalJudged = 0; accuracySum = 0;
    running = true;
    paused = false;
    resize();
    lastFrameTime = performance.now();
    updateHud(false);
    loop();
  }

  function stop() {
    running = false;
    paused = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  // Pause keeps every bit of run state (notes, score, combo). Holds that
  // are being held are released first, under the normal release rules.
  function pause() {
    if (!running || paused) return;
    releaseAll();
    paused = true;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  }

  function resume() {
    if (!running || !paused) return;
    paused = false;
    lastFrameTime = performance.now();
    loop();
  }

  function isRunning() { return running; }
  function isPaused() { return paused; }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------
  function loop() {
    if (!running || paused) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000);
    lastFrameTime = now;
    const songTime = getSongTime();

    spawnDueNotes(songTime);
    updateAutoplay(songTime);
    updateHolds(songTime, dt);
    expireNotes(songTime);
    updateEffects(dt);
    render(songTime);
    updateProgress(songTime);

    if (loopRegion && songTime >= loopRegion.end) {
      loopRegion.onLoop();   // caller re-seeks audio back to loopRegion.start
      start();               // fresh lap; start() schedules the next frame itself
      return;
    }

    if (!loopRegion && songTime > lastEnd + END_PADDING_S &&
        noteCursor >= beatmap.notes.length && activeNotes.length === 0) {
      running = false;
      onFinish && onFinish(buildResultStats());
      return;
    }

    rafId = requestAnimationFrame(loop);
  }

  function updateProgress(songTime) {
    if (!elProgress) return;
    const total = getDuration() || lastEnd + END_PADDING_S;
    const p = total > 0 ? Math.max(0, Math.min(1, songTime / total)) : 0;
    elProgress.style.transform = `scaleX(${p.toFixed(4)})`;
  }

  function spawnDueNotes(songTime) {
    const leadTime = hitLineY / pxPerSecond;
    const notes = beatmap.notes;
    while (noteCursor < notes.length && notes[noteCursor].time - leadTime <= songTime) {
      activeNotes.push({ ...notes[noteCursor], state: "wait", headQuality: null });
      noteCursor++;
    }
  }

  // Autoplay presses every note exactly on time, so it always grades PERFECT.
  function updateAutoplay(songTime) {
    if (!autoplay) return;
    // Backward, because judgeTap() splices the note out of the array: a
    // forward for-of would skip the element that slides into its place.
    for (let i = activeNotes.length - 1; i >= 0; i--) {
      const note = activeNotes[i];
      if (note.state !== "wait" || songTime < note.time) continue;
      setKeyIndicatorActive(note.lane, true);
      laneGlow[note.lane] = 1;
      if (note.type === "hold") {
        note.state = "hold";
        note.headQuality = "perfect";
        activeHolds.set(note.lane, note);
        spawnHitEffects(note.lane, "perfect");
        window.AudioManager?.playSfx("perfect");
      } else {
        judgeTap(note, "perfect");
        setTimeout(() => setKeyIndicatorActive(note.lane, false), 90);
      }
    }
  }

  // A hold that is still down when its tail arrives completes by itself.
  function updateHolds(songTime, dt) {
    holdSparkTimer -= dt;
    const spark = holdSparkTimer <= 0;
    if (spark) holdSparkTimer = 0.07;

    activeHolds.forEach((note, lane) => {
      if (songTime >= note.time + note.duration) {
        completeHold(note, note.headQuality || "perfect");
        if (autoplay) setKeyIndicatorActive(lane, false);
      } else if (spark && !lowLag) {
        spawnSparks(lane, 2);
      }
    });
  }

  function expireNotes(songTime) {
    // Manual backward loop + splice: filter() would allocate a new
    // array 60 times a second even when nothing expires.
    const grace = GREAT_WINDOW_MS / 1000;
    for (let i = activeNotes.length - 1; i >= 0; i--) {
      const note = activeNotes[i];
      if (note.state === "done") { activeNotes.splice(i, 1); continue; }
      if (note.state === "dead") {
        if (songTime > note.time + note.duration + 0.4) activeNotes.splice(i, 1);
        continue;
      }
      if (note.state === "wait" && songTime - note.time > grace) {
        if (note.type === "hold") {
          // Head was never hit: the hold is lost, but its body keeps falling.
          note.state = "dead";
        } else {
          note.state = "done";
          activeNotes.splice(i, 1);
        }
        resolveJudgement(note, "miss");
      }
    }
  }

  // ------------------------------------------------------------------
  // Input. Keyboard and pointer both funnel into handleLaneDown/Up.
  // `timeStamp` is the DOM event's timestamp: using it removes the time
  // an event spent queued behind other main-thread work from the grade.
  // ------------------------------------------------------------------
  function eventSongTime(timeStamp) {
    let t = getSongTime();
    if (timeStamp) {
      const lag = (performance.now() - timeStamp) / 1000;
      if (lag > 0 && lag < 0.05) t -= lag;
    }
    return t;
  }

  function handleKeyDown(code, timeStamp) {
    const lane = keymap.indexOf(code);
    if (lane !== -1) handleLaneDown(lane, timeStamp);
  }

  function handleKeyUp(code, timeStamp) {
    const lane = keymap.indexOf(code);
    if (lane !== -1) handleLaneUp(lane, timeStamp);
  }

  function handleLaneDown(lane, timeStamp) {
    if (!running || paused || autoplay) return;
    if (lane < 0 || lane >= laneCount || heldLanes.has(lane)) return;
    heldLanes.add(lane);
    setKeyIndicatorActive(lane, true);

    const songTime = eventSongTime(timeStamp);
    const note = findJudgeableNote(lane, songTime);
    if (!note) return; // ghost tap: no note nearby, no penalty

    const deltaMs = (songTime - note.time) * 1000;
    const quality = qualityFromDelta(deltaMs);
    if (quality === "miss") return;

    if (note.type === "hold") {
      note.state = "hold";
      note.headQuality = quality;
      activeHolds.set(lane, note);
      spawnHitEffects(lane, quality);
      window.AudioManager?.playSfx(quality);
    } else {
      judgeTap(note, quality);
    }
  }

  function handleLaneUp(lane, timeStamp) {
    if (lane < 0 || lane >= laneCount) return;
    heldLanes.delete(lane);
    setKeyIndicatorActive(lane, false);
    if (autoplay || !running) return;

    const note = activeHolds.get(lane);
    if (!note) return;

    const songTime = eventSongTime(timeStamp);
    const early = note.time + note.duration - songTime; // > 0 means released before the tail
    if (early <= HOLD_END_PERFECT_S) completeHold(note, note.headQuality);
    else if (early <= HOLD_END_GREAT_S) completeHold(note, "great");
    else breakHold(note);
  }

  function releaseAll() {
    [...heldLanes].forEach((lane) => handleLaneUp(lane));
    heldLanes.clear();
    clearIndicators();
  }

  function findJudgeableNote(lane, songTime) {
    let best = null, bestDelta = Infinity;
    for (const note of activeNotes) {
      if (note.lane !== lane || note.state !== "wait") continue;
      const delta = Math.abs(songTime - note.time);
      if (delta < bestDelta) { bestDelta = delta; best = note; }
    }
    return best;
  }

  function qualityFromDelta(deltaMs) {
    const abs = Math.abs(deltaMs);
    if (abs <= PERFECT_WINDOW_MS) return "perfect";
    if (abs <= GREAT_WINDOW_MS) return "great";
    return "miss";
  }

  function setKeyIndicatorActive(lane, active) {
    const el = elKeyRow && elKeyRow.children[lane];
    if (el) el.classList.toggle("active", active);
  }

  // ------------------------------------------------------------------
  // Resolution: scoring, combo, HUD, effects
  // ------------------------------------------------------------------
  function judgeTap(note, quality) {
    note.state = "done";
    const idx = activeNotes.indexOf(note);
    if (idx !== -1) activeNotes.splice(idx, 1);
    resolveJudgement(note, quality);
  }

  function completeHold(note, quality) {
    activeHolds.delete(note.lane);
    note.state = "done";
    resolveJudgement(note, quality);
  }

  function breakHold(note) {
    activeHolds.delete(note.lane);
    note.state = "dead";
    resolveJudgement(note, "miss");
  }

  function resolveJudgement(note, quality) {
    counts[quality]++;
    totalJudged++;

    if (quality === "miss") {
      combo = 0;
    } else {
      combo++;
      maxCombo = Math.max(maxCombo, combo);
      score += quality === "perfect" ? 300 : 100;
      score += Math.min(combo, 100); // small combo bonus, capped
      accuracySum += quality === "perfect" ? 1 : 0.5;
      laneFlash[note.lane] = 1;
      if (note.type !== "hold" || note.state === "done") spawnHitEffects(note.lane, quality);
    }

    showJudgement(quality);
    if (note.type !== "hold" || quality === "miss") window.AudioManager?.playSfx(quality);
    updateHud(true);
  }

  function buildResultStats() {
    const accuracy = totalJudged ? (accuracySum / totalJudged) * 100 : 0;
    let rank = "C";
    if (accuracy >= 98) rank = "S";
    else if (accuracy >= 92) rank = "A";
    else if (accuracy >= 80) rank = "B";
    return {
      score, maxCombo, accuracy, rank,
      perfect: counts.perfect, great: counts.great, miss: counts.miss,
      total: totalJudged,
      fullCombo: totalJudged > 0 && counts.miss === 0,
      allPerfect: totalJudged > 0 && counts.miss === 0 && counts.great === 0,
    };
  }

  // ------------------------------------------------------------------
  // HUD (cheap DOM writes, not part of the canvas render)
  // ------------------------------------------------------------------
  function updateHud(pop) {
    if (elCombo) {
      elCombo.textContent = combo;
      if (elComboWrap) {
        elComboWrap.classList.toggle("is-idle", combo < 2);
        if (pop && combo >= 2) {
          elCombo.classList.remove("pop");
          void elCombo.offsetWidth; // restart the animation
          elCombo.classList.add("pop");
        }
      }
    }
    if (elScore) elScore.textContent = score.toLocaleString("en-US");
    if (elAccuracy) {
      const acc = totalJudged ? (accuracySum / totalJudged) * 100 : 100;
      elAccuracy.textContent = `${acc.toFixed(1)}%`;
    }
  }

  let judgementFadeTimer = null;
  function showJudgement(quality) {
    if (!elJudgement) return;
    elJudgeWord.textContent = JUDGEMENT_LABEL[quality];
    elJudgement.className = `judgement judgement--${quality}`;
    void elJudgement.offsetWidth; // restart the pop animation
    elJudgement.classList.add("show");
    clearTimeout(judgementFadeTimer);
    judgementFadeTimer = setTimeout(() => elJudgement.classList.remove("show"), 420);
  }

  // ------------------------------------------------------------------
  // Effects
  // ------------------------------------------------------------------
  function spawnHitEffects(lane, quality) {
    const x = laneX[lane], y = hitLineY;
    ripples.push({ x, y, life: 1, color: quality === "perfect" ? particleColor : noteColor });
    const perfect = quality === "perfect";
    const count = lowLag ? (perfect ? 5 : 3) : (perfect ? 14 : 9);
    const color = perfect ? particleColor : noteColor;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.3;
      const speed = 120 + Math.random() * 160;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        life: 1, color,
        size: 2.5 + Math.random() * 3,
      });
    }
  }

  function spawnSparks(lane, count) {
    const x = laneX[lane], y = hitLineY;
    for (let i = 0; i < count; i++) {
      particles.push({
        x: x + (Math.random() - 0.5) * noteRadius,
        y,
        vx: (Math.random() - 0.5) * 60,
        vy: -80 - Math.random() * 120,
        life: 0.8, color: particleColor,
        size: 1.8 + Math.random() * 2,
      });
    }
  }

  function updateEffects(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt;
      p.life -= dt * 1.6;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      ripples[i].life -= dt * 3.2;
      if (ripples[i].life <= 0) ripples.splice(i, 1);
    }
    for (let l = 0; l < laneCount; l++) {
      const target = heldLanes.has(l) || activeHolds.has(l) ? 1 : 0;
      laneGlow[l] += (target - laneGlow[l]) * Math.min(1, dt * 16);
      laneFlash[l] = Math.max(0, laneFlash[l] - dt * 5);
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render(songTime) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    gfx.clearRect(0, 0, w, h);

    drawLanes();
    drawBeams();
    if (connectorsEnabled) drawConnectors(songTime);
    drawHitPoints();
    drawHoldBodies(songTime);
    for (const note of activeNotes) drawNoteHeads(note, songTime);
    drawEffects();
  }

  function drawLanes() {
    gfx.strokeStyle = laneGradient;
    gfx.lineWidth = 1.5;
    gfx.beginPath();
    for (const x of laneX) {
      gfx.moveTo(x, 0);
      gfx.lineTo(x, hitLineY + 8);
    }
    gfx.stroke();
  }

  // A soft column of light rises from each lane while its key is down.
  function drawBeams() {
    const half = noteRadius * 0.85;
    gfx.fillStyle = beamGradient;
    for (let l = 0; l < laneCount; l++) {
      const a = Math.max(laneGlow[l], laneFlash[l] * 0.6);
      if (a < 0.02) continue;
      gfx.globalAlpha = Math.min(1, a);
      gfx.fillRect(laneX[l] - half, hitLineY - 280, half * 2, 280);
    }
    gfx.globalAlpha = 1;
  }

  function drawHitPoints() {
    gfx.strokeStyle = hitLineGradient;
    gfx.lineWidth = 1.5;
    gfx.beginPath();
    gfx.moveTo(laneX[0] - 70, hitLineY);
    gfx.lineTo(laneX[laneX.length - 1] + 70, hitLineY);
    gfx.stroke();

    for (let l = 0; l < laneCount; l++) {
      const x = laneX[l];
      const down = Math.max(laneGlow[l], laneFlash[l]);
      gfx.beginPath();
      gfx.arc(x, hitLineY, 15 + down * 7, 0, Math.PI * 2);
      gfx.fillStyle = down > 0.02 ? withAlpha(particleColor, 0.16 + down * 0.3) : "rgba(255,255,255,0.12)";
      gfx.fill();

      gfx.beginPath();
      gfx.arc(x, hitLineY, 9.5, 0, Math.PI * 2);
      gfx.fillStyle = "rgba(255,255,255,0.97)";
      gfx.fill();
      gfx.lineWidth = 2;
      gfx.strokeStyle = "rgba(255,248,229,0.9)";
      gfx.stroke();
    }
  }

  // Simultaneous notes are tied together with a horizontal bar, drawn
  // once per group between its outermost lanes that are still waiting.
  const groupSpans = new Map();
  function drawConnectors(songTime) {
    groupSpans.clear();
    for (const note of activeNotes) {
      if (note.group < 0 || note.state !== "wait") continue;
      const x = laneX[note.lane];
      const span = groupSpans.get(note.group);
      if (!span) groupSpans.set(note.group, { min: x, max: x, y: yForTime(note.time, songTime), n: 1 });
      else { span.min = Math.min(span.min, x); span.max = Math.max(span.max, x); span.n++; }
    }
    if (!groupSpans.size) return;
    const thick = Math.max(5, noteRadius * 0.3);
    groupSpans.forEach((s) => {
      if (s.n < 2 || s.y > hitLineY + noteRadius) return;
      const g = gfx.createLinearGradient(0, s.y - thick / 2, 0, s.y + thick / 2);
      g.addColorStop(0, "rgba(255,250,214,0.95)");
      g.addColorStop(1, "rgba(246,226,160,0.85)");
      gfx.fillStyle = g;
      gfx.fillRect(s.min, s.y - thick / 2, s.max - s.min, thick);
    });
  }

  function yForTime(noteTime, songTime) {
    return hitLineY - (noteTime - songTime) * pxPerSecond;
  }

  function drawHoldBodies(songTime) {
    for (const note of activeNotes) {
      if (note.type !== "hold") continue;
      const x = laneX[note.lane];
      const headY = yForTime(note.time, songTime);
      const tailY = yForTime(note.time + note.duration, songTime);
      const top = Math.min(tailY, hitLineY);
      const bottom = note.state === "hold" ? hitLineY : headY;
      if (bottom <= top) continue;
      drawHoldBar(x, top, Math.min(bottom, canvas.clientHeight + 40), note.state);
    }
  }

  function drawHoldBar(x, topY, bottomY, state) {
    const half = noteRadius * 0.82;
    const base = state === "dead" ? "#8d93a3" : holdColor;
    const topAlpha = state === "hold" ? 0.4 : 0.14;
    const bottomAlpha = state === "dead" ? 0.34 : state === "hold" ? 0.95 : 0.78;

    const body = gfx.createLinearGradient(0, topY, 0, bottomY);
    body.addColorStop(0, withAlpha(base, 0));
    body.addColorStop(0.22, withAlpha(base, topAlpha));
    body.addColorStop(1, withAlpha(base, bottomAlpha));
    gfx.fillStyle = body;
    gfx.fillRect(x - half, topY, half * 2, bottomY - topY);

    // Lit edges
    const edge = gfx.createLinearGradient(0, topY, 0, bottomY);
    edge.addColorStop(0, "rgba(255,255,255,0)");
    edge.addColorStop(1, withAlpha(lightenHex(base, 0.65), state === "dead" ? 0.18 : 0.75));
    gfx.fillStyle = edge;
    gfx.fillRect(x - half, topY, 1.6, bottomY - topY);
    gfx.fillRect(x + half - 1.6, topY, 1.6, bottomY - topY);
  }

  function drawNoteHeads(note, songTime) {
    const x = laneX[note.lane];
    if (note.type === "hold") {
      const headY = yForTime(note.time, songTime);
      const tailY = yForTime(note.time + note.duration, songTime);
      const active = note.state === "hold";
      const dead = note.state === "dead";
      if (dead) gfx.globalAlpha = 0.4;
      if (tailY > -noteRadius * 2) drawNoteSprite(x, tailY, "hold", active);
      // While held, the head waits on the hit line instead of falling past it.
      drawNoteSprite(x, active ? Math.min(headY, hitLineY) : headY, "hold", active);
      if (dead) gfx.globalAlpha = 1;
    } else {
      drawNoteSprite(x, yForTime(note.time, songTime), "tap", false);
    }
  }

  // Sprites are drawn once per distinct look, at the canvas pixel ratio so
  // they stay sharp on high-DPI screens, then blitted every frame.
  const spriteCache = new Map();

  function getNoteSprite(variant, active) {
    const color = variant === "hold"
      ? (active ? lightenHex(holdColor, 0.35) : holdColor)
      : (active ? noteColorActive : noteColor);
    const glow = glowEnabled();
    const key = `${noteRendererId}|${variant}|${active}|${glow}|${renderDpr}|${color}|${noteCenterColor}`;
    let sprite = spriteCache.get(key);
    if (sprite) return sprite;

    const pad = glow ? 18 : 6;
    const size = Math.ceil(BASE_RADIUS * 2 + pad * 2);
    sprite = document.createElement("canvas");
    sprite.width = size * renderDpr;
    sprite.height = size * renderDpr;
    sprite.logicalSize = size;
    const sgfx = sprite.getContext("2d");
    sgfx.scale(renderDpr, renderDpr);
    sgfx.translate(size / 2, size / 2);

    if (noteRenderer && typeof noteRenderer.draw === "function") {
      try {
        noteRenderer.draw(sgfx, {
          radius: BASE_RADIUS, color, centerColor: noteCenterColor,
          useGlow: glow, variant, active,
        });
      } catch (err) {
        console.error("Skin renderer lỗi:", err);
        drawFallbackNote(sgfx, color, glow);
      }
    } else {
      drawFallbackNote(sgfx, color, glow);
    }
    spriteCache.set(key, sprite);
    return sprite;
  }

  // A broken skin must never make notes invisible.
  function drawFallbackNote(sgfx, color, glow) {
    if (glow) { sgfx.shadowColor = color; sgfx.shadowBlur = 10; }
    sgfx.fillStyle = color;
    sgfx.beginPath();
    sgfx.arc(0, 0, BASE_RADIUS * 0.8, 0, Math.PI * 2);
    sgfx.fill();
  }

  function drawNoteSprite(x, y, variant, active) {
    if (y < -noteRadius * 3 || y > canvas.clientHeight + noteRadius * 3) return;
    const sprite = getNoteSprite(variant, active);
    const size = sprite.logicalSize * (noteRadius / BASE_RADIUS);
    gfx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
  }

  function drawEffects() {
    for (const r of ripples) {
      gfx.globalAlpha = Math.max(0, r.life) * 0.85;
      gfx.strokeStyle = r.color;
      gfx.lineWidth = 2.5;
      gfx.beginPath();
      gfx.arc(r.x, r.y, 12 + (1 - r.life) * 34, 0, Math.PI * 2);
      gfx.stroke();
    }
    for (const p of particles) {
      gfx.globalAlpha = Math.max(0, p.life);
      gfx.fillStyle = p.color;
      gfx.beginPath();
      gfx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      gfx.fill();
    }
    gfx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  return {
    KEYMAPS,
    init, loadBeatmap, start, stop, pause, resume, isRunning, isPaused,
    setNoteSpeed, setOptions, applySkin, resize,
    handleKeyDown, handleKeyUp, handleLaneDown, handleLaneUp, releaseAll,
    hasKey: (code) => keymap.includes(code),
    setLoopRegion, setAutoplay,
  };
})();

window.GameEngine = GameEngine;
