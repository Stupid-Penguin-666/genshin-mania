/* Chibi: a round face with small bumps on top. Tap has round eyes (pink),
   hold has squeezed ">  <" eyes (blue). */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { rim: "#d9a8f6", rimLo: "#b88ee8", face: "#fff1fc", faceLow: "#f4dcfb", mark: "#a98ae6", glow: "#e5b8f8" },
    hold: { rim: "#8cb4f2", rimLo: "#6a9ae4", face: "#f7f5ff", faceLow: "#dfe6fb", mark: "#4fa6f0", glow: "#7fa8ee" },
  };

  // Face silhouette: a wide ellipse with a bump at each upper corner.
  function silhouette(ctx, r, s) {
    const k = r * s;
    ctx.beginPath();
    ctx.ellipse(0, k * 0.1, k * 0.98, k * 0.74, 0, 0, Math.PI * 2);
    ctx.moveTo(-k * 0.64 + k * 0.28, -k * 0.5);
    ctx.arc(-k * 0.64, -k * 0.5, k * 0.28, 0, Math.PI * 2);
    ctx.moveTo(k * 0.64 + k * 0.28, -k * 0.5);
    ctx.arc(k * 0.64, -k * 0.5, k * 0.28, 0, Math.PI * 2);
  }

  registry.chibi = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const hold = variant === "hold";
      const base = PAL[hold ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.translate(0, r * 0.06);

      silhouette(ctx, r, 1);
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      const rimG = ctx.createLinearGradient(0, -r, 0, r);
      rimG.addColorStop(0, P.rim); rimG.addColorStop(1, P.rimLo);
      ctx.fillStyle = rimG;
      ctx.fill();
      ctx.shadowBlur = 0;

      silhouette(ctx, r, 0.86);
      const faceG = ctx.createLinearGradient(0, -r * 0.8, 0, r * 0.8);
      faceG.addColorStop(0, P.face); faceG.addColorStop(1, P.faceLow);
      ctx.fillStyle = faceG;
      ctx.fill();

      // Eyes.
      ctx.strokeStyle = P.mark;
      ctx.fillStyle = P.mark;
      ctx.lineWidth = r * 0.085;
      for (const side of [-1, 1]) {
        const ex = side * r * 0.36, ey = -r * 0.08;
        if (hold) {
          // ">" on the left, "<" on the right.
          ctx.beginPath();
          ctx.moveTo(ex - side * r * 0.14, ey - r * 0.17);
          ctx.lineTo(ex + side * r * 0.14, ey);
          ctx.lineTo(ex - side * r * 0.14, ey + r * 0.17);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(ex, ey, r * 0.15, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.arc(ex, ey, r * 0.045, 0, Math.PI * 2);
          ctx.fill();
        }
        // Little downward triangle under each eye.
        ctx.beginPath();
        ctx.moveTo(ex - r * 0.1, r * 0.3);
        ctx.lineTo(ex + r * 0.1, r * 0.3);
        ctx.lineTo(ex, r * 0.44);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  };
})();
