/* ==========================================================================
   CHARTGEN.JS
   Everything about turning audio or raw JSON into a playable beatmap:
     - validateBeatmap: cleans a loaded/imported beatmap so the engine
       never receives a note it cannot draw or hit
     - conflicts: the one rule for "can these two notes share a lane?"
     - generateGridChart: notes laid on a BPM grid (the plain fallback when
       smartchart.js cannot find a steady beat)

   Rules enforced everywhere (generator, editor, imports):
     - Only 4, 6 and 8 keys exist.
     - After a hold ends, the same lane stays empty for HOLD_GAP_S, so a
       player has time to release and press again.

   Exposes a single global: window.ChartGen
   ========================================================================== */

const ChartGen = (() => {

  const SUPPORTED_KEYS = [4, 6, 8];
  const HOLD_GAP_S = 0.5;           // empty time in a lane after a hold's tail
  const MIN_HOLD_S = 0.15;          // shortest hold that stays a hold when trimmed
  const MIN_GEN_HOLD_S = 0.3;       // generators never make a hold shorter than this
  const TAP_GAP_S = 0.03;           // two notes closer than this in one lane are duplicates
  const CHORD_CHANCE = 0.12;        // chance a beat also gets a second, simultaneous tap

  // An error with a machine-readable code, so the UI can show it in the
  // player's language instead of a hard-coded sentence.
  class ChartError extends Error {
    constructor(code, params = {}) {
      super(code);
      this.code = code;
      this.params = params;
    }
  }

  const noteEnd = (n) => n.time + (n.type === "hold" ? n.duration : 0);

  // Can notes a and b live in the same lane? Returns true when they clash.
  function conflicts(a, b) {
    const [first, second] = a.time <= b.time ? [a, b] : [b, a];
    const needed = first.type === "hold" ? HOLD_GAP_S : TAP_GAP_S;
    return second.time < noteEnd(first) + needed;
  }

  // ------------------------------------------------------------------
  // Validation
  // ------------------------------------------------------------------
  // Used only when a beatmap does not declare how many keys it has.
  function inferLaneCount(notes) {
    const maxLane = notes.reduce((max, n) => Math.max(max, Math.floor(+n.lane) || 0), 0);
    if (maxLane <= 3) return 4;
    if (maxLane <= 5) return 6;
    if (maxLane <= 7) return 8;
    return null;
  }

  // Returns a cleaned copy or throws a ChartError.
  //   dropped:  notes removed (bad numbers, lane out of range, duplicates)
  //   adjusted: holds shortened or turned into taps to keep the gap
  function validateBeatmap(raw) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.notes)) {
      throw new ChartError("invalid_beatmap");
    }

    let laneCount;
    if (raw.laneCount === undefined || raw.laneCount === null) {
      laneCount = inferLaneCount(raw.notes);
      if (laneCount === null) throw new ChartError("too_many_lanes");
    } else {
      laneCount = Number(raw.laneCount);
      if (!SUPPORTED_KEYS.includes(laneCount)) throw new ChartError("unsupported_keys", { count: raw.laneCount });
    }

    const cleaned = [];
    for (const n of raw.notes) {
      const time = Number(n?.time);
      const lane = Math.floor(Number(n?.lane));
      if (!Number.isFinite(time) || time < 0 || !(lane >= 0 && lane < laneCount)) continue;
      const duration = Number(n.duration);
      if (n.type === "hold" && duration > 0.05) cleaned.push({ time, lane, type: "hold", duration });
      else cleaned.push({ time, lane, type: "tap" });
    }
    cleaned.sort((a, b) => a.time - b.time || a.lane - b.lane);

    // Walk each lane in time order. A hold that runs into the next note is
    // shortened to leave HOLD_GAP_S, or becomes a tap when too little is left.
    const lastInLane = new Array(laneCount).fill(null);
    const notes = [];
    let adjusted = 0;
    for (const n of cleaned) {
      const last = lastInLane[n.lane];
      if (last) {
        if (last.type === "hold" && n.time < noteEnd(last) + HOLD_GAP_S) {
          const trimmed = n.time - HOLD_GAP_S - last.time;
          if (trimmed >= MIN_HOLD_S) last.duration = trimmed;
          else { last.type = "tap"; delete last.duration; }
          adjusted++;
        }
        if (n.time - last.time < TAP_GAP_S) continue; // duplicate in the same lane
      }
      notes.push(n);
      lastInLane[n.lane] = n;
    }
    if (!notes.length) throw new ChartError("no_valid_notes");

    return {
      songTitle: raw.songTitle || "",
      bpm: Number(raw.bpm) || 120,
      offset: Number(raw.offset) || 0,
      laneCount,
      notes,
      dropped: raw.notes.length - notes.length,
      adjusted,
    };
  }

  // ------------------------------------------------------------------
  // Beat grid
  // ------------------------------------------------------------------
  function pickHold(noteType) {
    if (noteType === "hold") return true;
    if (noteType === "tap") return false;
    return Math.random() < 0.15; // "mixed": mostly taps, occasional holds
  }

  function generateGridChart(durationSec, bpm, noteType, laneCount, offsetMs = 0) {
    const notes = [];
    const beatSec = 60 / bpm;
    const busyUntil = new Array(laneCount).fill(0);
    const offsetSec = offsetMs / 1000;

    // The lead-in/out margin scales with the clip, so very short clips
    // still get notes.
    const margin = Math.min(2, Math.max(0, durationSec * 0.15));
    const start = margin + Math.max(0, offsetSec);
    const end = Math.max(start + beatSec, durationSec - margin);

    for (let t = start; t < end; t += beatSec) {
      if (Math.random() >= 0.6) continue;
      const free = [];
      for (let l = 0; l < laneCount; l++) if (busyUntil[l] <= t) free.push(l);
      if (!free.length) continue;

      const lane = free.splice(Math.floor(Math.random() * free.length), 1)[0];
      if (pickHold(noteType)) {
        const duration = Math.max(MIN_GEN_HOLD_S, beatSec * (1 + Math.floor(Math.random() * 2)));
        notes.push({ time: t, lane, type: "hold", duration });
        busyUntil[lane] = t + duration + HOLD_GAP_S;
      } else {
        notes.push({ time: t, lane, type: "tap" });
        busyUntil[lane] = t + TAP_GAP_S;
        if (noteType !== "hold" && free.length && Math.random() < CHORD_CHANCE) {
          const second = free[Math.floor(Math.random() * free.length)];
          notes.push({ time: t, lane: second, type: "tap" });
          busyUntil[second] = t + TAP_GAP_S;
        }
      }
    }

    // A pathologically short clip must never produce an empty chart.
    if (!notes.length) notes.push({ time: Math.min(0.5, durationSec / 2), lane: 0, type: "tap" });
    return { songTitle: "Auto-generated", bpm, offset: offsetMs, laneCount, notes };
  }

  return {
    SUPPORTED_KEYS, HOLD_GAP_S, MIN_HOLD_S, ChartError,
    conflicts, validateBeatmap, generateGridChart,
  };
})();

window.ChartGen = ChartGen;
