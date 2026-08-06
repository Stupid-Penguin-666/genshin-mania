/* Default flower note. This is deliberately skin-owned: copy this file
   into a new skin folder and change only draw() to create a new shape. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});
  registry.default = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      const petals = 6;
      if (useGlow) ctx.shadowBlur = 10;
      for (let i = 0; i < petals; i++) {
        ctx.rotate((Math.PI * 2) / petals);
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.55, r * 0.4, r * 0.55, 0, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = centerColor;
      if (useGlow) ctx.shadowBlur = 4;
      ctx.fill();
    },
  };
})();
