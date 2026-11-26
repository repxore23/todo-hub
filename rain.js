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
    // Kept fairly even top to bottom: each drop shows a flipped view of the picture behind it, so a fog that
    // goes pale-to-black made every drop near the top look like a black speck.
    const lin = g.createLinearGradient(0, 0, 0, h);
    [[0, '#66765d'], [0.5, '#56664e'], [1, '#3c4936']].forEach(([o, col]) => lin.addColorStop(o, col));
    g.fillStyle = lin; g.fillRect(0, 0, w, h);
    const rad = g.createRadialGradient(w / 2, -h * 0.05, 0, w / 2, -h * 0.05, Math.max(w, h) * 0.7);
    rad.addColorStop(0, 'rgba(170,186,158,0.18)'); rad.addColorStop(1, 'rgba(170,186,158,0)');
    g.fillStyle = rad; g.fillRect(0, 0, w, h);
    return { canvas: c, custom: false };
  }

  // ---------- rain ----------
  // Exactly what the "Raindrops - Doomer" Wallpaper Engine wallpaper runs: its own engine file
  // (raindrop-wallpaper.js) with the engine's defaults. Of the wallpaper's saved settings, Wallpaper Engine only
  // ever applies the first few (a bug in the wallpaper's script stops the rest), and the only ones that differ
  // from the defaults are a blur of 2 and the dark mist. "Like the wallpaper" is exactly that.
  // Light / Medium only thin out the rain.
  const LEVELS = { light: 0.45, medium: 0.7, heavy: 1 };
  // Scaled to the window, so the app shows the same pattern as the full-screen wallpaper, just smaller:
  // drop sizes, distances and speed shrink with the window's width vs. the monitor's, and the number of
  // drops with its area. (At full screen, s = 1 and it's the wallpaper's own numbers.)
  function rainOptions(w, h) {
    const amt = LEVELS[ls('hub.rainLevel', 'heavy')] || 1;
    const sw = (window.screen && screen.width) || w, sh = (window.screen && screen.height) || h;
    const s = Math.min(1, Math.max(0.25, w / sw)); const area = Math.min(1, (w * h) / (sw * sh));
    return {
      backgroundBlurSteps: 2,
      mistColor: [0.10196078431372549, 0.10196078431372549, 0.10196078431372549, 1],
      // the engine's defaults, scaled
      spawnSize: [60 * s, 100 * s],
      dropletSize: [10 * s, 30 * s],
      trailDistance: [20 * s, 30 * s],
      gravity: 2400 * s,
      dropletsPerSeconds: Math.round(500 * area * amt),
      spawnLimit: Math.max(200, Math.round(2000 * area * amt)),
      spawnInterval: [0.1 / (area * amt), 0.1 / (area * amt)],
    };
  }
  async function startRain() {
    stopRain();
    const w = window.innerWidth; const h = window.innerHeight;
    const bg = await backgroundCanvas(w, h);
    // Without rain (or without the engine), show the still picture behind the glass instead.
    // The Dark theme is plain near-black: no rain (it only shows up as smears on black).
    const dark = document.documentElement.classList.contains('theme-dark');
    if (!rainOn || still || dark || typeof window.RaindropFX !== 'function') {
      cv.hidden = true;
      if (bg.custom && !dark) { glow.style.background = `center / cover no-repeat url(${bg.canvas.toDataURL('image/jpeg', 0.85)})`; }
      else glow.style.background = '';
      return;
    }
    cv.hidden = false;
    cv.width = w; cv.height = h;
    try {
      // Like the wallpaper, hand the engine the picture itself; without one, the built-in fog.
      fx = new window.RaindropFX({ canvas: cv, background: bg.custom ? bgUrl : bg.canvas, ...rainOptions(w, h) });
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
      startRain(); // restart so the drops are re-scaled to the new window size
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
  const theme = document.getElementById('theme-pick');
  if (theme) {
    theme.value = ls('hub.theme', 'fog') === 'dark' ? 'dark' : 'fog';
    theme.addEventListener('change', () => {
      const dark = theme.value === 'dark';
      try { localStorage.setItem('hub.theme', JSON.stringify(theme.value)); } catch { /* ignore */ }
      document.documentElement.classList.toggle('theme-dark', dark);
      const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.content = dark ? '#0a0c09' : '#1d251a';
      startRain();
    });
  }
  const level = document.getElementById('rain-level');
  if (level) {
    level.value = ls('hub.rainLevel', 'heavy');
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
