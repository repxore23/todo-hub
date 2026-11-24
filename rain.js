/* Rain on the window: still condensation droplets plus a few drops that slowly slide down,
   leaving faint trails. Pauses when the app is hidden; stays still with "reduce motion".
   Turned on/off in Settings (localStorage "hub.rain", default on). */
(() => {
  'use strict';
  const cv = document.getElementById('rain');
  if (!cv || !cv.getContext) return;
  const ctx = cv.getContext('2d');
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let enabled = true;
  try { enabled = JSON.parse(localStorage.getItem('hub.rain') ?? 'true') !== false; } catch { /* default on */ }

  let W = 0; let H = 0; let dpr = 1;
  let mist = null; // pre-rendered condensation layer
  let drops = [];
  let raf = 0; let last = 0;

  const rand = (a, b) => a + Math.random() * (b - a);

  function drawDrop(c, x, y, r, alpha) {
    // Dark lens body, soft lower shadow, bright highlight top-left: reads as water on glass.
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
    c.fillStyle = `rgba(12, 16, 10, ${0.28 * alpha})`; c.fill();
    c.beginPath(); c.arc(x, y + r * 0.25, r * 0.85, 0, Math.PI);
    c.fillStyle = `rgba(0, 0, 0, ${0.18 * alpha})`; c.fill();
    c.beginPath(); c.arc(x - r * 0.3, y - r * 0.35, Math.max(0.6, r * 0.32), 0, Math.PI * 2);
    c.fillStyle = `rgba(235, 242, 225, ${0.45 * alpha})`; c.fill();
  }

  function buildMist() {
    mist = document.createElement('canvas');
    mist.width = W * dpr; mist.height = H * dpr;
    const m = mist.getContext('2d');
    m.scale(dpr, dpr);
    // Denser, slightly bigger beads lower down, like the bottom of a fogged window.
    const n = Math.round((W * H) / 2600);
    for (let i = 0; i < n; i++) {
      const y = H * Math.pow(Math.random(), 0.55);
      const lower = y / H;
      const r = rand(0.5, 1.3 + lower * 1.8);
      drawDrop(m, rand(0, W), y, r, 0.45 + lower * 0.55);
    }
  }

  function spawn(initial) {
    return {
      x: rand(0, W),
      y: initial ? rand(0, H * 0.8) : rand(-20, H * 0.45),
      r: rand(2.2, 4.6),
      v: 0,
      pause: rand(0, 3000),
      trail: [],
    };
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = W * dpr; cv.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildMist();
    const count = Math.max(6, Math.min(18, Math.round(W / 90)));
    drops = Array.from({ length: count }, () => spawn(true));
    frame(performance.now(), true);
  }

  function frame(now, once) {
    const dt = Math.min(64, now - (last || now)); last = now;
    ctx.clearRect(0, 0, W, H);
    if (!enabled) return;
    ctx.drawImage(mist, 0, 0, W, H);
    for (const d of drops) {
      if (!still && !once) {
        // Stick-slip motion: drops wait, then slide, then slow down again.
        if (d.pause > 0) d.pause -= dt;
        else {
          d.v = Math.min(0.12 + d.r * 0.02, d.v + 0.0004 * dt);
          d.y += d.v * dt;
          d.x += Math.sin((d.y + d.r * 40) / 60) * 0.03 * dt;
          if (Math.random() < 0.004 * (dt / 16)) { d.pause = rand(300, 2200); d.v = 0; }
          d.trail.push([d.x, d.y]);
          if (d.trail.length > 90) d.trail.shift();
        }
        if (d.y - d.r > H) Object.assign(d, spawn(false));
      }
      if (d.trail.length > 1) {
        ctx.beginPath();
        ctx.moveTo(d.trail[0][0], d.trail[0][1]);
        for (const [tx, ty] of d.trail) ctx.lineTo(tx, ty);
        ctx.strokeStyle = 'rgba(225, 235, 212, 0.07)';
        ctx.lineWidth = d.r * 0.9; ctx.lineCap = 'round';
        ctx.stroke();
      }
      drawDrop(ctx, d.x, d.y, d.r, 1);
    }
  }

  function loop(now) {
    frame(now, false);
    raf = enabled && !still && !document.hidden ? requestAnimationFrame(loop) : 0;
  }
  function start() { if (!raf && enabled && !still && !document.hidden) { last = 0; raf = requestAnimationFrame(loop); } }

  window.addEventListener('resize', () => { cancelAnimationFrame(raf); raf = 0; resize(); start(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; } else start(); });

  // Settings toggle
  const toggle = document.getElementById('rain-toggle');
  if (toggle) {
    toggle.checked = enabled;
    toggle.addEventListener('change', () => {
      enabled = toggle.checked;
      try { localStorage.setItem('hub.rain', JSON.stringify(enabled)); } catch { /* ignore */ }
      cancelAnimationFrame(raf); raf = 0;
      frame(performance.now(), true);
      start();
    });
  }

  resize();
  start();
})();
