/* Ocean circle note renderer. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
  registry.ocean = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      if (useGlow) ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2);
      ctx.fillStyle = centerColor;
      if (useGlow) ctx.shadowBlur = 4;
      ctx.fill();
    },
  };
})();
