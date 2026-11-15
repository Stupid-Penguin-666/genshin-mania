/* Columbina: a moon. Pale rim, a lit disc nudged up and left so a thin
   crescent of rim shows at the lower right. Hold notes are lavender. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
  const TAU = Math.PI * 2;

  function shade(hex, amount) {
    const n = parseInt(hex.replace("#", ""), 16);
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  registry.Columbina = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      ctx.save();

      const rim = ctx.createLinearGradient(-r, -r, r, r);
      rim.addColorStop(0, "#ffffff");
      rim.addColorStop(1, shade(color, 0.6));
      if (useGlow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.97, 0, TAU);
      ctx.fillStyle = rim;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = r * 0.09;
      ctx.strokeStyle = shade(color, -0.5);
      ctx.stroke();

      const ix = -r * 0.1, iy = -r * 0.1, ir = r * 0.76;
      const disc = ctx.createRadialGradient(ix - ir * 0.32, iy - ir * 0.32, ir * 0.05, ix, iy, ir);
      disc.addColorStop(0, shade(color, 0.5));
      disc.addColorStop(0.55, color);
      disc.addColorStop(1, shade(color, -0.22));
      ctx.beginPath();
      ctx.arc(ix, iy, ir, 0, TAU);
      ctx.fillStyle = disc;
      ctx.fill();

      // Faint craters
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      [[-0.32, -0.28, 0.14], [0.08, 0.14, 0.1], [-0.14, 0.3, 0.07], [0.28, -0.22, 0.06]].forEach(([x, y, k]) => {
        ctx.beginPath();
        ctx.arc(ix + x * r, iy + y * r, k * r, 0, TAU);
        ctx.fill();
      });

      // Light along the crescent
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = r * 0.06;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.86, Math.PI * 0.05, Math.PI * 0.62);
      ctx.stroke();

      ctx.fillStyle = centerColor;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.arc(ix - ir * 0.34, iy - ir * 0.36, ir * 0.12, 0, TAU);
      ctx.fill();
      ctx.restore();
    },
  };
})();
