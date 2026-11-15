/* Whirl: a round coin with a crescent swirl. Tap is a periwinkle ring with a
   white band, hold is a cream-gold disc. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { rim: "#7684e8", band: "#98a3f4", white: "#f7f5ff", disc: "#dcdefa", discLow: "#c4c9f5", swirl: "#b2b8f2", glow: "#a4aaf0" },
    hold: { rim: "#f8dc9e", band: "#fbe6b0", white: "#fffdeb", disc: "#fff6d4", discLow: "#fde4b4", swirl: "#f6d29a", glow: "#fbd89a" },
  };

  registry.whirl = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Outer rim.
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      ctx.fillStyle = P.rim;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Coloured band, then a bright ring inside it.
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.88, 0, Math.PI * 2);
      const bandG = ctx.createLinearGradient(0, -r, 0, r);
      bandG.addColorStop(0, P.band); bandG.addColorStop(1, P.rim);
      ctx.fillStyle = bandG;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = P.white;
      ctx.fill();

      // Inner disc.
      const discG = ctx.createRadialGradient(-r * 0.15, -r * 0.2, r * 0.05, 0, 0, r * 0.7);
      discG.addColorStop(0, P.white); discG.addColorStop(1, P.disc);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.68, 0, Math.PI * 2);
      ctx.fillStyle = discG;
      ctx.fill();
      ctx.lineWidth = r * 0.03;
      ctx.strokeStyle = P.band;
      ctx.stroke();

      // Crescent swirl: a disc with a bite taken out, plus a curl.
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.62, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = P.swirl;
      ctx.beginPath();
      ctx.arc(-r * 0.02, r * 0.04, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = P.disc;
      ctx.beginPath();
      ctx.arc(r * 0.12, -r * 0.02, r * 0.34, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = P.swirl;
      ctx.lineWidth = r * 0.07;
      ctx.beginPath();
      ctx.arc(r * 0.1, -r * 0.02, r * 0.5, -Math.PI * 0.95, Math.PI * 0.35);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(r * 0.16, r * 0.0, r * 0.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.restore();
    },
  };
})();
