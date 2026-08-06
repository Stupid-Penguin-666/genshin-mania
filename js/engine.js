/* ==========================================================================
   ENGINE.JS
   Canvas render loop + gameplay logic: lanes, falling notes (tap/hold),
   input judgement, particles, combo bar, judgement text.

   Exposes a single global: window.GameEngine

   Coordinate model:
   - Lanes are evenly spaced, centered horizontally on the canvas.
   - The hit line sits near the bottom (HIT_LINE_RATIO of canvas height),
     matching the .key-row DOM position in style.css.
   - A note born at note.time reaches the hit line exactly at note.time
     (song-time seconds), regardless of scroll speed — only the SPAWN
     time (how early it appears) changes with speed.
   ========================================================================== */

const GameEngine = (() => {

  // ------------------------------------------------------------------
  // Tunables
  // ------------------------------------------------------------------
  const HIT_LINE_RATIO = 0.86;     // fraction of canvas height where lanes are "hit"
  const NOTE_RADIUS = 26;
  const PERFECT_WINDOW_MS = 45;
  const GREAT_WINDOW_MS = 90;
  const HOLD_TAIL_TOLERANCE_MS = 100; // grace window for releasing a hold late/early

  const JUDGEMENT_LABEL = {
    perfect: "PERFECT",
    great: "GREAT",
    miss: "MISS",
  };

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
  let laneX = [];          // pixel center-x of each lane, recomputed on resize
  let hitLineY = 0;

  let pxPerSecond = 700;   // derived from "note speed" setting (5-20)
  let beatmap = null;
  let activeNotes = [];    // notes not yet fully resolved (spawned window)
  let noteCursor = 0;      // index into beatmap.notes for spawn scheduling
  let heldLanes = new Set();       // lanes currently key-down
  let activeHolds = new Map();     // lane -> note currently being held

  let particles = [];
  let combo = 0, maxCombo = 0, score = 0;
  let counts = { perfect: 0, great: 0, miss: 0 };
  let totalJudged = 0, accuracySum = 0;

  let running = false;
  let rafId = null;
  let onFinish = null;      // callback(stats) when song ends
  let getSongTime = () => 0; // injected — usually AudioManager.getSongTime
  let initialized = false;  // guards against duplicate resize listeners
                             // when init() is called again (e.g. editor Test Play)
  let lastFrameTime = 0;    // performance.now() of the previous frame, for real dt

  // Glow (shadowBlur) looks nicer but is expensive on mobile GPUs.
  // `pointer: coarse` is true on touch-primary devices (phones/tablets)
  // and false on mouse/trackpad devices — a more reliable signal than
  // parsing the user-agent string.
  const useGlow = !window.matchMedia("(pointer: coarse)").matches;

  // ------------------------------------------------------------------
  // SKIN — note shape/color config, set once in init() from whatever
  // skins/catalog.json entry main.js picked. Defaults below exactly
  // match what used to be hardcoded, so the built-in "default" skin
  // looks byte-identical to before this was made configurable.
  // ------------------------------------------------------------------
  let noteColor = "#ff9f6b";
  let noteColorActive = "#ffe6d6"; // brighter tint while a Hold is being pressed
  let noteCenterColor = "#ffe6d6"; // sprite's inner highlight dot
  let holdColor = "#ff8a3d";
  let particleColor = "#ffd76b";   // Perfect-tier particle color ("Great" reuses noteColor)
  // A skin owns the code that draws its note shape.  The engine only
  // supplies a canvas context and the current visual state, so adding a
  // new shape never requires changing gameplay code.
  let noteRenderer = null;
  let noteRendererId = "default";

  function hexToRgb(hex) {
    const clean = hex.replace("#", "");
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
    const lr = Math.round(r + (255 - r) * amount);
    const lg = Math.round(g + (255 - g) * amount);
    const lb = Math.round(b + (255 - b) * amount);
    return `#${[lr, lg, lb].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  // Can be called any time (not just at init) — e.g. main.js calls this
  // fresh before every GameEngine.start(), so switching skins between
  // replays doesn't require a full re-initialization. Clears the sprite
  // cache since previously-cached shapes/colors would otherwise persist.
  function applySkin(skin = {}) {
    noteColor = skin.noteColor || "#ff9f6b";
    noteColorActive = skin.noteColorActive || lightenHex(noteColor, 0.5);
    noteCenterColor = skin.noteCenterColor || "#ffe6d6";
    holdColor = skin.holdColor || "#ff8a3d";
    particleColor = skin.particleColor || "#ffd76b";
    noteRenderer = skin.noteRenderer || null;
    noteRendererId = skin.id || "default";
    spriteCache.clear();
  }

  // Practice Mode: when set, the loop re-seeks and restarts once
  // songTime passes loopEnd. Cleared by passing null via setLoopRegion.
  let loopRegion = null; // { start, end, onLoop }

  // Autoplay: the engine judges every note itself (always PERFECT,
  // exact-time hold press/release) and real input is ignored — see the
  // guards at the top of handleLaneDown/handleLaneUp.
  let autoplay = false;
  let elAutoplayWatermark = null;

  // DOM refs (HUD lives outside canvas per index.html)
  let elCombo, elScore, elJudgement, elKeyRow;

  // ------------------------------------------------------------------
  // Setup
  // ------------------------------------------------------------------
  function init(canvasEl, opts = {}) {
    canvas = canvasEl;
    gfx = canvas.getContext("2d");

    laneCount = opts.laneCount || 6;
    keymap = (opts.keymap || KEYMAPS[laneCount]).slice();
    getSongTime = opts.getSongTime || getSongTime;
    onFinish = opts.onFinish || null;
    setNoteSpeed(opts.noteSpeed || 10);
    applySkin(opts.skin);

    elCombo = document.getElementById("hud-combo-count");
    elScore = document.getElementById("hud-score");
    elJudgement = document.getElementById("judgement-text");
    elKeyRow = document.getElementById("key-row");
    elAutoplayWatermark = document.getElementById("autoplay-watermark");

    buildKeyIndicators();
    resize();
    if (!initialized) {
      window.addEventListener("resize", resize);
      initialized = true;
    }
  }

  function resize() {
    // Capped at 2 — many phones report devicePixelRatio 3, which is
    // imperceptible at normal viewing distance but roughly doubles the
    // pixels the canvas has to fill every frame for zero visible gain.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    gfx.setTransform(dpr, 0, 0, dpr, 0, 0);

    hitLineY = canvas.clientHeight * HIT_LINE_RATIO;
    // Lane spacing scales with actual screen width (clamped to a
    // readable range) instead of a hard 90px cap that left large
    // screens looking cramped relative to their size.
    const laneGap = Math.max(70, Math.min(160, canvas.clientWidth * 0.11));
    const totalWidth = laneGap * (laneCount - 1);
    const startX = canvas.clientWidth / 2 - totalWidth / 2;
    laneX = Array.from({ length: laneCount }, (_, i) => startX + i * laneGap);

    positionKeyIndicators();
  }

  // Key indicators are positioned with an absolute pixel `left` taken
  // directly from laneX — using CSS flex `gap` here would be wrong,
  // since gap only spaces *between* elements and ignores their own
  // width, so it never lines up exactly with the canvas lane centers.
  function positionKeyIndicators() {
    if (!elKeyRow) return;
    // The key labels share the exact canvas lane centers. Their vertical
    // position is also derived from the rendered hit line, rather than a
    // separate CSS percentage, so resizing can never pull the two apart.
    const keyHeight = window.matchMedia("(pointer: coarse)").matches ? 60 : 36;
    const labelTop = Math.min(hitLineY + 18, canvas.clientHeight - keyHeight - 8);
    elKeyRow.style.top = `${labelTop}px`;
    elKeyRow.style.bottom = "auto";
    keymap.forEach((code, i) => {
      const el = elKeyRow.querySelector(`[data-code="${code}"]`);
      if (el) el.style.left = `${laneX[i]}px`;
    });
  }

  function setNoteSpeed(settingValue) {
    // settingValue range 5–20 (see index.html slider) → px/sec.
    pxPerSecond = 300 + settingValue * 40;
  }

  function buildKeyIndicators() {
    elKeyRow.innerHTML = "";
    keymap.forEach((code) => {
      const div = document.createElement("div");
      div.className = "key-indicator";
      div.dataset.code = code;
      div.textContent = code.replace("Key", "").replace("Digit", "");
      elKeyRow.appendChild(div);
    });
  }

  // ------------------------------------------------------------------
  // Beatmap lifecycle
  // ------------------------------------------------------------------
  function loadBeatmap(map) {
    beatmap = map;
    // Defensive copy + sort by time so spawn scheduling can walk forward.
    beatmap.notes = [...map.notes].sort((a, b) => a.time - b.time);
  }

  function start() {
    activeNotes = [];
    noteCursor = 0;
    // Practice Mode: skip straight to the first note at/after the loop's
    // start point. Leaving noteCursor at 0 would spawn every earlier
    // note instantly (since spawnDueNotes fast-forwards through anything
    // already "due") and immediately judge each one MISS, since they'd
    // already be past their hit window — a burst of misses on every lap.
    if (loopRegion && beatmap) {
      const idx = beatmap.notes.findIndex((n) => n.time >= loopRegion.start);
      noteCursor = idx === -1 ? beatmap.notes.length : idx;
    }
    heldLanes.clear();
    activeHolds.clear();
    particles = [];
    combo = 0; maxCombo = 0; score = 0;
    counts = { perfect: 0, great: 0, miss: 0 };
    totalJudged = 0; accuracySum = 0;
    running = true;
    lastFrameTime = performance.now();
    updateHud();
    loop();
  }

  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
  }

  // ------------------------------------------------------------------
  // Main loop
  // ------------------------------------------------------------------
  function loop() {
    if (!running) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameTime) / 1000); // clamp guards against huge jumps (tab switch etc.)
    lastFrameTime = now;
    const songTime = getSongTime();

    spawnDueNotes(songTime);
    updateAutoplay(songTime);
    updateHolds(songTime);
    expireMissedNotes(songTime);
    updateParticles(dt);
    render(songTime);

    if (loopRegion && songTime >= loopRegion.end) {
      loopRegion.onLoop(); // caller re-seeks audio back to loopRegion.start
      start();             // fresh attempt each lap: resets combo/score/notes,
      return;               // and already schedules its own next frame — don't double-schedule
    }

    if (!loopRegion && beatmap && songTime > beatmap.notes[beatmap.notes.length - 1]?.time + 2 &&
        activeNotes.length === 0) {
      running = false;
      onFinish && onFinish(buildResultStats());
      return;
    }

    rafId = requestAnimationFrame(loop);
  }

  // Practice Mode support — pass null to clear. `onLoop` is called right
  // before the engine resets, so the caller can re-seek AudioManager to
  // `start` first (engine doesn't own audio playback).
  function setLoopRegion(region) {
    loopRegion = region;
  }

  function setAutoplay(enabled) {
    autoplay = !!enabled;
    if (elAutoplayWatermark) elAutoplayWatermark.hidden = !autoplay;
    // Real input state shouldn't linger from before autoplay was toggled on.
    if (autoplay) {
      heldLanes.clear();
      activeHolds.clear();
    }
  }

  // Presses every tap note and holds/releases every Hold note the
  // instant it's due — always exactly on time, so it always grades
  // PERFECT. Runs every frame right after notes spawn, before the
  // miss-expiry check, so a note is never left long enough to miss.
  function updateAutoplay(songTime) {
    if (!autoplay) return;

    for (const note of activeNotes) {
      if (note.judged || note.holdActive) continue;
      if (songTime < note.time) continue;

      if (note.type === "hold") {
        note.holdActive = true;
        note.headQuality = "perfect";
        activeHolds.set(note.lane, note);
        setKeyIndicatorActive(note.lane, true);
        spawnHitParticles(note.lane, "perfect");
      } else {
        setKeyIndicatorActive(note.lane, true);
        judge(note, "perfect");
        // Tap indicators don't get an explicit "up" event from autoplay
        // since there's no hold to release — clear the flash shortly after.
        setTimeout(() => setKeyIndicatorActive(note.lane, false), 90);
      }
    }

    activeHolds.forEach((note, lane) => {
      if (songTime >= note.time + note.duration) {
        activeHolds.delete(lane);
        setKeyIndicatorActive(lane, false);
        judge(note, "perfect");
      }
    });
  }


  function spawnDueNotes(songTime) {
    const leadTime = hitLineY / pxPerSecond; // seconds before hit-time a note must appear
    while (
      noteCursor < beatmap.notes.length &&
      beatmap.notes[noteCursor].time - leadTime <= songTime
    ) {
      const src = beatmap.notes[noteCursor];
      activeNotes.push({
        ...src,
        judged: false,
        holdActive: false,
        holdReleased: false,
      });
      noteCursor++;
    }
  }

  // Holds: while a lane's key is down and the hold note's window is
  // active, keep it "alive"; if released early or too late, judge it.
  function updateHolds(songTime) {
    activeHolds.forEach((note, lane) => {
      const tailTime = note.time + note.duration;
      if (songTime > tailTime + HOLD_TAIL_TOLERANCE_MS / 1000) {
        // Player never released in time — resolve as whatever quality
        // the head was; hold auto-completes.
        activeHolds.delete(lane);
      }
    });
  }

  function expireMissedNotes(songTime) {
    // Manual backward loop + splice instead of .filter(): filter()
    // allocates a brand new array 60 times a second even when nothing
    // expires, which was a real contributor to the frame jitter.
    for (let i = activeNotes.length - 1; i >= 0; i--) {
      const note = activeNotes[i];
      if (note.judged) { activeNotes.splice(i, 1); continue; }
      const deadline = note.type === "hold" ? note.time + note.duration : note.time;
      if (songTime - deadline > GREAT_WINDOW_MS / 1000) {
        activeNotes.splice(i, 1);
        note.judged = true;
        resolveJudgement(note, "miss");
      }
    }
  }

  // ------------------------------------------------------------------
  // Input — keyboard and touch both funnel into handleLaneDown/Up,
  // which operate on a lane index directly. Keyboard resolves a code
  // to a lane first; touch already knows the lane (from which zone was
  // tapped), so it skips the lookup entirely.
  // ------------------------------------------------------------------
  function handleKeyDown(code) {
    const lane = keymap.indexOf(code);
    if (lane !== -1) handleLaneDown(lane);
  }

  function handleKeyUp(code) {
    const lane = keymap.indexOf(code);
    if (lane !== -1) handleLaneUp(lane);
  }

  function handleLaneDown(lane) {
    if (autoplay) return; // autoplay judges every note itself — real input is ignored to avoid double-judging
    if (lane < 0 || lane >= laneCount || heldLanes.has(lane)) return;
    heldLanes.add(lane);
    setKeyIndicatorActive(lane, true);

    const songTime = getSongTime();
    const note = findJudgeableNoteInLane(lane, songTime);
    if (!note) return; // no note nearby — allowed, just no judgement (ghost tap)

    const deltaMs = (songTime - note.time) * 1000;
    const quality = qualityFromDelta(deltaMs);
    if (quality === "miss") return; // outside window entirely, ignore as ghost tap

    if (note.type === "hold") {
      note.holdActive = true;
      note.headQuality = quality; // final grade blends head timing
      activeHolds.set(lane, note);
      spawnHitParticles(lane, quality);
    } else {
      judge(note, quality);
    }
  }

  function handleLaneUp(lane) {
    if (autoplay) return;
    if (lane < 0 || lane >= laneCount) return;
    heldLanes.delete(lane);
    setKeyIndicatorActive(lane, false);

    const note = activeHolds.get(lane);
    if (!note) return;
    activeHolds.delete(lane);

    const songTime = getSongTime();
    const tailTime = note.time + note.duration;
    const deltaMs = (songTime - tailTime) * 1000;
    // Released within tolerance of the tail → honor head quality,
    // otherwise downgrade to "great" (early/late release, still counted).
    const finalQuality = Math.abs(deltaMs) <= HOLD_TAIL_TOLERANCE_MS
      ? note.headQuality
      : "great";
    judge(note, finalQuality);
  }

  function findJudgeableNoteInLane(lane, songTime) {
    let best = null, bestDelta = Infinity;
    for (const note of activeNotes) {
      if (note.lane !== lane || note.judged || note.holdActive) continue;
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

  // Indexes directly into elKeyRow's children (built in lane order by
  // buildKeyIndicators), avoiding a second code→element lookup.
  function setKeyIndicatorActive(lane, active) {
    const el = elKeyRow.children[lane];
    if (el) el.classList.toggle("active", active);
  }

  // ------------------------------------------------------------------
  // Judgement resolution — scoring, combo, HUD, particles
  // ------------------------------------------------------------------
  function judge(note, quality) {
    note.judged = true;
    const idx = activeNotes.indexOf(note);
    if (idx !== -1) activeNotes.splice(idx, 1);
    resolveJudgement(note, quality);
  }

  // Shared scoring/combo/HUD/particle logic — called either from judge()
  // (player input) or directly from expireMissedNotes() (which already
  // handles its own array removal via splice, see above).
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
      spawnHitParticles(note.lane, quality);
    }

    showJudgementText(quality);
    window.AudioManager?.playSfx(quality);
    updateHud();
  }

  function buildResultStats() {
    const accuracy = totalJudged ? (accuracySum / totalJudged) * 100 : 0;
    let rank = "C";
    if (accuracy >= 98) rank = "S";
    else if (accuracy >= 92) rank = "A";
    else if (accuracy >= 80) rank = "B";
    return {
      score, maxCombo, accuracy,
      perfect: counts.perfect, great: counts.great, miss: counts.miss,
      rank,
    };
  }

  // ------------------------------------------------------------------
  // HUD (cheap DOM writes, not part of canvas render)
  // ------------------------------------------------------------------
  function updateHud() {
    if (elCombo) elCombo.textContent = combo;
    if (elScore) {
      const acc = totalJudged ? ((accuracySum / totalJudged) * 100).toFixed(1) : "0.0";
      elScore.textContent = `${score} (${acc}%)`;
    }
  }

  let judgementFadeTimer = null;
  function showJudgementText(quality) {
    if (!elJudgement) return;
    elJudgement.textContent = JUDGEMENT_LABEL[quality];
    elJudgement.className = `judgement-text show judgement-${quality}`;
    clearTimeout(judgementFadeTimer);
    judgementFadeTimer = setTimeout(() => {
      elJudgement.classList.remove("show");
    }, 260);
  }

  // ------------------------------------------------------------------
  // Particles — simple burst of petal-colored dots on hit
  // ------------------------------------------------------------------
  function spawnHitParticles(lane, quality) {
    const x = laneX[lane];
    const y = hitLineY;
    const color = quality === "perfect" ? particleColor : noteColor;
    const count = quality === "perfect" ? 14 : 9;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.3;
      const speed = 120 + Math.random() * 160;
      particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 80,
        life: 1,
        color,
        size: 3 + Math.random() * 3,
      });
    }
  }

  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 400 * dt; // gravity
      p.life -= dt * 1.6;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  function render(songTime) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    gfx.clearRect(0, 0, w, h);

    drawLanes(w, h);
    drawHitLine(w);
    activeNotes.forEach((note) => drawNote(note, songTime));
    drawParticles();
  }

  function drawLanes(w, h) {
    // Slightly darker/thicker than before per feedback — was nearly
    // invisible at 0.12 opacity / 1px.
    gfx.strokeStyle = "rgba(244,234,210,0.18)";
    gfx.lineWidth = 1.5;
    laneX.forEach((x) => {
      gfx.beginPath();
      gfx.moveTo(x, 0);
      gfx.lineTo(x, hitLineY + 10);
      gfx.stroke();
    });
  }

  function drawHitLine(w) {
    gfx.strokeStyle = "rgba(255,248,229,0.84)";
    gfx.lineWidth = 1.5;
    gfx.beginPath();
    gfx.moveTo(laneX[0] - 30, hitLineY);
    gfx.lineTo(laneX[laneX.length - 1] + 30, hitLineY);
    gfx.stroke();

    // Bright circular markers at the exact lane centers. The matching
    // keyboard labels below use the same `laneX` values in positionKeyIndicators().
    laneX.forEach((x) => {
      gfx.beginPath();
      gfx.arc(x, hitLineY, 9, 0, Math.PI * 2);
      gfx.fillStyle = "rgba(255,255,255,0.96)";
      gfx.fill();
      gfx.strokeStyle = "rgba(255,248,229,0.94)";
      gfx.lineWidth = 2;
      gfx.stroke();
    });
  }

  const HOLD_BAR_WIDTH = 30; // wide bar per feedback (was 14px, too thin)

  function drawNote(note, songTime) {
    const x = laneX[note.lane];

    if (note.type === "hold") {
      const headY = yForTime(note.time, songTime);           // arrives at hit line first (press here)
      const tailY = yForTime(note.time + note.duration, songTime); // arrives later (release here)
      const barTop = Math.min(tailY, hitLineY);
      const barBottom = Math.min(headY, hitLineY);
      const barHeight = Math.max(0, barBottom - barTop);
      const half = HOLD_BAR_WIDTH / 2;

      if (barHeight > 0) {
        const grad = gfx.createLinearGradient(0, barTop, 0, barBottom);
        grad.addColorStop(0, withAlpha(holdColor, 0.25));
        grad.addColorStop(1, withAlpha(holdColor, 0.8));
        gfx.fillStyle = grad;
        gfx.fillRect(x - half, barTop, HOLD_BAR_WIDTH, barHeight);
        gfx.strokeStyle = "rgba(255,224,163,0.5)"; // fixed gold accent, not skin-dependent
        gfx.lineWidth = 1.5;
        gfx.strokeRect(x - half, barTop, HOLD_BAR_WIDTH, barHeight);
      }

      // Head and tail both drawn as the same shape as a Tap note —
      // symmetric, matches how it should be judged (either end is a
      // normal hit), simpler to read than a mismatched head/tail pair.
      drawNoteSprite(x, headY, note.holdActive ? noteColorActive : noteColor);
      drawNoteSprite(x, tailY, note.holdActive ? noteColorActive : noteColor);
    } else {
      const y = yForTime(note.time, songTime);
      drawNoteSprite(x, y, noteColor);
    }
  }

  function yForTime(noteTime, songTime) {
    return hitLineY - (noteTime - songTime) * pxPerSecond;
  }

  // Pre-rendered sprite cache — the note shape (with or without glow)
  // is drawn to an offscreen canvas exactly once per distinct
  // shape+color combo, then every frame just does a cheap drawImage()
  // instead of redoing the path + shadowBlur math 60 times a second
  // per note. This was the single biggest contributor to mobile
  // jitter: shadowBlur is costly on phone GPUs, and it was being
  // recomputed for every visible note on every single frame.
  const spriteCache = new Map();

  function getNoteSprite(color) {
    const key = noteRendererId + "|" + color + "|" + noteCenterColor + "|" + useGlow;
    let sprite = spriteCache.get(key);
    if (sprite) return sprite;

    const pad = useGlow ? 20 : 6;
    const size = NOTE_RADIUS * 2 + pad * 2;
    sprite = document.createElement("canvas");
    sprite.width = size;
    sprite.height = size;
    const sgfx = sprite.getContext("2d");
    sgfx.translate(size / 2, size / 2);
    if (useGlow) sgfx.shadowColor = color;

    if (noteRenderer && typeof noteRenderer.draw === "function") {
      noteRenderer.draw(sgfx, {
        radius: NOTE_RADIUS,
        color,
        centerColor: noteCenterColor,
        useGlow,
      });
    } else {
      // A broken third-party skin must not make notes invisible. The
      // built-in default renderer is normally loaded before play starts.
      if (useGlow) sgfx.shadowBlur = 10;
      sgfx.fillStyle = color;
      sgfx.beginPath();
      sgfx.arc(0, 0, NOTE_RADIUS * 0.72, 0, Math.PI * 2);
      sgfx.fill();
    }

    spriteCache.set(key, sprite);
    return sprite;
  }

  function drawNoteSprite(x, y, color) {
    const sprite = getNoteSprite(color);
    gfx.drawImage(sprite, x - sprite.width / 2, y - sprite.height / 2);
  }

  function drawParticles() {
    particles.forEach((p) => {
      gfx.globalAlpha = Math.max(0, p.life);
      gfx.fillStyle = p.color;
      gfx.beginPath();
      gfx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      gfx.fill();
    });
    gfx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------
  return {
    KEYMAPS,
    init,
    loadBeatmap,
    start,
    stop,
    setNoteSpeed,
    handleKeyDown,
    handleKeyUp,
    handleLaneDown,
    handleLaneUp,
    setLoopRegion,
    setAutoplay,
    applySkin,
    resize,
  };
})();

window.GameEngine = GameEngine;
