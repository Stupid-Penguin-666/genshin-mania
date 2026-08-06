/* Amethyst diamond note renderer. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
  registry.amethyst = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      const s = r * 0.82;
      if (useGlow) ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.moveTo(0, -s); ctx.lineTo(s, 0); ctx.lineTo(0, s); ctx.lineTo(-s, 0);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      const s2 = r * 0.32;
      ctx.beginPath();
      ctx.moveTo(0, -s2); ctx.lineTo(s2, 0); ctx.lineTo(0, s2); ctx.lineTo(-s2, 0);
      ctx.closePath();
      ctx.fillStyle = centerColor;
      if (useGlow) ctx.shadowBlur = 4;
      ctx.fill();
    },
  };
})();
