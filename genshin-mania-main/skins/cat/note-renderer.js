/* Cat: a grinning cat head with pointed ears. Hold notes are magenta. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  function shade(hex, amount) {
    const n = parseInt(hex.replace("#", ""), 16);
    const target = amount < 0 ? 0 : 255;
    const p = Math.abs(amount);
    const mix = (v) => Math.round(v + (target - v) * p);
    return `rgb(${mix((n >> 16) & 255)},${mix((n >> 8) & 255)},${mix(n & 255)})`;
  }

  registry.cat = {
    draw(ctx, { radius: r, color, centerColor, useGlow }) {
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.translate(0, r * 0.06);

      const head = () => {
        ctx.beginPath();
        ctx.moveTo(-r * 0.94, -r * 0.02);
        ctx.lineTo(-r * 0.9, -r * 0.98);
        ctx.quadraticCurveTo(-r * 0.52, -r * 0.84, -r * 0.3, -r * 0.66);
        ctx.quadraticCurveTo(0, -r * 0.74, r * 0.3, -r * 0.66);
        ctx.quadraticCurveTo(r * 0.52, -r * 0.84, r * 0.9, -r * 0.98);
        ctx.lineTo(r * 0.94, -r * 0.02);
        ctx.quadraticCurveTo(r * 1.0, r * 0.84, 0, r * 0.86);
        ctx.quadraticCurveTo(-r * 1.0, r * 0.84, -r * 0.94, -r * 0.02);
        ctx.closePath();
      };

      head();
      if (useGlow) { ctx.shadowColor = color; ctx.shadowBlur = 10; }
      ctx.lineWidth = r * 0.2;
      ctx.strokeStyle = shade(color, -0.5);
      ctx.stroke();
      ctx.shadowBlur = 0;

      const face = ctx.createLinearGradient(0, -r, 0, r);
      face.addColorStop(0, shade(color, 0.55));
      face.addColorStop(1, color);
      head();
      ctx.fillStyle = face;
      ctx.fill();

      // Inner ears
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      [-1, 1].forEach((side) => {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.76, -r * 0.82);
        ctx.lineTo(side * r * 0.5, -r * 0.6);
        ctx.lineTo(side * r * 0.8, -r * 0.4);
        ctx.closePath();
        ctx.fill();
      });

      // Grin
      ctx.beginPath();
      ctx.moveTo(-r * 0.56, r * 0.08);
      ctx.lineTo(r * 0.56, r * 0.08);
      ctx.quadraticCurveTo(r * 0.46, r * 0.68, 0, r * 0.68);
      ctx.quadraticCurveTo(-r * 0.46, r * 0.68, -r * 0.56, r * 0.08);
      ctx.closePath();
      ctx.fillStyle = shade(color, -0.62);
      ctx.fill();
      ctx.lineWidth = r * 0.07;
      ctx.strokeStyle = shade(color, -0.5);
      ctx.stroke();

      // Teeth
      ctx.fillStyle = centerColor;
      const toothW = r * 0.22;
      for (let k = 0; k < 4; k++) {
        const x = -r * 0.44 + k * (toothW * 1.12);
        ctx.beginPath();
        ctx.moveTo(x, r * 0.1);
        ctx.lineTo(x + toothW, r * 0.1);
        ctx.lineTo(x + toothW / 2, r * 0.3);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  };
})();
