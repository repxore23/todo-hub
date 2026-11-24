/* Background + rain on the window.
   Realistic rain uses RaindropFX (MIT, github.com/SardineFish/raindrop-fx), the same engine as the
   "Raindrops" Wallpaper Engine wallpaper, with that wallpaper's settings.
   The picture behind the glass is either the built-in fog, or a picture you choose in Settings,
   which is stored privately on this device only (IndexedDB) and never uploaded anywhere.
   Rain can be turned off in Settings (localStorage "hub.rain"); it also stays off with "reduce motion". */
(() => {
  'use strict';
  const cv = document.getElementById('rain');
  const glow = document.querySelector('.glow');
  if (!cv) return;
  const still = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const ls = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  let rainOn = ls('hub.rain', true) !== false;
  let fx = null; let bgUrl = null; let resizeTimer = 0;

  // ---------- picture storage (this device only) ----------
  function db() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('todo-hub', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function getBg() {
    try { const d = await db(); return await new Promise((res) => { const q = d.transaction('files').objectStore('files').get('bg'); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
    catch { return null; }
  }
  async function putBg(blob) {
    const d = await db();
    await new Promise((res, rej) => { const tx = d.transaction('files', 'readwrite'); if (blob) tx.objectStore('files').put(blob, 'bg'); else tx.objectStore('files').delete('bg'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  // ---------- the picture behind the glass ----------
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  // Draws the picture (or the fog) to fit the screen like CSS "cover", so it never stretches.
  async function backgroundCanvas(w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const blob = await getBg();
    if (blob) {
      if (bgUrl) URL.revokeObjectURL(bgUrl);
      bgUrl = URL.createObjectURL(blob);
      try {
        const img = await loadImage(bgUrl);
        const s = Math.max(w / img.width, h / img.height);
        g.drawImage(img, (w - img.width * s) / 2, (h - img.height * s) / 2, img.width * s, img.height * s);
        return { canvas: c, custom: true };
      } catch { /* fall back to fog */ }
    }
    const lin = g.createLinearGradient(0, 0, 0, h);
    [[0, '#6a7b61'], [0.28, '#5c6d54'], [0.5, '#4a5a43'], [0.68, '#2e3a2a'], [0.84, '#182016'], [1, '#0f140d']].forEach(([o, col]) => lin.addColorStop(o, col));
    g.fillStyle = lin; g.fillRect(0, 0, w, h);
    const rad = g.createRadialGradient(w / 2, -h * 0.05, 0, w / 2, -h * 0.05, Math.max(w, h) * 0.7);
    rad.addColorStop(0, 'rgba(170,186,158,0.35)'); rad.addColorStop(1, 'rgba(170,186,158,0)');
    g.fillStyle = rad; g.fillRect(0, 0, w, h);
    return { canvas: c, custom: false };
  }

  // ---------- rain ----------
  // Tuned to look like the desktop wallpaper at app-window size: fewer, finer drops, no dark mist patches.
  // (A desktop wallpaper is 2-3× wider than the app window, so the same pixel sizes look much heavier here.)
  // Based on the wallpaper's own settings, scaled to the window: the desktop is ~2× wider than the app,
  // so the same pixel-sized drops looked twice as heavy here. Rain amount (Light/Medium/Heavy) is in Settings.
  const LEVELS = { light: 0.45, medium: 0.75, heavy: 1.1 };
  function rainOptions(w) {
    const s = Math.min(1, Math.max(0.4, w / 2200));                 // drop size vs. a desktop-width wallpaper
    const amt = LEVELS[ls('hub.rainLevel', 'medium')] || LEVELS.medium; // how much rain
    const base = {
      backgroundBlurSteps: 2,
      backgroundWrapMode: 'clamp',
      mist: true,
      mistBlurStep: 4,
      mistColor: [0.30, 0.34, 0.27, 1], // lighter, greener than the wallpaper's near-black mist, so the top isn't dark
      mistTime: 18,
      dropletsPerSeconds: Math.round(500 * s * amt),
      dropletSize: [10 * s, 30 * s],
      evaporate: 10,
      gravity: 2400,
      raindropCompose: 'smoother',
      refractBase: 0.4,
      refractScale: 0.6,
      slipRate: 0.1,
      spawnInterval: [1 / amt, 1 / amt],
      spawnSize: [Math.max(0.45, s), Math.max(0.55, s * 1.1)],
      spawnLimit: Math.round((w < 860 ? 900 : 2000) * s * amt),
    };
    return { ...base, ...ls('hub.rainCfg', {}) }; // optional per-device overrides (for tuning)
  }
  async function startRain() {
    stopRain();
    const w = window.innerWidth; const h = window.innerHeight;
    const bg = await backgroundCanvas(w, h);
    // Without rain (or without the engine), show the still picture behind the glass instead.
    if (!rainOn || still || typeof window.RaindropFX !== 'function') {
      cv.hidden = true;
      if (bg.custom) { glow.style.background = `center / cover no-repeat url(${bg.canvas.toDataURL('image/jpeg', 0.85)})`; }
      else glow.style.background = '';
      return;
    }
    cv.hidden = false;
    cv.width = w; cv.height = h;
    try {
      fx = new window.RaindropFX({ canvas: cv, background: bg.canvas, ...rainOptions(w) });
      fx.start();
      glow.style.visibility = 'hidden'; // the rain canvas now draws the picture itself
    } catch {
      cv.hidden = true; fx = null; glow.style.visibility = '';
    }
  }
  function stopRain() {
    if (fx) { try { fx.stop && fx.stop(); } catch { /* ignore */ } fx = null; }
    glow.style.visibility = '';
  }

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (fx && typeof fx.resize === 'function') { cv.width = innerWidth; cv.height = innerHeight; fx.resize(innerWidth, innerHeight); }
      else startRain();
    }, 250);
  });
  document.addEventListener('visibilitychange', () => {
    if (!fx) return;
    try { if (document.hidden) fx.stop && fx.stop(); else fx.start(); } catch { /* ignore */ }
  });

  // ---------- Settings ----------
  const toggle = document.getElementById('rain-toggle');
  if (toggle) {
    toggle.checked = rainOn;
    toggle.addEventListener('change', () => {
      rainOn = toggle.checked;
      try { localStorage.setItem('hub.rain', JSON.stringify(rainOn)); } catch { /* ignore */ }
      startRain();
    });
  }
  const level = document.getElementById('rain-level');
  if (level) {
    level.value = ls('hub.rainLevel', 'medium');
    level.addEventListener('change', () => {
      try { localStorage.setItem('hub.rainLevel', JSON.stringify(level.value)); } catch { /* ignore */ }
      startRain();
    });
  }
  const pick = document.getElementById('bg-file');
  const clear = document.getElementById('bg-clear');
  const status = document.getElementById('bg-status');
  async function showStatus() {
    const b = await getBg();
    if (status) status.textContent = b ? `Using your picture (${Math.round(b.size / 1024)} KB), saved on this device only.` : 'Using the built-in fog.';
    if (clear) clear.hidden = !b;
  }
  if (pick) {
    pick.addEventListener('change', async () => {
      const f = pick.files && pick.files[0];
      if (!f || !/^image\//.test(f.type)) return;
      await putBg(f); pick.value = '';
      await showStatus(); startRain();
    });
  }
  if (clear) clear.addEventListener('click', async () => { await putBg(null); await showStatus(); startRain(); });
  showStatus();

  // RaindropFX loads from a CDN; wait for it briefly, then start (falls back to the still picture).
  let tries = 0;
  (function boot() {
    if (typeof window.RaindropFX === 'function' || tries++ > 20) startRain();
    else setTimeout(boot, 150);
  })();
})();
