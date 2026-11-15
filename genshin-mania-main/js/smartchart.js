/* ==========================================================================
   SMARTCHART.JS
   Turns decoded audio into a playable beatmap in three levels of effort.
   Pure computation, no DOM: it runs inside js/chartworker.js (so the page
   never freezes) and falls back to the page itself when workers are missing.

   Level 1  Spectrum analysis. Finds the tempo and beat position by trying
            many tempos, puts notes on a 16th-note grid only where the music
            has a real attack, holds follow sustained sound, lanes follow the
            pitch of the sound (low on the left, high on the right).
   Level 2  Adds: beat tracking that follows tempo changes, onset detection
            at several time resolutions, melody pitch, song structure (repeated
            bars reuse the same pattern) and playability rules for lanes.
   Level 3  Adds: finer timing, then builds many candidate charts, scores each
            one against the music and keeps the best, with a time limit.

   Everything is deterministic: the same audio gives the same chart.

   Exposes a single global: SmartChart
   ========================================================================== */

const SmartChart = (() => {
  "use strict";

  // Keep these equal to the rules in chartgen.js (the worker does not load it).
  const HOLD_GAP_S = 0.5;
  const TAP_GAP_S = 0.03;

  const TARGET_SR = 22050;
  const BANDS = 48;
  const MIN_CLIP_S = 8;
  const MIN_CONFIDENCE = 5;       // tempo z-score below this means "no steady beat"
  const MIN_FLUX = 0.03;          // below this the sound is steady, with no attacks (music 0.2 to 1.4, steady tone 0.003)
  const SEARCH_LIMIT_MS = 30000;  // level 3 candidate search never runs longer
  const HAS_DOM = typeof document !== "undefined";
  // How alike two bars must be (harmony and rhythm) to share one pattern.
  const TUNE = { repeatSim: 0.95, repeatRhythm: 0.8 };

  // Per level: frame step, spectrum windows, and which extras are switched on.
  // lag = seconds between a frame's centre and the attack it reports. Set
  // from synthetic clicks, then moved ~9 ms earlier after comparing note times
  // with the real attack in a recorded song (real attacks rise more slowly).
  const LEVELS = {
    1: { H: 256, lag: 0.0034, res: [{ N: 1024, mf: false, w: 1 }], beats: false, structure: false, pitch: false, search: false },
    2: { H: 256, lag: 0.0015, res: [{ N: 1024, mf: true, w: 1 }, { N: 2048, mf: true, w: 0.8 }], beats: true, structure: true, pitch: true, search: false },
    3: { H: 128, lag: -0.0018, res: [{ N: 1024, mf: true, w: 1 }, { N: 2048, mf: true, w: 0.8 }, { N: 4096, mf: true, w: 0.6 }], beats: true, structure: true, pitch: true, search: true },
  };

  // Difficulty: how picky note selection is, spacing, cap per second and
  // how willing the chart is to use holds and chords.
  const DIFFS = {
    easy:   { thr: 2.2,  gap: 0.28,  cap: 3, holdMin: 0.60, holdTop: 0.05, holdMaxHalf: 6, holdAtOnce: 1, chord: 0,   chordMax: 0,    target: 1.4 },
    normal: { thr: 1.5,  gap: 0.18,  cap: 5, holdMin: 0.45, holdTop: 0.08, holdMaxHalf: 8, holdAtOnce: 1, chord: 1.9, chordMax: 0.08, target: 2.3 },
    hard:   { thr: 1.05, gap: 0.105, cap: 8, holdMin: 0.40, holdTop: 0.11, holdMaxHalf: 8, holdAtOnce: 2, chord: 1.5, chordMax: 0.15, target: 4.0 },
  };
  // Threshold per beat position: main beat, half beat, sixteenth.
  const TIER_THR = [0.32, 0.55, 1.0];
  const TIER_OF_SLOT = [0, 2, 1, 2];

  class SmartChartError extends Error {
    constructor(code, extra = {}) {
      super(code);
      this.code = code;
      Object.assign(this, extra);
    }
  }
  class Cancelled extends Error {}

  // ------------------------------------------------------------------
  // Small helpers
  // ------------------------------------------------------------------
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  function percentile(arr, p) {
    if (!arr.length) return 0;
    const c = Float32Array.from(arr);
    c.sort();
    return c[Math.min(c.length - 1, Math.floor(p * (c.length - 1)))];
  }
  const median = (arr) => percentile(arr, 0.5);

  function mulberry32(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function movingMean(a, r) {
    const n = a.length, pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + a[i];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1);
      out[i] = (pre[hi] - pre[lo]) / (hi - lo);
    }
    return out;
  }

  // Lets the page breathe when the analysis runs on the main thread.
  let lastYield = 0;
  async function maybeYield(ctrl) {
    if (ctrl && ctrl.cancelled) throw new Cancelled();
    if (!HAS_DOM) return;
    const t = now();
    if (t - lastYield > 30) {
      lastYield = t;
      await new Promise((r) => setTimeout(r, 0));
      if (ctrl && ctrl.cancelled) throw new Cancelled();
    }
  }

  // ------------------------------------------------------------------
  // FFT (radix 2). Two real frames go through one complex transform.
  // ------------------------------------------------------------------
  const fftCache = new Map();
  const hannCache = new Map();

  function getFFT(n) {
    if (fftCache.has(n)) return fftCache.get(n);
    const levels = Math.round(Math.log2(n));
    const cos = new Float32Array(n >> 1), sin = new Float32Array(n >> 1);
    for (let i = 0; i < (n >> 1); i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) rev[i] = (rev[i >> 1] >> 1) | ((i & 1) << (levels - 1));
    const fn = (re, im) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (j > i) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const l = j + half;
            const tre = re[l] * cos[k] + im[l] * sin[k];
            const tim = im[l] * cos[k] - re[l] * sin[k];
            re[l] = re[j] - tre; im[l] = im[j] - tim;
            re[j] += tre; im[j] += tim;
          }
        }
      }
    };
    fftCache.set(n, fn);
    return fn;
  }

  function getHann(n) {
    if (hannCache.has(n)) return hannCache.get(n);
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    hannCache.set(n, w);
    return w;
  }

  // Calls cb(frameIndex, magnitudes[0..N/2), frameRms) for every frame.
  async function forEachSpectrum(x, N, H, ctrl, cb, onFrac) {
    const frames = Math.floor((x.length - N) / H) + 1;
    const fft = getFFT(N), win = getHann(N), half = N >> 1;
    const re = new Float32Array(N), im = new Float32Array(N);
    const m1 = new Float32Array(half), m2 = new Float32Array(half);
    for (let f = 0; f < frames; f += 2) {
      const f2 = f + 1 < frames ? f + 1 : -1;
      const o1 = f * H, o2 = f2 * H;
      let e1 = 0, e2 = 0;
      for (let i = 0; i < N; i++) {
        const a = x[o1 + i];
        e1 += a * a;
        re[i] = a * win[i];
        if (f2 >= 0) { const b = x[o2 + i]; e2 += b * b; im[i] = b * win[i]; } else im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k < half; k++) {
        const j = N - k;
        const ar = re[k] + re[j], ai = im[k] - im[j];
        const br = im[k] + im[j], bi = re[j] - re[k];
        m1[k] = 0.5 * Math.sqrt(ar * ar + ai * ai);
        m2[k] = 0.5 * Math.sqrt(br * br + bi * bi);
      }
      cb(f, m1, Math.sqrt(e1 / N));
      if (f2 >= 0) cb(f2, m2, Math.sqrt(e2 / N));
      if ((f & 127) === 0) {
        if (onFrac) onFrac(f / frames);
        await maybeYield(ctrl);
      }
    }
    return frames;
  }

  // Log-spaced band spectrogram (BANDS bands, 60 Hz to 9 kHz), compressed.
  async function bandSpectrogram(x, sr, N, H, ctrl, onFrac) {
    const half = N >> 1, binHz = sr / N;
    const lo = new Int32Array(BANDS), hi = new Int32Array(BANDS);
    const fmin = 60, fmax = Math.min(9000, sr * 0.45);
    for (let b = 0; b < BANDS; b++) {
      const f0 = fmin * Math.pow(fmax / fmin, b / BANDS);
      const f1 = fmin * Math.pow(fmax / fmin, (b + 1) / BANDS);
      const l = Math.min(Math.max(1, Math.floor(f0 / binHz)), half - 2);
      lo[b] = l;
      hi[b] = Math.min(Math.max(l + 1, Math.ceil(f1 / binHz)), half);
    }
    const frames = Math.floor((x.length - N) / H) + 1;
    if (frames < 16) throw new SmartChartError("too_short");
    const S = new Float32Array(frames * BANDS), rms = new Float32Array(frames);
    const scale = (4 / N) * 80, norm = 1 / Math.log(81);
    await forEachSpectrum(x, N, H, ctrl, (f, mag, r) => {
      rms[f] = r;
      const o = f * BANDS;
      for (let b = 0; b < BANDS; b++) {
        let s = 0;
        const h = hi[b];
        for (let k = lo[b]; k < h; k++) s += mag[k];
        S[o + b] = Math.log1p((s / (h - lo[b])) * scale) * norm;
      }
    }, onFrac);
    return { N, H, S, rms, frames, t0: N / 2 / sr, dt: H / sr };
  }

  // 12-value pitch-class profile per frame (used to compare bars).
  async function chromaFrames(x, sr, ctrl, onFrac) {
    const N = 2048, H = 1024, half = N >> 1, binHz = sr / N;
    const kLo = Math.ceil(160 / binHz), kHi = Math.min(half - 1, Math.floor(2800 / binHz));
    const pc = new Int8Array(half).fill(-1);
    for (let k = kLo; k <= kHi; k++) {
      const midi = Math.round(69 + 12 * Math.log2((k * binHz) / 440));
      pc[k] = ((midi % 12) + 12) % 12;
    }
    const frames = Math.floor((x.length - N) / H) + 1;
    const C = new Float32Array(Math.max(1, frames) * 12);
    await forEachSpectrum(x, N, H, ctrl, (f, mag) => {
      const o = f * 12;
      for (let k = kLo; k <= kHi; k++) C[o + pc[k]] += Math.sqrt(mag[k]);
    }, onFrac);
    return { C, frames, t0: N / 2 / sr, dt: H / sr };
  }

  // ------------------------------------------------------------------
  // Onset strength: how much new sound appears in each frame.
  // Level 1 uses plain spectral flux. Levels 2 and 3 compare against the
  // loudest neighbouring band of the previous frame (SuperFlux), which
  // ignores the small pitch wobble of voices and strings.
  // ------------------------------------------------------------------
  function fluxOf(S, frames, maxFilter) {
    const out = new Float32Array(frames);
    for (let f = 1; f < frames; f++) {
      let sum = 0;
      const c = f * BANDS, p = (f - 1) * BANDS;
      for (let b = 0; b < BANDS; b++) {
        let prev = S[p + b];
        if (maxFilter) {
          if (b > 0 && S[p + b - 1] > prev) prev = S[p + b - 1];
          if (b < BANDS - 1 && S[p + b + 1] > prev) prev = S[p + b + 1];
        }
        const d = S[c + b] - prev;
        if (d > 0) sum += d;
      }
      out[f] = sum;
    }
    return out;
  }

  function buildEnvelope(specs, cfg) {
    const base = specs[0], frames = base.frames, env = new Float32Array(frames);
    specs.forEach((sp, i) => {
      const fl = fluxOf(sp.S, sp.frames, cfg.res[i].mf);
      const p95 = percentile(fl, 0.95);
      if (i === 0) env.rawP95 = p95;     // loudness of the attacks before normalising
      const norm = 1 / (p95 + 1e-6);
      const shift = Math.round((sp.N - base.N) / (2 * cfg.H));
      for (let f = 0; f < frames; f++) {
        const idx = f - shift;
        if (idx >= 1 && idx < sp.frames) env[f] += cfg.res[i].w * fl[idx] * norm;
      }
    });
    // Remove the slow trend so only the attacks are left.
    const trend = movingMean(env, Math.max(2, Math.round(0.35 / base.dt)));
    for (let f = 0; f < frames; f++) env[f] = Math.max(0, env[f] - 0.9 * trend[f]);
    return env;
  }

  function pickPeaks(e, tOf) {
    const floor = 0.06 * percentile(e, 0.99);
    const peaks = [];
    for (let f = 2; f < e.length - 2; f++) {
      const v = e[f];
      if (v > floor && v > e[f - 1] && v >= e[f + 1] && v > e[f - 2] && v >= e[f + 2]) {
        const a = e[f - 1], c = e[f + 1], den = a - 2 * v + c;
        const d = den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
        peaks.push({ t: tOf(f + d), s: v, f });
      }
    }
    return peaks;
  }

  // ------------------------------------------------------------------
  // Tempo: try many tempos and beat positions, keep the pair whose beats
  // land on the strongest attacks.
  // ------------------------------------------------------------------
  function smooth3(e) {
    const o = new Float32Array(e.length);
    for (let i = 1; i < e.length - 1; i++) o[i] = 0.25 * e[i - 1] + 0.5 * e[i] + 0.25 * e[i + 1];
    return o;
  }

  function gridScore(es, P, p0) {
    const n = es.length;
    let s = 0, c = 0, sh = 0, ch = 0;
    for (let pos = p0; pos < n - 2; pos += P) {
      const i = pos | 0, fr = pos - i;
      s += es[i] * (1 - fr) + es[i + 1] * fr; c++;
      const q = pos + P / 2;
      if (q < n - 2) { const j = q | 0, g = q - j; sh += es[j] * (1 - g) + es[j + 1] * g; ch++; }
    }
    return c ? s / c + 0.35 * (ch ? sh / ch : 0) : 0;
  }

  function scanTempo(e, dt) {
    const es = smooth3(e);
    const bpms = [], scores = [], phases = [];
    for (let bpm = 75; bpm <= 190.001; bpm += 0.5) {
      const P = 60 / bpm / dt, nph = Math.max(6, Math.round(P));
      let bs = -1, bp = 0;
      for (let ph = 0; ph < nph; ph++) {
        const sc = gridScore(es, P, (ph * P) / nph);
        if (sc > bs) { bs = sc; bp = (ph * P) / nph; }
      }
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.75, 2));
      bpms.push(bpm); scores.push(bs * prior); phases.push(bp);
    }
    const med = median(scores);
    const mad = median(scores.map((v) => Math.abs(v - med))) * 1.4826 + 1e-9;
    const hyps = [];
    for (let i = 0; i < scores.length; i++) {
      let isMax = true;
      for (let k = Math.max(0, i - 8); k <= Math.min(scores.length - 1, i + 8); k++) {
        if (scores[k] > scores[i]) { isMax = false; break; }
      }
      if (isMax) hyps.push({ bpm: bpms[i], phase: phases[i], score: scores[i], z: (scores[i] - med) / mad });
    }
    hyps.sort((a, b) => b.score - a.score);
    return hyps.slice(0, 4);
  }

  // Narrow search around a tempo guess, in 0.02 BPM steps.
  function refineTempo(e, dt, bpm0, fixedBpm) {
    const es = smooth3(e);
    let best = { score: -1, bpm: bpm0, p0: 0 };
    const from = fixedBpm ? bpm0 : bpm0 - 0.8, to = fixedBpm ? bpm0 : bpm0 + 0.8;
    for (let bpm = from; bpm <= to + 1e-9; bpm += 0.02) {
      const P = 60 / bpm / dt, nph = Math.max(8, Math.round(P * 4));
      for (let ph = 0; ph < nph; ph++) {
        const p0 = (ph * P) / nph;
        const sc = gridScore(es, P, p0);
        if (sc > best.score) best = { score: sc, bpm, p0 };
      }
    }
    return best;
  }

  // Least-squares fit of the beat line to the strongest attacks. Gives the
  // tempo and offset to a fraction of a millisecond.
  function fitBeatLine(peaks, bpm, a0) {
    let P = 60 / bpm, a = a0;
    const strong = peaks.filter((p) => p.s >= percentile(peaks.map((q) => q.s), 0.5));
    for (let pass = 0; pass < 3; pass++) {
      const tol = pass === 0 ? 0.045 : 0.03;
      let sw = 0, sk = 0, st = 0, skk = 0, skt = 0, n = 0;
      for (const p of strong) {
        const k = Math.round((p.t - a) / P);
        const res = p.t - (a + k * P);
        if (Math.abs(res) > tol) continue;
        const w = p.s;
        sw += w; sk += w * k; st += w * p.t; skk += w * k * k; skt += w * k * p.t; n++;
      }
      if (n < 12) break;
      const den = sw * skk - sk * sk;
      if (Math.abs(den) < 1e-9) break;
      const slope = (sw * skt - sk * st) / den;
      const icpt = (st - slope * sk) / sw;
      if (Math.abs(slope - 60 / bpm) / (60 / bpm) > 0.01) break;
      P = slope; a = icpt;
    }
    a -= Math.floor(a / P) * P;
    return { P, a };
  }

  // Dynamic-programming beat tracker: finds the chain of beats that best
  // matches the attacks while keeping the spacing near the tempo.
  function trackBeats(e, dt, bpm) {
    const n = e.length, P = 60 / bpm / dt;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += e[i];
    mean /= n;
    let sd = 0;
    for (let i = 0; i < n; i++) sd += (e[i] - mean) * (e[i] - mean);
    sd = Math.sqrt(sd / n) + 1e-9;
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = e[i] / sd;
    const lo = Math.max(1, Math.round(P * 0.5)), hi = Math.round(P * 2);
    const pen = new Float32Array(hi + 1);
    for (let l = lo; l <= hi; l++) pen[l] = 100 * Math.pow(Math.log(l / P), 2);
    const C = new Float32Array(n), back = new Int32Array(n).fill(-1);
    for (let t = 0; t < n; t++) {
      let best = -1e9, bi = -1;
      for (let tau = Math.max(0, t - hi); tau <= t - lo; tau++) {
        const v = C[tau] - pen[t - tau];
        if (v > best) { best = v; bi = tau; }
      }
      if (bi >= 0 && best > 0) { C[t] = w[t] + best; back[t] = bi; } else C[t] = w[t];
    }
    let end = n - 1;
    for (let t = Math.max(0, n - hi); t < n; t++) if (C[t] > C[end]) end = t;
    const frames = [];
    for (let t = end; t >= 0; t = back[t]) { frames.push(t); if (back[t] < 0) break; }
    frames.reverse();
    return frames.map((f) => {
      const a = e[f - 1] || 0, c = e[f + 1] || 0, den = a - 2 * e[f] + c;
      return f + (den < 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0);
    });
  }

  // ------------------------------------------------------------------
  // Melody pitch at a moment: strongest note by harmonic summation.
  // ------------------------------------------------------------------
  function makePitchEstimator(sr) {
    const N = 4096, fft = getFFT(N), win = getHann(N), half = N >> 1, binHz = sr / N;
    const re = new Float32Array(N), im = new Float32Array(N), mags = new Float32Array(half);
    const cands = [];
    for (let m = 38; m <= 86; m++) cands.push({ m, f: 440 * Math.pow(2, (m - 69) / 12) });
    const kHigh = Math.min(half - 2, Math.floor(2500 / binHz));
    const peakAt = (f) => {
      const k = Math.round(f / binHz);
      if (k < 2 || k + 1 >= half) return 0;
      return Math.max(mags[k - 1], mags[k], mags[k + 1]);
    };
    return function pitchAt(x, tc) {
      const start = Math.round(tc * sr) - (N >> 1);
      if (start < 0 || start + N > x.length) return null;
      for (let i = 0; i < N; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let total = 0;
      for (let k = 1; k < half; k++) {
        mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        if (k <= kHigh) total += mags[k];
      }
      if (total < 1e-4) return null;
      let best = -1, bestM = 0;
      const sal = new Float32Array(cands.length);
      for (let c = 0; c < cands.length; c++) {
        let s = 0;
        for (let h = 1; h <= 6; h++) s += peakAt(cands[c].f * h) * Math.pow(0.8, h - 1);
        sal[c] = s;
        if (s > best) { best = s; bestM = c; }
      }
      // Prefer the octave below only when its own fundamental is strong.
      if (bestM >= 12 && sal[bestM - 12] >= 0.9 * best && peakAt(cands[bestM - 12].f) >= 0.6 * peakAt(cands[bestM].f)) bestM -= 12;
      return { m: cands[bestM].m, conf: best / total };
    };
  }

  // ------------------------------------------------------------------
  // Sustain: how long the sound that started at tNote keeps going.
  // Follows the bands that grew most at the attack.
  // ------------------------------------------------------------------
  function sustainSeconds(sp, tNote, maxSec) {
    const dt = sp.dt;
    const f0 = Math.round((tNote + 0.04 - sp.t0) / dt), fpre = Math.round((tNote - 0.05 - sp.t0) / dt);
    if (f0 < 2 || fpre < 1 || f0 + 4 >= sp.frames) return 0;
    const S = sp.S, o0 = f0 * BANDS, op = fpre * BANDS;
    const top = [-1, -1, -1], topV = [0, 0, 0];
    for (let b = 0; b < BANDS; b++) {
      const d = S[o0 + b] - S[op + b];
      for (let i = 0; i < 3; i++) {
        if (d > topV[i]) {
          for (let j = 2; j > i; j--) { topV[j] = topV[j - 1]; top[j] = top[j - 1]; }
          topV[i] = d; top[i] = b;
          break;
        }
      }
    }
    const used = top.filter((b) => b >= 0);
    if (!used.length) return 0;
    const energy = (f) => { let s = 0; for (const b of used) s += S[f * BANDS + b]; return s; };
    const e0 = energy(f0);
    if (e0 < 0.15) return 0;
    const maxF = Math.min(sp.frames - 1, f0 + Math.round(maxSec / dt));
    let prev = e0, low = 0, stop = f0;
    for (let f = f0 + 1; f <= maxF; f++) {
      const e = energy(f);
      if (e - prev > 0.3 * e0) break;           // a new attack in the same bands
      if (e < 0.55 * e0) { if (++low >= 3) break; } else { low = 0; stop = f; }
      prev = e;
    }
    return Math.max(0, (stop - f0) * dt);
  }

  // ------------------------------------------------------------------
  // The model: the beat grid with everything we know about each slot.
  // ------------------------------------------------------------------
  function buildGrid(beats, duration) {
    const bt = beats.slice();
    const first = bt.length > 1 ? bt[1] - bt[0] : 0.5;
    while (bt[0] - first >= 0) bt.unshift(bt[0] - first);
    const last = bt.length > 1 ? bt[bt.length - 1] - bt[bt.length - 2] : 0.5;
    while (bt[bt.length - 1] + last < duration + 0.5) bt.push(bt[bt.length - 1] + last);
    const G = (bt.length - 1) * 4;
    const time = new Float64Array(G), beat = new Int32Array(G), slot = new Uint8Array(G), beatDur = new Float32Array(G);
    for (let j = 0; j < bt.length - 1; j++) {
      const iv = bt[j + 1] - bt[j];
      for (let s = 0; s < 4; s++) {
        const g = j * 4 + s;
        time[g] = bt[j] + (s * iv) / 4; beat[g] = j; slot[g] = s; beatDur[g] = iv;
      }
    }
    return { G, time, beat, slot, beatDur, beats: bt };
  }

  function constantBeats(a, P, duration) {
    const out = [];
    for (let t = a; t < duration + P; t += P) out.push(t);
    return out;
  }

  function nearestIndex(times, t) {
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] < t) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(times[lo - 1] - t) < Math.abs(times[lo] - t)) lo--;
    return lo;
  }

  function cosine(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na * nb) + 1e-9);
  }

  // ------------------------------------------------------------------
  // Selecting notes
  // ------------------------------------------------------------------
  function thresholdAt(model, g, d, P) {
    const tier = TIER_OF_SLOT[model.slot[g]];
    const D = model.loud[g];
    const f = clamp(1.25 - 0.35 * D, 0.7, 1.2);
    const bonus = model.pos[g] === 0 ? 0.85 : model.pos[g] === 8 ? 0.92 : 1;
    return TIER_THR[tier] * P.tierMul[tier] * d.thr * P.thr * f * bonus;
  }

  function selectNotes(model, d, P) {
    const G = model.G, chosen = new Uint8Array(G), thr = new Float32Array(G);
    const cand = [];
    for (let g = 0; g < G; g++) {
      const t = model.time[g];
      if (t < 0.8 || t > model.duration - 0.6 || model.silent[g] || model.strength[g] <= 0) continue;
      thr[g] = thresholdAt(model, g, d, P);
      if (model.strength[g] >= thr[g]) cand.push(g);
    }
    cand.sort((a, b) => model.strength[b] - model.strength[a] || a - b);
    for (const g of cand) {
      let ok = true;
      for (let k = g - 1; k >= 0 && model.time[g] - model.time[k] < d.gap; k--) if (chosen[k]) { ok = false; break; }
      if (ok) for (let k = g + 1; k < G && model.time[k] - model.time[g] < d.gap; k++) if (chosen[k]) { ok = false; break; }
      if (ok) chosen[g] = 1;
    }
    // Too many notes inside one second: drop the weakest of the window.
    let list = [];
    for (let g = 0; g < G; g++) if (chosen[g]) list.push(g);
    for (let i = d.cap; i < list.length; i++) {
      if (model.time[list[i]] - model.time[list[i - d.cap]] < 1) {
        let weakest = i;
        for (let k = i - d.cap; k <= i; k++) if (model.strength[list[k]] < model.strength[list[weakest]]) weakest = k;
        chosen[list[weakest]] = 0;
        list.splice(weakest, 1);
        i = Math.max(d.cap - 1, i - d.cap - 1);
      }
    }
    return { list, thr };
  }

  // Marks holds, drops weak notes under them and picks chords.
  function decorate(model, sel, d, P, noteType) {
    const items = [];
    const holdEnds = [];
    let chords = 0;
    const dropped = new Set();
    // Only the most clearly sustained sounds become holds.
    const vals = model.sustainVals;
    const cut = Math.max(d.holdMin, vals.length ? vals[Math.min(vals.length - 1, Math.floor((1 - d.holdTop) * vals.length))] : 99);
    for (const g of sel.list) {
      if (dropped.has(g)) continue;
      const t = model.time[g];
      const item = { g, t, type: "tap", dur: 0, chord: false, s: model.strength[g] };
      const slot = model.slot[g];
      if (noteType !== "tap" && (slot === 0 || slot === 2) && model.sustain[g] >= cut) {
        const half = model.beatDur[g] / 2;
        const halves = Math.min(d.holdMaxHalf, Math.floor(model.sustain[g] / half));
        const active = holdEnds.filter((e) => e > t).length;
        if (halves >= 2 && active < d.holdAtOnce) {
          item.type = "hold";
          item.dur = Math.max(0.3, halves * half - 0.05);
          holdEnds.push(t + item.dur);
          // Weak notes inside the hold would make it unplayable.
          for (const g2 of sel.list) {
            if (g2 <= g) continue;
            if (model.time[g2] > t + item.dur) break;
            if (d.holdAtOnce === 1 && model.strength[g2] < 3 * sel.thr[g2]) dropped.add(g2);
            else if (model.strength[g2] < 1.6 * sel.thr[g2]) dropped.add(g2);
          }
        }
      }
      if (item.type === "tap" && d.chord > 0 && slot === 0 && model.loud[g] >= 1.1 && item.s >= d.chord && chords < (items.length + 1) * d.chordMax) {
        item.chord = true;
        chords++;
      }
      items.push(item);
    }
    return items;
  }

  // ------------------------------------------------------------------
  // Lanes
  // ------------------------------------------------------------------
  function transitionCost(l, st, K, t) {
    let c = 0;
    const dt = t - st.lastT;
    if (l === st.last) c += dt < 0.5 ? 4 : 1.5;
    if (l === st.last2) c += dt < 0.6 ? 0.8 : 0.3;
    if (st.last >= 0) {
      const j = Math.abs(l - st.last);
      if (dt < 0.25 && j >= K - 1) c += 3;
      else if (dt < 0.2 && j >= K - 2) c += 1.2;
    }
    return c;
  }

  // Pitch position 0..1 -> where on the lanes it should land. Each lane owns
  // an equal slice, so the outer lanes get as many notes as the inner ones.
  function laneTarget(u, K) {
    return clamp((Number.isFinite(u) ? u : 0.5) * K - 0.5, 0, K - 1);
  }

  function assignLanes(items, model, K, level, rng, barSource) {
    const busy = new Float64Array(K).fill(-1);
    const st = { last: -1, last2: -1, lastT: -9 };
    const notes = [];
    const barLanes = new Map();
    let costSum = 0;
    for (const it of items) {
      const g = it.g, t = it.t;
      const u = level === 1 ? model.uC[g] : (Number.isFinite(model.uP[g]) ? model.uP[g] : model.uC[g]);
      const L0 = laneTarget(u, K);
      const bar = model.bar[g], pos = model.pos[g];
      let lane = -1, copied = false;
      let srcEntry = null;
      if (level >= 2 && barSource) {
        const src = barSource.get(bar);
        if (src !== undefined) srcEntry = barLanes.get(src * 16 + pos) || null;
      }
      if (srcEntry && busy[srcEntry[0]] <= t) { lane = srcEntry[0]; copied = true; }
      if (lane < 0) {
        let best = Infinity;
        const noise = level === 1 ? 0.6 : 0.35;
        for (let l = 0; l < K; l++) {
          if (busy[l] > t) continue;
          const c = Math.abs(l - L0) + transitionCost(l, st, K, t) + rng() * noise;
          if (c < best) { best = c; lane = l; }
        }
        if (lane < 0) continue;       // every lane is occupied: skip this note
        costSum += best;
      }
      const note = { time: t, lane, type: it.type, g, bar, pos, copied };
      if (it.type === "hold") note.duration = it.dur;
      notes.push(note);
      busy[lane] = it.type === "hold" ? t + it.dur + HOLD_GAP_S : t + TAP_GAP_S;
      let second = -1;
      if (it.chord) {
        if (srcEntry && srcEntry[1] >= 0 && busy[srcEntry[1]] <= t && srcEntry[1] !== lane) second = srcEntry[1];
        else if (!srcEntry || srcEntry[1] < 0) {
          let bestC = Infinity;
          const want = Math.round((K - 1) / 2);
          for (let l = 0; l < K; l++) {
            if (l === lane || busy[l] > t) continue;
            const c = Math.abs(Math.abs(l - lane) - want) + rng() * 0.3;
            if (c < bestC) { bestC = c; second = l; }
          }
        }
        if (second >= 0) {
          notes.push({ time: t, lane: second, type: "tap", g, bar, pos, copied, second: true });
          busy[second] = t + TAP_GAP_S;
        }
      }
      barLanes.set(bar * 16 + pos, [lane, second]);
      st.last2 = st.last; st.last = lane; st.lastT = t;
    }
    return { notes, cost: notes.length ? costSum / notes.length : 0 };
  }

  // Level 3: nudge single notes to other lanes when that lowers the cost of
  // the neighbourhood. Notes that are part of repeated patterns stay put.
  function refineLanes(notes, model, K, level, locked) {
    const prim = notes.filter((n) => !n.second);
    const seqCost = (i, lane) => {
      const t = prim[i].time;
      const u = Number.isFinite(model.uP[prim[i].g]) ? model.uP[prim[i].g] : model.uC[prim[i].g];
      let c = Math.abs(lane - laneTarget(u, K));
      const lane1 = (j) => (j === i ? lane : prim[j].lane);
      for (let j = i; j <= Math.min(prim.length - 1, i + 2); j++) {
        const p1 = j - 1 >= 0 ? lane1(j - 1) : -1, p2 = j - 2 >= 0 ? lane1(j - 2) : -1;
        const st = { last: p1, last2: p2, lastT: j - 1 >= 0 ? prim[j - 1].time : -9 };
        c += transitionCost(lane1(j), st, K, prim[j].time);
      }
      return c;
    };
    for (let pass = 0; pass < 3; pass++) {
      let moved = 0;
      for (let i = 0; i < prim.length; i++) {
        const n = prim[i];
        if (n.copied || locked.has(n.bar)) continue;
        const cur = seqCost(i, n.lane);
        let bestL = n.lane, bestC = cur - 0.05;
        for (let l = 0; l < K; l++) {
          if (l === n.lane) continue;
          let clash = false;
          for (const o of notes) {
            if (o === n || o.lane !== l) continue;
            if (Math.abs(o.time - n.time) > 3.5) { if (o.time > n.time + 3.5) break; continue; }
            if (conflictsNote(n, o)) { clash = true; break; }
          }
          if (clash) continue;
          const c = seqCost(i, l);
          if (c < bestC) { bestC = c; bestL = l; }
        }
        if (bestL !== n.lane) { n.lane = bestL; moved++; }
      }
      if (!moved) break;
    }
  }

  function conflictsNote(a, b) {
    const [f, s] = a.time <= b.time ? [a, b] : [b, a];
    const end = f.time + (f.type === "hold" ? f.duration : 0);
    return s.time < end + (f.type === "hold" ? HOLD_GAP_S : TAP_GAP_S);
  }

  // ------------------------------------------------------------------
  // One candidate chart
  // ------------------------------------------------------------------
  function buildChart(model, K, opts, P, rng) {
    const d = DIFFS[opts.difficulty];
    const sel = selectNotes(model, d, P);
    const items = decorate(model, sel, d, P, opts.noteType);
    const asg = assignLanes(items, model, K, opts.level, rng, model.barSource);
    let notes = asg.notes;
    if (LEVELS[opts.level].search && notes.length) {
      const locked = new Set();
      if (model.barSource) for (const [, src] of model.barSource) locked.add(src);
      if (model.barSource) for (const [bar] of model.barSource) locked.add(bar);
      notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
      refineLanes(notes, model, K, opts.level, locked);
    }
    notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
    return { notes, laneCost: asg.cost };
  }

  function scoreChart(chart, model, d) {
    const notes = chart.notes;
    if (notes.length < 8) return -1;
    const peaks = model.peaks, strong = model.strongPeaks;
    const pt = model.peakTimes;
    let hit = 0;
    for (const n of notes) {
      const i = nearestIndex(pt, n.time);
      if (pt.length && Math.abs(pt[i] - n.time) <= 0.05) hit++;
    }
    const precision = hit / notes.length;
    const times = notes.map((n) => n.time);
    let rec = 0, tot = 0;
    for (const p of strong) {
      const w = Math.min(p.s, 3);
      tot += w;
      const i = nearestIndex(times, p.t);
      if (Math.abs(times[i] - p.t) <= 0.06) rec += w;
    }
    const recall = tot ? rec / tot : 0;
    const span = Math.max(5, times[times.length - 1] - times[0]);
    const dens = notes.length / span;
    const densPen = Math.min(1, Math.abs(dens - d.target) / d.target);
    let jacks = 0, prim = 0;
    const lastIn = new Array(8).fill(-9);
    for (const n of notes) {
      if (n.second) continue;
      prim++;
      if (n.time - lastIn[n.lane] < 0.3) jacks++;
      lastIn[n.lane] = n.time;
    }
    const erg = Math.min(1, chart.laneCost / 4) * 0.3 + (jacks / Math.max(1, prim)) * 1.5;
    return 1.0 * precision + 1.2 * recall - 0.8 * densPen - erg;
  }

  // ------------------------------------------------------------------
  // Analysis -> model
  // ------------------------------------------------------------------
  function hashSamples(x) {
    let h = 2166136261 ^ x.length;
    const step = Math.max(1, Math.floor(x.length / 4096));
    for (let i = 0; i < x.length; i += step) {
      h ^= Math.round(x[i] * 32767) & 0xffff;
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  async function prepare(mono, sampleRate, opts, hooks) {
    const ctrl = hooks.ctrl || { cancelled: false };
    const report = hooks.report || (() => {});
    const level = opts.level, cfg = LEVELS[level];
    const seg = (a, b) => (f) => report(a + (b - a) * clamp(f, 0, 1));
    // Where each stage ends on the 0..1 progress bar, from measured timings:
    // [spectra, chroma, tempo, melody and structure, (level 3) start of search].
    const bounds = level === 1 ? [0, 0.55, 0.6, 0.8, 0.9]
      : level === 2 ? [0, 0.72, 0.86, 0.9, 0.96]
        : [0, 0.8, 0.84, 0.87, 0.9];

    // --- audio at analysis rate
    const factor = Math.max(1, Math.round(sampleRate / TARGET_SR));
    let x = mono, sr = sampleRate;
    if (factor > 1) {
      const n = Math.floor(mono.length / factor);
      x = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = 0; k < factor; k++) s += mono[i * factor + k];
        x[i] = s / factor;
      }
      sr = sampleRate / factor;
    }
    const duration = x.length / sr;
    if (duration < MIN_CLIP_S) throw new SmartChartError("too_short");
    let peakAmp = 0;
    for (let i = 0; i < x.length; i += 97) peakAmp = Math.max(peakAmp, Math.abs(x[i]));
    if (peakAmp < 0.002) throw new SmartChartError("silent");
    await maybeYield(ctrl);

    // --- spectra
    // Bigger windows cost more, so they get a bigger share of the progress.
    const cost = cfg.res.map((r) => r.N * Math.log2(r.N));
    const costSum = cost.reduce((a, b) => a + b, 0);
    const specs = [];
    let done = 0;
    for (let i = 0; i < cfg.res.length; i++) {
      const a = bounds[0] + (bounds[1] - bounds[0]) * (done / costSum);
      done += cost[i];
      const b = bounds[0] + (bounds[1] - bounds[0]) * (done / costSum);
      specs.push(await bandSpectrogram(x, sr, cfg.res[i].N, cfg.H, ctrl, seg(a, b)));
    }
    const base = specs[0];
    const tOf = (f) => base.t0 + f * base.dt - cfg.lag;
    const env = buildEnvelope(specs, cfg);
    const peaks = pickPeaks(env, tOf);
    if (peaks.length < 16 || env.rawP95 < MIN_FLUX) throw new SmartChartError("no_onsets");
    let chroma = null;
    let bi = 1;
    if (cfg.structure) {
      chroma = await chromaFrames(x, sr, ctrl, seg(bounds[bi], bounds[bi + 1]));
      bi++;
    }
    report(bounds[bi]);

    // --- tempo and beat position
    const hyps = [];
    let confidence = 99;
    if (opts.bpm > 0) {
      const r = refineTempo(env, base.dt, opts.bpm, true);
      hyps.push({ bpm: opts.bpm, phase: r.p0 * base.dt, z: 99 });
    } else {
      const found = scanTempo(env, base.dt);
      if (!found.length) throw new SmartChartError("no_onsets");
      confidence = found[0].z;
      for (const h of found) {
        if (hyps.length && h.score < 0.85 * found[0].score) continue;
        const r = refineTempo(env, base.dt, h.bpm, false);
        hyps.push({ bpm: r.bpm, phase: r.p0 * base.dt, z: h.z, score: h.score });
        if (!cfg.search || hyps.length >= 3) break;
      }
    }
    // Fit the beat line to the actual attacks for exactness.
    for (const h of hyps) {
      const a0 = tOf(h.phase / base.dt) + 0; // phase is seconds from the first frame centre
      const fit = fitBeatLine(peaks, h.bpm, a0 - Math.floor(a0 / (60 / h.bpm)) * (60 / h.bpm));
      h.P = fit.P; h.a = fit.a; h.bpm = 60 / fit.P;
    }
    if (opts.offsetMs !== null && opts.offsetMs !== undefined && Number.isFinite(opts.offsetMs)) {
      for (const h of hyps) { h.a = ((opts.offsetMs / 1000) % h.P + h.P) % h.P; }
    }
    if (!(opts.bpm > 0) && (confidence < MIN_CONFIDENCE)) {
      throw new SmartChartError("low_confidence", { bpm: hyps[0].bpm, offsetMs: hyps[0].a * 1000 });
    }
    report(bounds[bi + 1]);
    bi++;

    // --- strengths, shared by every hypothesis
    const peakS = peaks.map((p) => p.s);
    const ref = percentile(peakS, 0.7) + 1e-9;
    const loudSm = movingMean(base.rms, Math.round(1 / base.dt));
    const med = (() => {
      const v = Array.from(loudSm).filter((q) => q > 0.003);
      return v.length ? median(v) : 1;
    })();
    const sustainSpec = specs.length > 1 ? specs[1] : specs[0];
    const strongPeaks = peaks.filter((p) => p.s >= ref * 0.8).map((p) => ({ t: p.t, s: p.s / ref }));
    const modelPeaks = peaks.filter((p) => p.s >= ref * 0.35).map((p) => ({ t: p.t, s: p.s / ref }));
    const peakTimes = Float64Array.from(modelPeaks.map((p) => p.t));
    const estimate = cfg.pitch ? makePitchEstimator(sr) : null;

    const models = [];
    for (let hi = 0; hi < hyps.length; hi++) {
      const h = hyps[hi];
      let beats = constantBeats(h.a, h.P, duration);
      let tempoChanges = false;
      if (cfg.beats) {
        const fr = trackBeats(env, base.dt, h.bpm);
        const bt = fr.map((f) => tOf(f));
        if (bt.length > 16) {
          // Real tempo drift shows up as the average beat length over 8 beats
          // leaving the global tempo; frame-sized jitter does not.
          let bad = 0, wins = 0;
          for (let i = 0; i + 8 < bt.length; i += 4) {
            wins++;
            if (Math.abs((bt[i + 8] - bt[i]) / 8 - h.P) / h.P > 0.02) bad++;
          }
          const coverage = (bt[bt.length - 1] - bt[0]) / duration;
          if (wins && bad / wins > 0.25 && coverage > 0.6) { beats = bt; tempoChanges = true; }
        }
      }
      const grid = buildGrid(beats, duration);
      const G = grid.G;
      // downbeat: the beat of a four-beat bar with the strongest attacks
      const beatStr = new Float32Array(grid.beats.length);
      for (const p of modelPeaks) {
        const j = nearestIndex(grid.beats, p.t);
        if (Math.abs(grid.beats[j] - p.t) < 0.04) beatStr[j] = Math.max(beatStr[j], p.s);
      }
      let r = 0, rBest = -1;
      for (let k = 0; k < 4; k++) {
        let s = 0;
        for (let j = k; j < beatStr.length; j += 4) s += beatStr[j];
        if (s > rBest) { rBest = s; r = k; }
      }
      const pos = new Uint8Array(G), bar = new Int32Array(G);
      for (let g = 0; g < G; g++) {
        const rel = grid.beat[g] - r + 4;
        bar[g] = Math.floor(rel / 4);
        pos[g] = (rel % 4) * 4 + grid.slot[g];
      }
      // peaks -> slots
      const strength = new Float32Array(G), peakIdx = new Int32Array(G).fill(-1);
      for (let pi = 0; pi < modelPeaks.length; pi++) {
        const p = modelPeaks[pi];
        const g = nearestIndex(grid.time, p.t);
        const tol = clamp((0.5 * grid.beatDur[g]) / 4, 0.03, 0.065);
        const dist = Math.abs(grid.time[g] - p.t);
        if (dist > tol) continue;
        const v = p.s * (1 - 0.4 * (dist / tol) * (dist / tol));
        if (v > strength[g]) { strength[g] = v; peakIdx[g] = pi; }
      }
      const loud = new Float32Array(G), silent = new Uint8Array(G);
      for (let g = 0; g < G; g++) {
        const f = clamp(Math.round((grid.time[g] - base.t0) / base.dt), 0, base.frames - 1);
        loud[g] = loudSm[f] / med;
        silent[g] = loudSm[f] < 0.0015 ? 1 : 0;
      }
      // spectral centre of each attack (low sound -> 0, high sound -> 1)
      const centroid = new Float32Array(G).fill(NaN);
      for (let g = 0; g < G; g++) {
        if (peakIdx[g] < 0) continue;
        const f = clamp(Math.round((modelPeaks[peakIdx[g]].t - base.t0 + cfg.lag) / base.dt), 2, base.frames - 3);
        let sw = 0, sb = 0;
        for (let b = 0; b < BANDS; b++) {
          const w = Math.max(0, base.S[(f + 1) * BANDS + b] - base.S[(f - 1) * BANDS + b]);
          sw += w; sb += w * b;
        }
        if (sw > 1e-4) centroid[g] = sb / sw;
      }
      const cs = [];
      for (let g = 0; g < G; g++) if (Number.isFinite(centroid[g])) cs.push(centroid[g]);
      cs.sort((a, b) => a - b);
      const uC = new Float32Array(G).fill(NaN);
      for (let g = 0; g < G; g++) {
        if (!Number.isFinite(centroid[g])) continue;
        let lo = 0, hiI = cs.length;
        while (lo < hiI) { const m = (lo + hiI) >> 1; if (cs[m] < centroid[g]) lo = m + 1; else hiI = m; }
        uC[g] = cs.length > 1 ? lo / (cs.length - 1) : 0.5;
      }
      // sustain for the slots that could hold
      const sustain = new Float32Array(G);
      for (let g = 0; g < G; g++) {
        if (strength[g] < 0.3 || (grid.slot[g] !== 0 && grid.slot[g] !== 2)) continue;
        sustain[g] = sustainSeconds(sustainSpec, grid.time[g], 4.5);
      }
      const sustainVals = Float32Array.from(Array.from(sustain).filter((v, g) => v > 0 && strength[g] >= 0.6));
      sustainVals.sort();
      const model = {
        G, time: grid.time, beat: grid.beat, slot: grid.slot, beatDur: grid.beatDur, pos, bar,
        strength, loud, silent, uC, uP: new Float32Array(G).fill(NaN), sustain, sustainVals,
        duration, peaks: modelPeaks, strongPeaks, peakTimes, barSource: null,
        bpm: h.bpm, offsetMs: (((h.a % h.P) + h.P) % h.P) * 1000, tempoChanges,
      };
      models.push(model);
      await maybeYield(ctrl);
    }

    // --- melody and structure (levels 2 and 3), for each hypothesis
    if (cfg.pitch || cfg.structure) {
      const fr = seg(bounds[bi], bounds[bi + 1] ?? 1);
      for (let mi = 0; mi < models.length; mi++) {
        const model = models[mi];
        if (cfg.pitch) {
          const idx = [], ms = [];
          for (let g = 0; g < model.G; g++) {
            if (model.strength[g] < 0.3) continue;
            const r = estimate(x, model.time[g] + 0.06);
            if (r && r.conf > 0.02) { idx.push(g); ms.push(r.m); }
            if ((g & 63) === 0) { fr((mi + g / model.G) / models.length); await maybeYield(ctrl); }
          }
          for (let i = 0; i < idx.length; i++) {
            const lo = Math.max(0, i - 10), hiI = Math.min(idx.length - 1, i + 10);
            let below = 0, same = 0, n = 0;
            for (let j = lo; j <= hiI; j++) {
              if (j === i) continue;
              n++;
              if (ms[j] < ms[i]) below++; else if (ms[j] === ms[i]) same++;
            }
            if (n >= 4) model.uP[idx[i]] = (below + 0.5 * same) / n;
          }
        }
        if (cfg.structure) model.barSource = findRepeats(model, chroma);
      }
    }
    return { models, confidence, peaks, env, cfg, duration, base, searchStart: bounds[4] };
  }

  // Bars that repeat an earlier bar (same harmony and same rhythm).
  function findRepeats(model, chroma) {
    const bars = new Map();
    for (let g = 0; g < model.G; g++) {
      const b = model.bar[g];
      if (!bars.has(b)) bars.set(b, { start: model.time[g], end: model.time[g], rhythm: new Float32Array(16), n: 0 });
      const e = bars.get(b);
      e.end = Math.max(e.end, model.time[g] + model.beatDur[g] / 4);
      e.start = Math.min(e.start, model.time[g]);
      if (model.strength[g] >= 0.5) { e.rhythm[model.pos[g]] = Math.min(model.strength[g], 3); e.n++; }
    }
    const ids = Array.from(bars.keys()).sort((a, b) => a - b);
    for (const id of ids) {
      const e = bars.get(id);
      const prof = new Float32Array(12);
      const f0 = Math.max(0, Math.round((e.start - chroma.t0) / chroma.dt)), f1 = Math.min(chroma.frames - 1, Math.round((e.end - chroma.t0) / chroma.dt));
      for (let f = f0; f <= f1; f++) for (let k = 0; k < 12; k++) prof[k] += chroma.C[f * 12 + k];
      e.chroma = prof;
    }
    const source = new Map();
    for (let i = 0; i < ids.length; i++) {
      const a = bars.get(ids[i]);
      if (a.n < 3) continue;
      let best = -1, bj = -1;
      for (let j = 0; j < i; j++) {
        const b = bars.get(ids[j]);
        if (b.n < 3) continue;
        const rhythmSim = cosine(a.rhythm, b.rhythm);
        const sim = 0.6 * cosine(a.chroma, b.chroma) + 0.4 * rhythmSim;
        if (rhythmSim >= TUNE.repeatRhythm && sim > best) { best = sim; bj = j; }
      }
      if (bj >= 0 && best >= TUNE.repeatSim) {
        const root = source.has(ids[bj]) ? source.get(ids[bj]) : ids[bj];
        source.set(ids[i], root);
      }
    }
    return source;
  }

  // ------------------------------------------------------------------
  // Public entry
  // ------------------------------------------------------------------
  async function generate(mono, sampleRate, options = {}, hooks = {}) {
    const started = now();
    const level = clamp(Math.round(Number(options.level) || 1), 1, 3);
    const K = Number(options.laneCount);
    if (![4, 6, 8].includes(K)) throw new SmartChartError("bad_keys");
    const opts = {
      level, laneCount: K,
      difficulty: DIFFS[options.difficulty] ? options.difficulty : "normal",
      noteType: options.noteType === "tap" ? "tap" : "mixed",
      bpm: Number(options.bpm) > 0 ? Number(options.bpm) : 0,
      offsetMs: options.offsetMs === null || options.offsetMs === undefined || options.offsetMs === "" ? null : Number(options.offsetMs),
    };
    let lastPct = -1;
    const onProgress = hooks.onProgress || (() => {});
    const report = (f) => {
      const pct = Math.max(lastPct, Math.min(100, f * 100));
      if (pct - lastPct >= 0.5 || pct >= 100) { lastPct = pct; onProgress(pct); }
    };
    const ctrl = hooks.ctrl || { cancelled: false };
    const prep = await prepare(mono, sampleRate, opts, { ctrl, report });
    const cfg = prep.cfg, d = DIFFS[opts.difficulty];
    const seedBase = hashSamples(mono) ^ (K * 7919);

    let best = null, searched = 0;
    const tune = options.tune || {};
    const baseP = { thr: tune.thr || 1, tierMul: tune.tierMul || [1, 1, 1] };
    if (!cfg.search) {
      const model = prep.models[0];
      const rng = mulberry32(seedBase);
      const chart = buildChart(model, K, opts, baseP, rng);
      best = { model, chart, P: baseP };
      report(0.97);
    } else {
      // Level 3: many candidate charts, keep the best scoring one.
      const s0 = prep.searchStart;
      const budgetEnd = now() + SEARCH_LIMIT_MS;
      const maxTries = 260;
      let bestScore = -Infinity, stale = 0;
      const tryOne = (model, P, seed) => {
        const chart = buildChart(model, K, opts, P, mulberry32(seed));
        const sc = scoreChart(chart, model, d);
        searched++;
        if (sc > bestScore) { bestScore = sc; best = { model, chart, P, score: sc }; stale = 0; return true; }
        stale++;
        return false;
      };
      const fracOf = () => Math.max(searched / maxTries, 1 - (budgetEnd - now()) / SEARCH_LIMIT_MS);
      let mi = 0;
      for (const model of prep.models) {
        for (const thr of [0.8, 0.9, 1, 1.1, 1.25]) {
          for (let s = 0; s < 2; s++) {
            tryOne(model, { thr, tierMul: [1, 1, 1] }, seedBase + s * 101 + mi);
            report(s0 + (1 - s0) * Math.min(0.5, fracOf()));
            await maybeYield(ctrl);
          }
        }
        mi++;
      }
      // Hill climbing around the best candidate.
      const rng = mulberry32(seedBase ^ 0x9e3779b9);
      while (searched < maxTries && now() < budgetEnd && stale < 45) {
        const P = { thr: best.P.thr, tierMul: best.P.tierMul.slice() };
        const which = Math.floor(rng() * 4);
        const mul = 1 + (rng() < 0.5 ? -1 : 1) * (0.06 + rng() * 0.12);
        if (which === 3) P.thr = clamp(P.thr * mul, 0.6, 1.6); else P.tierMul[which] = clamp(P.tierMul[which] * mul, 0.6, 1.8);
        tryOne(best.model, P, seedBase + searched * 31);
        report(s0 + (1 - s0) * Math.min(1, fracOf()));
        if ((searched & 3) === 0) await maybeYield(ctrl);
      }
    }

    const model = best.model;
    const notes = best.chart.notes.map((n) => {
      const out = { time: Math.round(n.time * 1000) / 1000, lane: n.lane, type: n.type };
      if (n.type === "hold") out.duration = Math.round(n.duration * 1000) / 1000;
      return out;
    });
    if (!notes.length) throw new SmartChartError("no_onsets");
    report(1);
    return {
      songTitle: "Auto-generated",
      bpm: Math.round(model.bpm * 100) / 100,
      offset: Math.round(model.offsetMs),
      laneCount: K,
      notes,
      info: {
        level, difficulty: opts.difficulty, confidence: prep.confidence, tempoChanges: model.tempoChanges,
        holds: notes.filter((n) => n.type === "hold").length, candidates: searched,
        elapsedMs: Math.round(now() - started),
        repeatedBars: model.barSource ? model.barSource.size : 0,
      },
    };
  }

  // Underscore names are for tests and tuning only.
  const api = { generate, SmartChartError, Cancelled, LEVELS, DIFFS, _prepare: prepare, _buildChart: buildChart, _rng: mulberry32, _tune: TUNE };
  return api;
})();

if (typeof window !== "undefined") window.SmartChart = SmartChart;
