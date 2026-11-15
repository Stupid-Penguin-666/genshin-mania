/* Shield: a crest with a cream face and an ornamental leaf motif.
   Tap is gold, hold is teal. */
(() => {
  const registry = window.GenshinManiaSkinRenderers || (window.GenshinManiaSkinRenderers = {});

  const rgb = (h) => { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const hex = (a) => "#" + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
  const lift = (h, t) => mix(h, "#ffffff", t);

  const PAL = {
    tap:  { edge: "#eba43a", rim: "#fbc45a", face: "#fbf4e6", faceLow: "#f3dd9a", motif: "#e2b455", glow: "#f4b94a" },
    hold: { edge: "#2f9fb0", rim: "#62d6d6", face: "#b9f2ea", faceLow: "#6fdcd9", motif: "#f2fffd", glow: "#4ec9c4" },
  };

  // Heater shield with a pointed crown, scaled by s about the origin.
  function shieldPath(ctx, r, s, dy) {
    const w = 0.9 * r * s, top = -0.98 * r * s + dy, bot = 0.98 * r * s + dy;
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.quadraticCurveTo(w * 0.3, top + r * 0.3 * s, w * 0.96, top + r * 0.22 * s);   // concave top edge
    ctx.quadraticCurveTo(w * 1.02, top + r * 0.5 * s, w * 0.9, r * 0.22 * s + dy);
    ctx.bezierCurveTo(w * 0.78, r * 0.62 * s + dy, w * 0.4, r * 0.82 * s + dy, 0, bot);
    ctx.bezierCurveTo(-w * 0.4, r * 0.82 * s + dy, -w * 0.78, r * 0.62 * s + dy, -w * 0.9, r * 0.22 * s + dy);
    ctx.quadraticCurveTo(-w * 1.02, top + r * 0.5 * s, -w * 0.96, top + r * 0.22 * s);
    ctx.quadraticCurveTo(-w * 0.3, top + r * 0.3 * s, 0, top);
    ctx.closePath();
  }

  registry.shield = {
    draw(ctx, { radius: r, variant, active, useGlow }) {
      const base = PAL[variant === "hold" ? "hold" : "tap"];
      const P = {};
      for (const k in base) P[k] = active ? lift(base[k], 0.28) : base[k];

      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";

      // Outer frame.
      shieldPath(ctx, r, 1, 0);
      if (useGlow) { ctx.shadowColor = P.glow; ctx.shadowBlur = 10; }
      ctx.fillStyle = P.edge;
      ctx.fill();
      ctx.shadowBlur = 0;
      const rimG = ctx.createLinearGradient(0, -r, 0, r);
      rimG.addColorStop(0, lift(P.rim, 0.25)); rimG.addColorStop(1, P.rim);
      shieldPath(ctx, r, 0.93, 0);
      ctx.fillStyle = rimG;
      ctx.fill();

      // Face.
      const faceG = ctx.createLinearGradient(0, -r * 0.8, 0, r * 0.8);
      faceG.addColorStop(0, P.face); faceG.addColorStop(1, P.faceLow);
      shieldPath(ctx, r, 0.78, 0);
      ctx.fillStyle = faceG;
      ctx.fill();

      // Ornament: a central leaf flanked by curling leaves.
      ctx.fillStyle = P.motif;
      ctx.strokeStyle = P.motif;
      const leaf = (cx, cy, len, wid, rot) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.moveTo(0, len / 2);
        ctx.quadraticCurveTo(wid, 0, 0, -len / 2);
        ctx.quadraticCurveTo(-wid, 0, 0, len / 2);
        ctx.fill();
        ctx.restore();
      };
      leaf(0, -r * 0.04, r * 1.1, r * 0.2, 0);                   // centre stem leaf
      leaf(-r * 0.28, -r * 0.32, r * 0.62, r * 0.17, 0.7);       // upper side leaves
      leaf(r * 0.28, -r * 0.32, r * 0.62, r * 0.17, -0.7);
      leaf(-r * 0.3, r * 0.1, r * 0.55, r * 0.14, 1.25);         // lower side leaves
      leaf(r * 0.3, r * 0.1, r * 0.55, r * 0.14, -1.25);
      ctx.lineWidth = r * 0.08;
      ctx.beginPath();                                           // curling tendrils
      ctx.moveTo(-r * 0.12, r * 0.42);
      ctx.quadraticCurveTo(-r * 0.5, r * 0.44, -r * 0.5, r * 0.14);
      ctx.moveTo(r * 0.12, r * 0.42);
      ctx.quadraticCurveTo(r * 0.5, r * 0.44, r * 0.5, r * 0.14);
      ctx.stroke();

      // Sheen along the upper left of the frame.
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = r * 0.05;
      ctx.beginPath();
      ctx.moveTo(-r * 0.74, -r * 0.52);
      ctx.quadraticCurveTo(-r * 0.36, -r * 0.7, -r * 0.05, -r * 0.88);
      ctx.stroke();
      ctx.restore();
    },
  };
})();
