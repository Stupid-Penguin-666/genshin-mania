/* Tide: a round badge with a curling wave and bubbles.
   Tap is cyan, hold is blue. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { rim: "#17b6d8", rimHi: "#4fe0f6", disc: "#7fe4f2", discLow: "#3fc8e8", wave: "#f2fffa", glow: "#4fd6ee" },
    hold: { rim: "#3d62d8", rimHi: "#6f93f6", disc: "#7ba2fd", discLow: "#5a7df0", wave: "#e6efff", glow: "#4d74e9" },
  };

  registry.tide = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      ctx.beginPath();
      ctx.arc(0, 0, r * 0.98, 0, Math.PI * 2);
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      const rimG = ctx.createLinearGradient(0, -r, 0, r);
      rimG.addColorStop(0, P.rimHi); rimG.addColorStop(1, P.rim);
      ctx.fillStyle = rimG;
      ctx.fill();
      ctx.shadowBlur = 0;

      const discG = ctx.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.05, 0, 0, r * 0.9);
      discG.addColorStop(0, lift(P.disc, 0.35)); discG.addColorStop(0.6, P.disc); discG.addColorStop(1, P.discLow);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
      ctx.fillStyle = P.wave;
      ctx.globalAlpha = 0.9;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.78, 0, Math.PI * 2);
      ctx.fillStyle = discG;
      ctx.fill();

      // Wave: a big curl that sweeps in from the upper left.
      ctx.strokeStyle = P.wave;
      ctx.fillStyle = P.wave;
      ctx.lineWidth = r * 0.2;
      ctx.beginPath();
      ctx.moveTo(-r * 0.5, -r * 0.2);
      ctx.bezierCurveTo(-r * 0.2, -r * 0.62, r * 0.38, -r * 0.62, r * 0.5, -r * 0.1);
      ctx.bezierCurveTo(r * 0.58, r * 0.28, r * 0.2, r * 0.52, -r * 0.04, r * 0.34);
      ctx.bezierCurveTo(-r * 0.22, r * 0.2, -r * 0.1, -r * 0.08, r * 0.1, -r * 0.04);
      ctx.stroke();

      // Underlying swell.
      ctx.lineWidth = r * 0.11;
      ctx.beginPath();
      ctx.moveTo(-r * 0.36, r * 0.18);
      ctx.bezierCurveTo(-r * 0.3, r * 0.5, 0, r * 0.64, r * 0.3, r * 0.56);
      ctx.stroke();

      // Bubbles.
      for (const [x, y, rr] of [[-r * 0.52, r * 0.16, r * 0.07], [-r * 0.46, r * 0.42, r * 0.05], [-r * 0.58, r * 0.34, r * 0.04]]) {
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
})();
