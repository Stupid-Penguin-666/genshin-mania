/* Ocean: pale blue flower with a swirl core. Hold notes come in green. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  function shade(hex, amount) {
    const n = parseInt(hex.replace("#", ""), 16);
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  registry.ocean = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      const petals = 5;
      const petalR = r * 0.44;
      const dist = r * 0.55;

      ctx.save();
      ctx.lineJoin = "round";
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
      ctx.strokeStyle = shade(color, -0.45);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const body = ctx.createRadialGradient(0, 0, r * 0.05, 0, 0, r);
      body.addColorStop(0, centerColor);
      body.addColorStop(0.5, shade(color, 0.35));
      body.addColorStop(1, color);
      ctx.fillStyle = body;
      ctx.fill();

      // Soft petal veins
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.lineCap = "round";
      for (let i = 0; i < petals; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / petals;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.3, Math.sin(a) * r * 0.3);
        ctx.lineTo(Math.cos(a) * r * 0.82, Math.sin(a) * r * 0.82);
        ctx.stroke();
      }

      // Swirl core
      ctx.strokeStyle = shade(color, -0.5);
      ctx.lineWidth = Math.max(1.2, r * 0.07);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.2, 0.4, Math.PI * 1.85);
      ctx.stroke();
      ctx.fillStyle = shade(color, -0.5);
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.06, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },
  };
})();
