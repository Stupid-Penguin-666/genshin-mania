/* Pudding: a flan on a plate. Tap is cream with a caramel dot on a mint
   plate, hold is a blue pudding with whipped cream on a lavender plate. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { outline: "#3bb89f", plate: "#a6f3df", plateLow: "#74dcc5", body: "#fff6cc", bodyLow: "#f8d79a", cream: "#fffbe6", dot: "#f0a850", dotHi: "#ffd38a", glow: "#7fe8cf" },
    hold: { outline: "#5a6fe0", plate: "#cfd5ff", plateLow: "#a0aef9", body: "#a8bcff", bodyLow: "#4fd6fb", cream: "#f6f8ff", dot: "#8aa4ff", dotHi: "#ffffff", glow: "#8ea8ff" },
  };

  registry.pudding = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const hold = variant === "hold";
      const base = PAL[hold ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.25) : base[k];

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.translate(0, r * 0.08);

      const bodyPath = () => {
        ctx.beginPath();
        ctx.moveTo(-r * 0.66, r * 0.5);
        ctx.bezierCurveTo(-r * 0.6, r * 0.1, -r * 0.52, -r * 0.2, -r * 0.44, -r * 0.38);
        ctx.quadraticCurveTo(0, -r * 0.62, r * 0.44, -r * 0.38);
        ctx.bezierCurveTo(r * 0.52, -r * 0.2, r * 0.6, r * 0.1, r * 0.66, r * 0.5);
        ctx.closePath();
      };
      const platePath = () => {
        ctx.beginPath();
        ctx.moveTo(-r * 0.94, r * 0.44);
        ctx.quadraticCurveTo(-r * 1.0, r * 0.78, -r * 0.7, r * 0.84);
        ctx.lineTo(r * 0.7, r * 0.84);
        ctx.quadraticCurveTo(r * 1.0, r * 0.78, r * 0.94, r * 0.44);
        ctx.quadraticCurveTo(0, r * 0.3, -r * 0.94, r * 0.44);
        ctx.closePath();
      };
      const capPath = () => {
        ctx.beginPath();
        if (hold) {
          // Whipped cream: three stacked blobs.
          ctx.ellipse(0, -r * 0.46, r * 0.46, r * 0.17, 0, 0, Math.PI * 2);
          ctx.moveTo(r * 0.3, -r * 0.62);
          ctx.ellipse(0, -r * 0.62, r * 0.3, r * 0.14, 0, 0, Math.PI * 2);
          ctx.moveTo(r * 0.14, -r * 0.78);
          ctx.ellipse(r * 0.01, -r * 0.78, r * 0.14, r * 0.1, 0, 0, Math.PI * 2);
        } else {
          ctx.ellipse(0, -r * 0.46, r * 0.42, r * 0.16, 0, 0, Math.PI * 2);
        }
      };

      // Outline pass.
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      ctx.lineWidth = r * 0.2;
      ctx.strokeStyle = P.outline;
      ctx.fillStyle = P.outline;
      platePath(); ctx.stroke(); ctx.fill();
      bodyPath(); ctx.stroke(); ctx.fill();
      capPath(); ctx.stroke(); ctx.fill();
      ctx.shadowBlur = 0;

      // Plate with a light line near the rim.
      const pg = ctx.createLinearGradient(0, r * 0.3, 0, r * 0.84);
      pg.addColorStop(0, P.plate); pg.addColorStop(1, P.plateLow);
      platePath();
      ctx.fillStyle = pg;
      ctx.fill();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = r * 0.045;
      ctx.beginPath();
      ctx.moveTo(-r * 0.7, r * 0.66);
      ctx.lineTo(r * 0.7, r * 0.66);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Body.
      const bg = ctx.createLinearGradient(0, -r * 0.5, 0, r * 0.5);
      bg.addColorStop(0, P.body); bg.addColorStop(1, P.bodyLow);
      bodyPath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = r * 0.08;
      ctx.beginPath();
      ctx.moveTo(-r * 0.36, -r * 0.2);
      ctx.quadraticCurveTo(-r * 0.46, r * 0.1, -r * 0.5, r * 0.34);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Top.
      capPath();
      ctx.fillStyle = P.cream;
      ctx.fill();
      if (hold) {
        ctx.fillStyle = P.dot;
        ctx.beginPath();
        ctx.arc(r * 0.04, -r * 0.8, r * 0.05, 0, Math.PI * 2);
        ctx.fill();
        // Syrup running down the front.
        ctx.fillStyle = P.bodyLow;
        ctx.beginPath();
        ctx.moveTo(-r * 0.34, -r * 0.4);
        ctx.quadraticCurveTo(-r * 0.24, -r * 0.05, -r * 0.14, -r * 0.4);
        ctx.moveTo(r * 0.12, -r * 0.4);
        ctx.quadraticCurveTo(r * 0.22, -r * 0.18, r * 0.32, -r * 0.4);
        ctx.fill();
      } else {
        const dg = ctx.createRadialGradient(-r * 0.03, -r * 0.5, 0, 0, -r * 0.46, r * 0.16);
        dg.addColorStop(0, P.dotHi); dg.addColorStop(1, P.dot);
        ctx.fillStyle = dg;
        ctx.beginPath();
        ctx.ellipse(0, -r * 0.47, r * 0.16, r * 0.1, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },
  };
})();
