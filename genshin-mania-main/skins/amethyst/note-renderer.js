/* Amethyst: nested diamond, like a carved gem. Hold notes come in pink. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  function shade(hex, amount) {
    const n = parseInt(hex.replace("#", ""), 16);
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  registry.amethyst = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      const s = r * 1.02;
      const diamond = (k) => {
        ctx.beginPath();
        ctx.moveTo(0, -s * k);
        ctx.lineTo(s * k, 0);
        ctx.lineTo(0, s * k);
        ctx.lineTo(-s * k, 0);
        ctx.closePath();
      };

      ctx.save();
      ctx.lineJoin = "round";

      diamond(0.97);
      if (useGlow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.lineWidth = r * 0.17;
      ctx.strokeStyle = shade(color, -0.45);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const outer = ctx.createLinearGradient(0, -s, 0, s);
      outer.addColorStop(0, shade(color, 0.6));
      outer.addColorStop(1, color);
      ctx.fillStyle = outer;
      diamond(0.97);
      ctx.fill();

      diamond(0.72);
      ctx.fillStyle = shade(color, 0.42);
      ctx.fill();
      ctx.lineWidth = r * 0.07;
      ctx.strokeStyle = shade(color, -0.28);
      ctx.stroke();

      diamond(0.48);
      const inner = ctx.createLinearGradient(0, -s * 0.5, 0, s * 0.5);
      inner.addColorStop(0, color);
      inner.addColorStop(1, shade(color, -0.15));
      ctx.fillStyle = inner;
      ctx.fill();
      ctx.lineWidth = r * 0.06;
      ctx.strokeStyle = shade(color, -0.3);
      ctx.stroke();

      diamond(0.2);
      ctx.fillStyle = centerColor;
      ctx.fill();
      ctx.restore();
    },
  };
})();
