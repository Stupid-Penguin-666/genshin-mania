/* Planet: a glowing orb with a feather swirl and a tilted ring.
   Tap is cyan, hold is blue-violet. The ring is the widest part (about 1.2 x
   radius), which fits inside the sprite padding. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { outline: "#1f3f9c", edge: "#2cbde3", mid: "#63e2ee", hi: "#b9fbfa", feather: "#f2ffff", ring: "#7fe3f2", ringLo: "#4fc3e8", glow: "#4ad8e4" },
    hold: { outline: "#241b78", edge: "#4a50e0", mid: "#6a8cff", hi: "#a9b6ff", feather: "#e4e4ff", ring: "#9fb8ff", ringLo: "#6c86ee", glow: "#6a8cff" },
  };

  // Half of the tilted ring. `back` is the half hidden behind the orb.
  function ringHalf(ctx, r, back, P) {
    ctx.save();
    ctx.rotate(-0.2);
    ctx.beginPath();
    const a0 = back ? Math.PI : 0, a1 = back ? Math.PI * 2 : Math.PI;
    ctx.ellipse(0, 0, r * 1.18, r * 0.32, 0, a0, a1);
    ctx.lineWidth = r * 0.07;
    ctx.strokeStyle = back ? P.ringLo : P.ring;
    ctx.stroke();
    ctx.restore();
  }

  registry.planet = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];
      const R = r * 0.88;

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }

      ringHalf(ctx, r, true, P);
      ctx.shadowBlur = 0;

      // Orb.
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fillStyle = P.outline;
      ctx.fill();
      const g = ctx.createRadialGradient(-R * 0.2, -R * 0.3, R * 0.05, 0, 0, R * 0.92);
      g.addColorStop(0, P.hi); g.addColorStop(0.5, P.mid); g.addColorStop(1, P.edge);
      ctx.beginPath();
      ctx.arc(0, 0, R * 0.9, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();

      // Feather swirl: two flowing strokes meeting at the bottom left.
      ctx.strokeStyle = P.feather;
      ctx.lineWidth = R * 0.3;
      ctx.beginPath();
      ctx.moveTo(R * 0.28, -R * 0.6);
      ctx.bezierCurveTo(R * 0.6, -R * 0.1, -R * 0.05, -R * 0.05, -R * 0.1, R * 0.26);
      ctx.bezierCurveTo(-R * 0.12, R * 0.5, -R * 0.3, R * 0.56, -R * 0.36, R * 0.62);
      ctx.stroke();
      ctx.lineWidth = R * 0.18;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(-R * 0.16, -R * 0.56);
      ctx.bezierCurveTo(-R * 0.5, -R * 0.24, -R * 0.2, R * 0.12, R * 0.22, R * 0.22);
      ctx.bezierCurveTo(R * 0.42, R * 0.26, R * 0.36, R * 0.5, R * 0.2, R * 0.6);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Front half of the ring crosses over the orb.
      ringHalf(ctx, r, false, P);
      ctx.restore();
    },
  };
})();
