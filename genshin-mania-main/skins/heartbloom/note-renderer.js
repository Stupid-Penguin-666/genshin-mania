/* Heart Bloom: stacked heart-shaped petals around a four-point star.
   Tap is violet, hold is magenta and peach. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { l1: "#8a52e0", l1b: "#c27df6", l2: "#d79bff", l3: "#f1c4ff", l4: "#fff0fb", star: "#ffffff", glow: "#c47cf5" },
    hold: { l1: "#c4157f", l1b: "#ee3d98", l2: "#ff7aa4", l3: "#ffb297", l4: "#ffe3c4", star: "#fff8ec", glow: "#f0429a" },
  };

  // Heart with pointed shoulders, scaled by s and nudged down by dy.
  function heart(ctx, r, s, dy) {
    const k = r * s;
    ctx.beginPath();
    ctx.moveTo(0, k * 0.98 + dy);
    ctx.bezierCurveTo(-k * 0.5, k * 0.72 + dy, -k * 1.02, k * 0.2 + dy, -k * 0.98, -k * 0.5 + dy);
    ctx.lineTo(-k * 0.82, -k * 0.82 + dy);                       // left shoulder point
    ctx.quadraticCurveTo(-k * 0.5, -k * 0.62 + dy, -k * 0.28, -k * 0.5 + dy);
    ctx.quadraticCurveTo(-k * 0.08, -k * 0.62 + dy, 0, -k * 0.34 + dy);   // centre dip
    ctx.quadraticCurveTo(k * 0.08, -k * 0.62 + dy, k * 0.28, -k * 0.5 + dy);
    ctx.quadraticCurveTo(k * 0.5, -k * 0.62 + dy, k * 0.82, -k * 0.82 + dy);
    ctx.lineTo(k * 0.98, -k * 0.5 + dy);
    ctx.bezierCurveTo(k * 1.02, k * 0.2 + dy, k * 0.5, k * 0.72 + dy, 0, k * 0.98 + dy);
    ctx.closePath();
  }

  registry.heartbloom = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      ctx.save();
      ctx.lineJoin = "round";

      // Two darker side petals behind the main heart give the stepped tips.
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      for (const side of [-1, 1]) {
        ctx.save();
        ctx.translate(side * r * 0.14, r * 0.06);
        ctx.rotate(side * 0.3);
        heart(ctx, r, 0.82, 0);
        ctx.fillStyle = mix(P.l1, "#000000", 0.2);
        ctx.fill();
        ctx.restore();
      }
      heart(ctx, r, 1, 0);
      const g1 = ctx.createLinearGradient(0, -r, 0, r);
      g1.addColorStop(0, P.l1); g1.addColorStop(1, P.l1b);
      ctx.fillStyle = g1;
      ctx.fill();
      ctx.shadowBlur = 0;

      const layers = [[0.9, 0.04, P.l2, P.l1b], [0.7, 0.07, P.l3, P.l2], [0.5, 0.1, P.l4, P.l3]];
      for (const [s, dy, top, bottom] of layers) {
        heart(ctx, r, s, r * dy);
        const g = ctx.createLinearGradient(0, -r * s, 0, r * s);
        g.addColorStop(0, top); g.addColorStop(1, bottom);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.lineWidth = r * 0.03;
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.stroke();
      }

      // Four-point star in the middle.
      ctx.fillStyle = P.star;
      ctx.beginPath();
      const cy = r * 0.1, R = r * 0.34, q = r * 0.07;
      ctx.moveTo(0, cy - R);
      ctx.quadraticCurveTo(q, cy - q, R, cy);
      ctx.quadraticCurveTo(q, cy + q, 0, cy + R);
      ctx.quadraticCurveTo(-q, cy + q, -R, cy);
      ctx.quadraticCurveTo(-q, cy - q, 0, cy - R);
      ctx.fill();
      ctx.restore();
    },
  };
})();
