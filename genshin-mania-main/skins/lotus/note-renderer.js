/* Lotus: eight-petal flower in three layers. Tap is blue, hold is pink. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { edge: "#2358d6", outer: "#3d8bff", mid: "#9cc2ff", inner: "#dce6ff", core: "#f4f3ff", glow: "#3d8bff" },
    hold: { edge: "#e0709f", outer: "#f6a2c4", mid: "#fbc9db", inner: "#fde9ee", core: "#fff8f6", glow: "#f6a2c4" },
  };

  // A pointed petal pointing up from the origin.
  function petal(ctx, len, wid) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(wid, -len * 0.18, wid * 1.05, -len * 0.7, 0, -len);
    ctx.bezierCurveTo(-wid * 1.05, -len * 0.7, -wid, -len * 0.18, 0, 0);
    ctx.closePath();
  }

  function ring(ctx, count, offset, len, wid, fill, stroke, lw) {
    for (let i = 0; i < count; i++) {
      ctx.save();
      ctx.rotate(offset + (i * Math.PI * 2) / count);
      petal(ctx, len, wid);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke(); }
      ctx.restore();
    }
  }

  registry.lotus = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.28) : base[k];

      ctx.save();
      ctx.lineJoin = "round";
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }

      // Back layer: eight wide petals with the dark outline.
      const g1 = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r);
      g1.addColorStop(0, P.mid); g1.addColorStop(0.55, P.outer); g1.addColorStop(1, P.edge);
      ring(ctx, 8, 0, r * 0.98, r * 0.31, g1, P.edge, r * 0.07);
      ctx.shadowBlur = 0;

      // Second layer, turned half a petal so it sits in the gaps.
      const g2 = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.75);
      g2.addColorStop(0, "#ffffff"); g2.addColorStop(1, P.inner);
      ring(ctx, 8, Math.PI / 8, r * 0.76, r * 0.25, g2, lift(P.outer, 0.25), r * 0.045);

      // Short front petals and the white core.
      ring(ctx, 8, 0, r * 0.5, r * 0.17, P.core, lift(P.mid, 0.35), r * 0.03);
      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.28);
      core.addColorStop(0, "#ffffff"); core.addColorStop(1, P.core);
      ctx.fillStyle = core;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 - Math.PI / 2;
        const rr = r * 0.26;
        ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        const b = a + Math.PI / 8;
        ctx.lineTo(Math.cos(b) * rr * 0.55, Math.sin(b) * rr * 0.55);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    },
  };
})();
