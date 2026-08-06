/* Columbina — layered luminous cyan note inspired by the supplied reference.
   Keeps the engine's existing glow policy: it is enabled only when useGlow
   is true, so mobile performance remains identical to the other skins. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  registry.Columbina = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      ctx.save();

      // Soft outer halo and pale circular rim.
      if (useGlow) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
      }
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.94, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(240, 249, 255, 0.96)";
      ctx.fill();

      // Translucent cyan glass inside the rim.
      const core = ctx.createRadialGradient(-r * 0.28, -r * 0.32, r * 0.08, 0, 0, r * 0.75);
      core.addColorStop(0, "rgba(232, 250, 255, 0.94)");
      core.addColorStop(0.42, color);
      core.addColorStop(1, centerColor);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.72, 0, Math.PI * 2);
      ctx.fillStyle = core;
      ctx.fill();

      // Two fine arcs make the rim look layered without requiring an image.
      ctx.shadowBlur = 0;
      ctx.lineWidth = Math.max(1.2, r * 0.075);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.92)";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.81, -Math.PI * 0.78, Math.PI * 0.68);
      ctx.stroke();
      ctx.lineWidth = Math.max(1, r * 0.045);
      ctx.strokeStyle = "rgba(152, 226, 255, 0.9)";
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.64, Math.PI * 0.18, Math.PI * 1.26);
      ctx.stroke();

      // Small top-left reflection, matching the glass highlight in the reference.
      ctx.beginPath();
      ctx.ellipse(-r * 0.24, -r * 0.29, r * 0.19, r * 0.095, -Math.PI * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 255, 255, 0.48)";
      ctx.fill();

      ctx.restore();
    },
  };
})();
