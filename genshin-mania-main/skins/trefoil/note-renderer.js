/* Trefoil: three broad notched petals over three small pointed leaves, in a
   thick pale frame. Tap is yellow and green, hold is white and cyan. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { edge: "#46c4c2", rim: "#f6fff0", big: "#fff7a8", bigLow: "#f6dc78", small: "#9fe3a4", vein: "#f2a45a", glow: "#8ee8b0" },
    hold: { edge: "#4fb3e6", rim: "#f6ffff", big: "#c9f7ff", bigLow: "#7fe6f8", small: "#82cdf4", vein: "#4aa8e8", glow: "#6ad9f0" },
  };

  // Broad petal pointing up with a small notch at the tip.
  function bigPetal(ctx, L) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(-L * 0.62, -L * 0.14, -L * 0.52, -L * 0.88, -L * 0.1, -L * 0.98);
    ctx.lineTo(0, -L * 0.9);
    ctx.lineTo(L * 0.1, -L * 0.98);
    ctx.bezierCurveTo(L * 0.52, -L * 0.88, L * 0.62, -L * 0.14, 0, 0);
    ctx.closePath();
  }

  // Slim pointed leaf pointing up.
  function smallLeaf(ctx, L) {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(L * 0.3, -L * 0.2, L * 0.26, -L * 0.7, 0, -L);
    ctx.bezierCurveTo(-L * 0.26, -L * 0.7, -L * 0.3, -L * 0.2, 0, 0);
    ctx.closePath();
  }

  registry.trefoil = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      const bigAngles = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];       // up, lower right, lower left
      const smallAngles = bigAngles.map((a) => a + Math.PI / 3);          // between them
      const BL = r * 0.8, SL = r * 1.04;

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.translate(0, r * 0.04);
      ctx.scale(0.93, 0.93);

      const shapes = (scale, fn) => {
        for (const a of smallAngles) { ctx.save(); ctx.rotate(a); ctx.scale(scale, scale); smallLeaf(ctx, SL); fn(); ctx.restore(); }
        for (const a of bigAngles) { ctx.save(); ctx.rotate(a); ctx.scale(scale, scale); bigPetal(ctx, BL); fn(); ctx.restore(); }
      };

      // Frame: teal outline, then a pale rim.
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      ctx.lineWidth = r * 0.34;
      ctx.strokeStyle = P.edge; ctx.fillStyle = P.edge;
      shapes(1, () => { ctx.stroke(); ctx.fill(); });
      ctx.shadowBlur = 0;
      ctx.lineWidth = r * 0.16;
      ctx.strokeStyle = P.rim; ctx.fillStyle = P.rim;
      shapes(1, () => { ctx.stroke(); ctx.fill(); });

      // Small leaves, then the big petals on top.
      for (const a of smallAngles) {
        ctx.save(); ctx.rotate(a); ctx.scale(0.9, 0.9); smallLeaf(ctx, SL);
        const g = ctx.createLinearGradient(0, 0, 0, -SL);
        g.addColorStop(0, mix(P.small, "#ffffff", 0.2)); g.addColorStop(1, P.small);
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
      }
      for (const a of bigAngles) {
        ctx.save(); ctx.rotate(a); ctx.scale(0.88, 0.88); bigPetal(ctx, BL);
        const g = ctx.createLinearGradient(0, 0, 0, -BL);
        g.addColorStop(0, P.bigLow); g.addColorStop(0.6, P.big); g.addColorStop(1, mix(P.big, "#ffffff", 0.35));
        ctx.fillStyle = g; ctx.fill();
        ctx.restore();
      }

      // Three-armed vein at the centre.
      ctx.strokeStyle = P.vein;
      ctx.lineWidth = r * 0.06;
      for (const a of smallAngles) {
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.sin(a) * r * 0.3, -Math.cos(a) * r * 0.3);
        ctx.stroke();
      }
      ctx.restore();
    },
  };
})();
