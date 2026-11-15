/* Tomoe: a round badge with three white comma shapes chasing each other.
   Tap is lavender, hold is pink. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { rim: "#8a90ee", rimHi: "#b3b4f6", disc: "#cfaaf8", discLow: "#a79bf2", comma: "#f4f2ff", shade: "#bba9f4", glow: "#b48ff2" },
    hold: { rim: "#e47fd8", rimHi: "#f7aef4", disc: "#f3b0f6", discLow: "#e98ee3", comma: "#fff4fa", shade: "#efa4e8", glow: "#f08fe6" },
  };

  // One comma: a round head plus a tail that sweeps round the centre.
  function comma(ctx, r) {
    const steps = 22, sweep = 1.6;
    const head = { a: -Math.PI / 2, rho: r * 0.54, w: r * 0.22 };
    const left = [], right = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const a = head.a + t * sweep;
      const rho = head.rho * (1 - 0.45 * t);
      const w = head.w * Math.pow(1 - t, 0.85) + r * 0.01;
      const cx = Math.cos(a) * rho, cy = Math.sin(a) * rho;
      const nx = Math.cos(a), ny = Math.sin(a);
      left.push([cx + nx * w, cy + ny * w]);
      right.push([cx - nx * w, cy - ny * w]);
    }
    ctx.beginPath();
    left.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i][0], right[i][1]);
    ctx.closePath();
    const hx = Math.cos(head.a) * head.rho, hy = Math.sin(head.a) * head.rho;
    ctx.moveTo(hx + head.w, hy);
    ctx.arc(hx, hy, head.w, 0, Math.PI * 2);
  }

  registry.tomoe = {
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

      const discG = ctx.createRadialGradient(-r * 0.15, -r * 0.25, r * 0.05, 0, 0, r * 0.9);
      discG.addColorStop(0, lift(P.disc, 0.4)); discG.addColorStop(0.6, P.disc); discG.addColorStop(1, P.discLow);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2);
      ctx.fillStyle = discG;
      ctx.fill();

      // Three commas, each with a soft shadow copy slightly off to one side.
      for (let i = 0; i < 3; i++) {
        ctx.save();
        ctx.rotate((i * Math.PI * 2) / 3);
        ctx.save();
        ctx.translate(r * 0.03, r * 0.04);
        comma(ctx, r);
        ctx.fillStyle = P.shade;
        ctx.fill();
        ctx.restore();
        comma(ctx, r);
        ctx.fillStyle = P.comma;
        ctx.fill();
        ctx.restore();
      }
      ctx.restore();
    },
  };
})();
