/* Sunburst: a fiery disc with a sun emblem. Tap is orange and yellow,
   hold is red and orange. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { rim: "#f08a1c", rimHi: "#ffc23a", disc: "#ffae32", discLow: "#fd8e22", ray: "#fff78a", core: "#fffbb0", ring: "#ffd36a", glow: "#ffa62e" },
    hold: { rim: "#b3262a", rimHi: "#ef5a3c", disc: "#e9473b", discLow: "#d1352f", ray: "#ff9d2c", core: "#ffcb52", ring: "#ff8a4a", glow: "#e8453a" },
  };

  // Star with `n` points, alternating outer and inner radius.
  function star(ctx, n, ro, ri, rot) {
    ctx.beginPath();
    for (let i = 0; i < n * 2; i++) {
      const a = rot + (i * Math.PI) / n;
      const rr = i % 2 === 0 ? ro : ri;
      const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  registry.pyro = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      ctx.save();
      ctx.lineJoin = "round";

      ctx.beginPath();
      ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      const rimG = ctx.createLinearGradient(0, -r, 0, r);
      rimG.addColorStop(0, P.rimHi); rimG.addColorStop(1, P.rim);
      ctx.fillStyle = rimG;
      ctx.fill();
      ctx.shadowBlur = 0;

      const discG = ctx.createRadialGradient(0, -r * 0.2, r * 0.1, 0, 0, r * 0.9);
      discG.addColorStop(0, mix(P.disc, "#ffffff", 0.25)); discG.addColorStop(0.6, P.disc); discG.addColorStop(1, P.discLow);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
      ctx.fillStyle = discG;
      ctx.fill();

      // Thin inner ring.
      ctx.strokeStyle = P.ring;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = r * 0.04;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Sun emblem: eight long rays over eight short ones.
      ctx.fillStyle = mix(P.ray, P.disc, 0.15);
      star(ctx, 8, r * 0.62, r * 0.3, Math.PI / 8);
      ctx.fill();
      ctx.fillStyle = P.ray;
      star(ctx, 8, r * 0.56, r * 0.28, -Math.PI / 2);
      ctx.fill();

      // Core disc with a dark ring so it reads as a sun.
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.27, 0, Math.PI * 2);
      ctx.fillStyle = P.discLow;
      ctx.fill();
      const coreG = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.22);
      coreG.addColorStop(0, "#ffffff"); coreG.addColorStop(1, P.core);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = coreG;
      ctx.fill();
      ctx.restore();
    },
  };
})();
