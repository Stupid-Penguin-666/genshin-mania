/* Hutao: five-petal flower. Default skin.
   Tap notes use `color`; hold notes arrive with variant "hold" and their own
   colour, so the head/tail read differently from taps. Copy this file into a
   new skin folder and change only draw() to make a new shape. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  function shade(hex, amount) {
    const n = parseInt(hex.replace("#", ""), 16);
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  registry.Hutao = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      const petals = 5;
      const petalR = r * 0.43;
      const dist = r * 0.56;

      ctx.save();
      ctx.lineJoin = "round";

      // One path for all petals plus a filler disc, so the outline wraps the
      // silhouette (stroke first, fill on top hides the inner overlaps).
      ctx.beginPath();
      for (let i = 0; i < petals; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / petals;
        const cx = Math.cos(a) * dist, cy = Math.sin(a) * dist;
        ctx.moveTo(cx + petalR, cy);
        ctx.arc(cx, cy, petalR, 0, Math.PI * 2);
      }
      ctx.moveTo(r * 0.4, 0);
      ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);

      if (useGlow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.lineWidth = r * 0.2;
      ctx.strokeStyle = shade(color, -0.42);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const body = ctx.createRadialGradient(0, -r * 0.1, r * 0.05, 0, 0, r);
      body.addColorStop(0, shade(color, 0.6));
      body.addColorStop(0.55, color);
      body.addColorStop(1, shade(color, -0.1));
      ctx.fillStyle = body;
      ctx.fill();

      // Pentagram creases radiating between the petals.
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineWidth = Math.max(1, r * 0.06);
      ctx.beginPath();
      for (let i = 0; i < petals; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 4) / petals;
        const x = Math.cos(a) * r * 0.5, y = Math.sin(a) * r * 0.5;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();

      const core = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.26);
      core.addColorStop(0, "#ffffff");
      core.addColorStop(1, centerColor);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  };
})();
