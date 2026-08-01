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

    elCombo = document.getElementById("hud-combo-count");
    elScore = document.getElementById("hud-score");
    elJudgement = document.getElementById("judgement-text");
    elKeyRow = document.getElementById("key-row");

    buildKeyIndicators();
    resize();
    if (!initialized) {
      window.addEventListener("resize", resize);
      initialized = true;
    }
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
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
    updateHolds(songTime);
    expireMissedNotes(songTime);
    updateParticles(dt);
    render(songTime);

    if (beatmap && songTime > beatmap.notes[beatmap.notes.length - 1]?.time + 2 &&
        activeNotes.length === 0) {
      running = false;
      onFinish && onFinish(buildResultStats());
      return;
    }

    rafId = requestAnimationFrame(loop);
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
  // Input
  // ------------------------------------------------------------------
  function handleKeyDown(code) {
    const lane = keymap.indexOf(code);
    if (lane === -1 || heldLanes.has(lane)) return;
    heldLanes.add(lane);
    setKeyIndicatorActive(code, true);

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

  function handleKeyUp(code) {
    const lane = keymap.indexOf(code);
    if (lane === -1) return;
    heldLanes.delete(lane);
    setKeyIndicatorActive(code, false);

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

  function setKeyIndicatorActive(code, active) {
    const el = elKeyRow.querySelector(`[data-code="${code}"]`);
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
    const color = quality === "perfect" ? "#ffd76b" : "#ff9f6b";
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
    gfx.strokeStyle = "rgba(244,234,210,0.12)";
    gfx.lineWidth = 1;
    laneX.forEach((x) => {
      gfx.beginPath();
      gfx.moveTo(x, 0);
      gfx.lineTo(x, hitLineY + 10);
      gfx.stroke();
    });
  }

  function drawHitLine(w) {
    gfx.strokeStyle = "rgba(245,197,107,0.5)";
    gfx.lineWidth = 2;
    gfx.beginPath();
    gfx.moveTo(laneX[0] - 30, hitLineY);
    gfx.lineTo(laneX[laneX.length - 1] + 30, hitLineY);
    gfx.stroke();
  }

  function drawNote(note, songTime) {
    const x = laneX[note.lane];

    if (note.type === "hold") {
      const headY = yForTime(note.time, songTime);           // arrives at hit line first (press here)
      const tailY = yForTime(note.time + note.duration, songTime); // arrives later (release here)
      const barTop = Math.min(tailY, hitLineY);
      const barBottom = Math.min(headY, hitLineY);
      const barHeight = Math.max(0, barBottom - barTop);

      if (barHeight > 0) {
        const grad = gfx.createLinearGradient(0, barTop, 0, barBottom);
        grad.addColorStop(0, "rgba(255,138,61,0.22)");
        grad.addColorStop(1, "rgba(255,138,61,0.75)");
        gfx.fillStyle = grad;
        gfx.fillRect(x - 7, barTop, 14, barHeight);
        gfx.strokeStyle = "rgba(255,224,163,0.45)";
        gfx.lineWidth = 1.5;
        gfx.strokeRect(x - 7, barTop, 14, barHeight);
      }

      drawFlower(x, headY, note.holdActive ? "#ffe6d6" : "#ff9f6b");      // head: filled flower, same as a tap note — press here
      drawHoldTailMarker(x, tailY, note.holdActive);                      // tail: hollow ring + arrow — release here
    } else {
      const y = yForTime(note.time, songTime);
      drawFlower(x, y, "#ff9f6b");
    }
  }

  // Distinct silhouette from the head flower on purpose — a ring with a
  // small downward chevron reads as "release point" at a glance, instead
  // of looking like a second tap note stacked on the same lane.
  function drawHoldTailMarker(x, y, active) {
    const r = NOTE_RADIUS * 0.55;
    gfx.save();
    gfx.translate(x, y);
    gfx.strokeStyle = active ? "#ffe6d6" : "rgba(255,159,107,0.85)";
    gfx.lineWidth = 3;
    gfx.beginPath();
    gfx.arc(0, 0, r, 0, Math.PI * 2);
    gfx.stroke();
    gfx.beginPath();
    gfx.moveTo(-7, r + 4);
    gfx.lineTo(0, r + 13);
    gfx.lineTo(7, r + 4);
    gfx.stroke();
    gfx.restore();
  }

  function yForTime(noteTime, songTime) {
    return hitLineY - (noteTime - songTime) * pxPerSecond;
  }

  // Stylized 6-petal flower, placeholder for note_tap.png per spec —
  // swap fillFlowerSprite() in for an <img> draw once assets exist.
  function drawFlower(x, y, color) {
    const petals = 6;
    const r = NOTE_RADIUS;
    gfx.save();
    gfx.translate(x, y);
    gfx.shadowColor = color;
    gfx.shadowBlur = 10;
    for (let i = 0; i < petals; i++) {
      gfx.rotate((Math.PI * 2) / petals);
      gfx.beginPath();
      gfx.ellipse(0, -r * 0.55, r * 0.4, r * 0.55, 0, 0, Math.PI * 2);
      gfx.fillStyle = color;
      gfx.fill();
    }
    gfx.beginPath();
    gfx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
    gfx.fillStyle = "#ffe6d6";
    gfx.shadowBlur = 4;
    gfx.fill();
    gfx.restore();
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
    resize,
  };
})();

window.GameEngine = GameEngine;
