/* Sakura: five notched petals with a starburst of stamens.
   Tap is pink, hold is pale blue. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { edge: "#d890cf", body: "#f6bfe2", light: "#fde4f2", vein: "#eaa6d6", stamen: "#f27eb8", glow: "#f3b4dc" },
    hold: { edge: "#6fb0d4", body: "#a9ddee", light: "#e2f5fb", vein: "#8ccbe3", stamen: "#5db4e6", glow: "#9fd8ee" },
  };

  // One notched petal pointing up, length L.
  function petal(ctx, L) {
    ctx.beginPath();
    ctx.moveTo(0, -L * 0.08);
    ctx.bezierCurveTo(-L * 0.46, -L * 0.2, -L * 0.52, -L * 0.88, -L * 0.17, -L * 0.96);
    ctx.quadraticCurveTo(0, -L * 0.8, L * 0.17, -L * 0.96);
    ctx.bezierCurveTo(L * 0.52, -L * 0.88, L * 0.46, -L * 0.2, 0, -L * 0.08);
    ctx.closePath();
  }

  registry.sakura = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];
      const L = r * 0.9;

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Outline pass over all petals, then a fill pass hides inner overlaps.
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      ctx.lineWidth = r * 0.1;
      ctx.strokeStyle = P.edge;
      for (let i = 0; i < 5; i++) {
        ctx.save(); ctx.rotate((i * Math.PI * 2) / 5); petal(ctx, L); ctx.stroke(); ctx.restore();
      }
      ctx.shadowBlur = 0;
      for (let i = 0; i < 5; i++) {
        ctx.save();
        ctx.rotate((i * Math.PI * 2) / 5);
        petal(ctx, L);
        const g = ctx.createRadialGradient(0, 0, 0, 0, -L * 0.2, L);
        g.addColorStop(0, P.light); g.addColorStop(0.55, P.body); g.addColorStop(1, mix(P.body, P.edge, 0.25));
        ctx.fillStyle = g;
        ctx.fill();
        ctx.restore();
      }

      // Petal creases.
      ctx.strokeStyle = P.vein;
      ctx.lineWidth = r * 0.035;
      for (let i = 0; i < 5; i++) {
        ctx.save(); ctx.rotate((i * Math.PI * 2) / 5);
        ctx.beginPath(); ctx.moveTo(0, -L * 0.3); ctx.lineTo(0, -L * 0.62); ctx.stroke();
        ctx.restore();
      }

      // Starburst of stamens.
      ctx.fillStyle = P.light;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = P.stamen;
      ctx.lineWidth = r * 0.035;
      for (let i = 0; i < 18; i++) {
        const a = (i * Math.PI * 2) / 18;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.06, Math.sin(a) * r * 0.06);
        ctx.lineTo(Math.cos(a) * r * 0.27, Math.sin(a) * r * 0.27);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.27, Math.sin(a) * r * 0.27, r * 0.022, 0, Math.PI * 2);
        ctx.fillStyle = P.stamen;
        ctx.fill();
      }
      ctx.restore();
    },
  };
})();
