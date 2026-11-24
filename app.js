/* To-Do Hub — app logic.
   Data lives in one JSON file in Google Drive ("todo-hub-tasks.json").
   Claude chat can request changes by creating "todo-hub-inbox-*.json" notes in Drive;
   the app applies them on sync and moves the notes to the trash. */
(() => {
  'use strict';

  const CFG = window.HUB_CONFIG || {};
  const DRIVE_MODE = Boolean(CFG.googleClientId);
  const $ = (id) => document.getElementById(id);

  // ---------- storage helpers ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- dates ----------
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const todayStr = () => fmt(new Date());
  const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return fmt(d); };
  const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
  function dueLabel(due) {
    const t = todayStr();
    if (due === t) return 'Today';
    if (due === addDays(t, 1)) return 'Tomorrow';
    if (due === addDays(t, -1)) return 'Yesterday';
    const d = parse(due);
    const o = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }

  // ---------- state ----------
  const APP_VERSION = 'hub-v11';
  const emptyData = () => ({ app: 'todo-hub', version: 1, updatedAt: 0, tasks: [], processedNotes: [], feedback: [] });
  const FB_TYPES = ['look', 'feature', 'issue', 'idea'];
  function normalizeFeedback(f) {
    if (!f || typeof f !== 'object') return null;
    const text = String(f.text || '').trim().slice(0, 1500);
    if (!text) return null;
    return {
      id: String(f.id || newId()),
      at: Number(f.at) || Date.now(),
      type: FB_TYPES.includes(f.type) ? f.type
        : /look|aesthetic|design|colou?r|style/i.test(f.type || '') ? 'look'
        : /bug|problem|issue|broke|error/i.test(f.type || '') ? 'issue'
        : /function|feature|work/i.test(f.type || '') ? 'feature' : 'idea',
      source: ['app', 'box', 'chat'].includes(f.source) ? f.source : 'chat',
      text,
    };
  }
  let data = emptyData(); // filled from this device's saved copy once the helpers below exist
  let pending = LS.get('hub.pending', []);
  let filterCat = 'all';
  let editing = null;
  let resolving = null; // id of the issue whose "Resolve" box is open
  let view = 'dashboard';
  let lastUndo = null;

  function normalizeTask(t) {
    if (!t || typeof t !== 'object') return null;
    const title = String(t.title || '').trim().slice(0, 300);
    if (!title) return null;
    return {
      id: String(t.id || newId()),
      title,
      due: isDate(t.due) ? t.due : null,
      category: cleanCat(t.category),
      priority: normPri(t.priority),
      done: Boolean(t.done),
      doneAt: t.done ? (Number(t.doneAt) || Date.now()) : null,
      focus: Boolean(t.focus),
      est: Math.max(0, Math.min(6000, Math.round(Number(t.est) || 0))), // minutes; 0 = guess from the title
      kind: ['task', 'reminder', 'progress', 'issue'].includes(t.kind) ? t.kind : '', // '' = guess from the title
      note: String(t.note || '').slice(0, 1000), // e.g. how an issue was resolved; Claude reads it
      dateKind: ['due', 'aim'].includes(t.dateKind) ? t.dateKind : '', // due = real deadline, aim = own target; '' = guess
      total: Math.max(0, Math.min(200, Math.round(Number(t.total) || 0))), // parts for a progress task; 0 = guess
      prog: Math.max(0, Math.min(200, Math.round(Number(t.prog) || 0))), // parts finished so far
      createdAt: Number(t.createdAt) || Date.now(),
    };
  }
  function normalizeData(d) {
    if (!d) return null;
    const tasks = Array.isArray(d) ? d : d.tasks;
    if (!Array.isArray(tasks)) return null;
    return {
      app: 'todo-hub', version: 1, updatedAt: Number(d.updatedAt) || 0,
      tasks: tasks.map(normalizeTask).filter(Boolean),
      processedNotes: Array.isArray(d.processedNotes) ? d.processedNotes.slice(-300) : [],
      feedback: Array.isArray(d.feedback) ? d.feedback.map(normalizeFeedback).filter(Boolean).slice(-200) : [],
    };
  }
  const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const PRI_RANK = { high: 0, med: 1, low: 2 };
  const normPri = (p) => { p = String(p || '').toLowerCase(); return p === 'high' || p === 'low' ? p : (p === 'medium' ? 'med' : 'med'); };
  const cleanCat = (c) => String(c || '').trim().replace(/^#/, '').slice(0, 40);
  function newTask(f) {
    return normalizeTask({ id: newId(), title: f.title, due: f.due, category: f.category, priority: f.priority, done: false, createdAt: Date.now() });
  }
  function saveLocal() { LS.set('hub.data', data); LS.set('hub.pending', pending); }

  // ---------- usage & problem tracking (this device only, for the feedback report) ----------
  function stats() { return LS.get('hub.stats', null) || { since: Date.now(), counts: {}, problems: [] }; }
  function track(key, n = 1) {
    const s = stats(); s.counts[key] = (s.counts[key] || 0) + n; LS.set('hub.stats', s);
  }
  function trackProblem(msg) {
    const s = stats();
    const last = s.problems[s.problems.length - 1];
    if (last && last.msg === msg) { last.times = (last.times || 1) + 1; last.at = Date.now(); }
    else s.problems.push({ at: Date.now(), msg: String(msg).slice(0, 300), times: 1 });
    s.problems = s.problems.slice(-40);
    LS.set('hub.stats', s);
  }
  data = normalizeData(LS.get('hub.data', null)) || emptyData();

  // ---------- operations ----------
  // op: {type:'add', task} | {type:'patch', id, fields} | {type:'delete', id}
  function applyOp(tasks, op) {
    const id = op.type === 'add' ? op.task.id : op.id;
    const i = tasks.findIndex((t) => t.id === id);
    if (op.type === 'add') { if (i < 0) tasks.push({ ...op.task }); }
    else if (op.type === 'patch') { if (i >= 0) Object.assign(tasks[i], op.fields); }
    else if (op.type === 'delete') { if (i >= 0) tasks.splice(i, 1); }
  }
  // Applies an op to a whole data object: task ops go to .tasks, {type:'fb', entry} adds feedback,
  // {type:'fb-clear', ids} removes feedback entries (after a report has been sent).
  function applyOpData(d, op) {
    if (op.type === 'fb') {
      const e = normalizeFeedback(op.entry);
      if (e && !d.feedback.some((f) => f.id === e.id)) { d.feedback.push(e); d.feedback = d.feedback.slice(-200); }
    } else if (op.type === 'fb-clear') {
      const ids = new Set(op.ids || []);
      d.feedback = d.feedback.filter((f) => !ids.has(f.id));
    } else applyOp(d.tasks, op);
  }
  function inverseOps(ops) {
    // Built against the current state, before the ops are applied.
    const inv = [];
    const sim = data.tasks.map((t) => ({ ...t }));
    for (const op of ops) {
      if (op.type === 'add') inv.unshift({ type: 'delete', id: op.task.id });
      else {
        const prev = sim.find((t) => t.id === op.id);
        if (!prev) continue;
        if (op.type === 'delete') inv.unshift({ type: 'add', task: { ...prev } });
        else {
          const back = {};
          for (const k of Object.keys(op.fields)) back[k] = prev[k];
          inv.unshift({ type: 'patch', id: op.id, fields: back });
        }
      }
      applyOp(sim, op);
    }
    return inv;
  }
  function commit(ops) {
    if (!ops.length) return;
    ops.forEach((op) => applyOpData(data, op));
    data.updatedAt = Date.now();
    pending.push(...ops);
    saveLocal();
    render();
    scheduleSync();
  }

  // Turn plain-language change records (from the Claude box or a chat note) into ops.
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function findTask(ref, tasks) {
    if (!ref) return null;
    const r = String(ref).trim();
    const byId = tasks.find((x) => x.id === r);
    if (byId) return byId;
    const nr = norm(r);
    if (!nr) return null;
    const pool = [...tasks].sort((a, b) => Number(a.done) - Number(b.done)); // prefer open tasks
    const exact = pool.find((x) => norm(x.title) === nr);
    if (exact) return exact;
    const partial = pool.find((x) => { const nt = norm(x.title); return nt.includes(nr) || nr.includes(nt); });
    if (partial) return partial;
    const words = nr.split(' ').filter((w) => w.length > 1);
    if (!words.length) return null;
    let best = null; let bestScore = 0;
    for (const x of pool) {
      const tw = new Set(norm(x.title).split(' '));
      const hits = words.filter((w) => tw.has(w)).length;
      const score = hits / words.length;
      if (score > bestScore) { bestScore = score; best = x; }
    }
    return bestScore >= 0.6 ? best : null;
  }
  function changesToOps(changes, tasks, source = 'chat') {
    const ops = []; const did = []; const skipped = [];
    const work = tasks.map((t) => ({ ...t }));
    for (const c of Array.isArray(changes) ? changes : []) {
      if (!c || typeof c !== 'object') continue;
      const action = String(c.action || '').toLowerCase();
      if (action === 'feedback') {
        const e = normalizeFeedback({ type: c.type || c.category, text: c.text || c.title || c.note, source });
        if (e) { ops.push({ type: 'fb', entry: e }); did.push(`noted app feedback: “${e.text.slice(0, 60)}${e.text.length > 60 ? '…' : ''}”`); }
        continue;
      }
      if (action === 'add') {
        const task = newTask({ title: c.title, due: c.due, category: c.category, priority: c.priority });
        if (!task) { skipped.push('an add with no title'); continue; }
        if (['yes', 'true'].includes(String(c.focus).toLowerCase())) task.focus = true;
        if (['task', 'reminder', 'progress', 'issue'].includes(c.kind)) task.kind = c.kind;
        if (['due', 'aim'].includes(c.dateKind)) task.dateKind = c.dateKind;
        if (Number(c.est) > 0) task.est = Math.round(Number(c.est));
        if (Number(c.total) > 0) task.total = Math.round(Number(c.total));
        if (c.note) task.note = String(c.note).slice(0, 1000);
        ops.push({ type: 'add', task }); work.push(task); did.push(`added “${task.title}”`);
        continue;
      }
      const t = findTask(c.task || c.id || c.title, work);
      if (!t) { skipped.push(`couldn't find “${c.task || c.title || '?'}”`); continue; }
      let op = null;
      if (action === 'resolve') {
        const f = { done: true, doneAt: Date.now(), focus: false };
        if (c.note) f.note = String(c.note).slice(0, 1000);
        op = { type: 'patch', id: t.id, fields: f }; did.push(`resolved “${t.title}”`);
      } else if (action === 'complete' || action === 'done') {
        op = { type: 'patch', id: t.id, fields: { done: true, doneAt: Date.now() } }; did.push(`finished “${t.title}”`);
      } else if (action === 'reopen' || action === 'undone') {
        op = { type: 'patch', id: t.id, fields: { done: false, doneAt: null } }; did.push(`reopened “${t.title}”`);
      } else if (action === 'delete' || action === 'remove') {
        op = { type: 'delete', id: t.id }; did.push(`removed “${t.title}”`);
      } else if (action === 'update' || action === 'edit') {
        const f = {};
        if (c.title && c.task && String(c.title).trim() && c.title !== t.title) f.title = String(c.title).trim().slice(0, 300);
        if (c.due === 'none' || c.due === null) f.due = null; else if (isDate(c.due)) f.due = c.due;
        if (c.category) f.category = cleanCat(c.category);
        if (c.priority) f.priority = normPri(c.priority);
        const fv = String(c.focus === undefined ? '' : c.focus).toLowerCase();
        if (fv === 'yes' || fv === 'true') f.focus = true; else if (fv === 'no' || fv === 'false') f.focus = false;
        if (['task', 'reminder', 'progress', 'issue'].includes(c.kind)) f.kind = c.kind;
        if (['due', 'aim'].includes(c.dateKind)) f.dateKind = c.dateKind;
        if (Number(c.est) > 0) f.est = Math.round(Number(c.est));
        if (Number(c.total) > 0) f.total = Math.round(Number(c.total));
        if (c.note) f.note = String(c.note).slice(0, 1000);
        if (c.progress !== undefined && c.progress !== '' && !Number.isNaN(Number(c.progress))) {
          const tot = Number(c.total) > 0 ? Number(c.total) : totalOf(t);
          f.prog = Math.max(0, Math.round(Number(c.progress)));
          if (tot && f.prog >= tot) { f.prog = tot; f.done = true; f.doneAt = Date.now(); }
        }
        if (!Object.keys(f).length) { skipped.push(`nothing to change on “${t.title}”`); continue; }
        op = { type: 'patch', id: t.id, fields: f }; did.push(`updated “${t.title}”`);
      } else { skipped.push(`unknown action “${action}”`); continue; }
      ops.push(op); applyOp(work, op);
    }
    return { ops, did, skipped };
  }

  // ---------- Google Drive ----------
  const SCOPE = 'https://www.googleapis.com/auth/drive';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const FILE_NAME = 'todo-hub-tasks.json';
  let token = LS.get('hub.gtoken', null);
  let tokenClient = null;
  const tokenValid = () => Boolean(token && token.exp > Date.now() + 60000);

  function initGis() {
    if (tokenClient) return true;
    if (!window.google || !google.accounts || !google.accounts.oauth2) return false;
    tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CFG.googleClientId, scope: SCOPE, callback: () => {} });
    return true;
  }
  function requestToken() {
    return new Promise((resolve, reject) => {
      if (!initGis()) { reject({ code: 'gis' }); return; }
      tokenClient.callback = (r) => {
        if (r.error) { reject(r); return; }
        token = { access_token: r.access_token, exp: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        LS.set('hub.gtoken', token); LS.set('hub.gconsent', true);
        resolve();
      };
      tokenClient.error_callback = (e) => reject(e);
      tokenClient.requestAccessToken({ prompt: LS.get('hub.gconsent', false) ? '' : 'select_account consent' });
    });
  }
  async function connect() {
    if (!DRIVE_MODE) { openSettings(); return; }
    try { await requestToken(); await sync(); }
    catch (e) { setSync('err', e && e.code === 'gis' ? 'Google sign-in didn’t load — check your connection' : 'Sign-in cancelled — tap to retry'); }
  }
  async function gfetch(url, opts = {}) {
    if (!tokenValid()) throw { code: 'auth' };
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token.access_token } });
    if (r.status === 401) { token = null; LS.del('hub.gtoken'); throw { code: 'auth' }; }
    if (!r.ok) throw { code: 'http', status: r.status };
    return r;
  }
  async function createFile(content) {
    const boundary = 'hub' + Math.random().toString(36).slice(2);
    const meta = { name: FILE_NAME, mimeType: 'text/plain', description: 'To-Do Hub task list. Change it through the To-Do Hub app or a todo-hub-inbox note.' };
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`
      + `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${JSON.stringify(content, null, 1)}\r\n--${boundary}--`;
    const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
    return (await r.json()).id;
  }
  async function findFile() {
    let id = LS.get('hub.fileId', null);
    if (id) {
      try {
        const m = await (await gfetch(`${DRIVE}/files/${id}?fields=id,trashed`)).json();
        if (!m.trashed) return id;
      } catch (e) { if (e.code === 'auth') throw e; }
    }
    const q = encodeURIComponent(`name='${FILE_NAME}' and trashed=false`);
    const { files } = await (await gfetch(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=modifiedTime desc&fields=files(id)`)).json();
    id = files && files.length ? files[0].id : await createFile({ ...data, updatedAt: Date.now() });
    if (!(files && files.length)) pending = []; // the new file already holds everything we had
    LS.set('hub.fileId', id);
    return id;
  }
  async function readFile(id) {
    const txt = await (await gfetch(`${DRIVE}/files/${id}?alt=media`)).text();
    let parsed = null;
    try { parsed = normalizeData(JSON.parse(txt)); } catch { /* handled below */ }
    if (!parsed) throw { code: 'corrupt' };
    return parsed;
  }
  async function writeFile(id, d) {
    await gfetch(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: JSON.stringify(d, null, 1) });
  }
  function lenientJson(txt) {
    const s = String(txt || '').replace(/^﻿/, '');
    try { return JSON.parse(s); } catch { /* fall through */ }
    const a = s.indexOf('{'); const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
    return null;
  }
  async function readInbox() {
    const q = encodeURIComponent("name contains 'todo-hub-inbox' and trashed=false");
    const { files } = await (await gfetch(`${DRIVE}/files?q=${q}&spaces=drive&orderBy=createdTime&fields=files(id,name,mimeType)`)).json();
    const notes = [];
    for (const f of files || []) {
      const url = f.mimeType === 'application/vnd.google-apps.document'
        ? `${DRIVE}/files/${f.id}/export?mimeType=text/plain`
        : `${DRIVE}/files/${f.id}?alt=media`;
      try {
        const j = lenientJson(await (await gfetch(url)).text());
        const changes = Array.isArray(j) ? j : j && (j.changes || j.ops);
        notes.push(Array.isArray(changes) ? { id: f.id, name: f.name, changes } : { id: f.id, name: f.name, error: true });
      } catch (e) { if (e.code === 'auth') throw e; notes.push({ id: f.id, name: f.name, error: true }); }
    }
    return notes;
  }
  const trashFile = (id) => gfetch(`${DRIVE}/files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });

  let syncing = null; let syncAgain = false; let syncTimer = null;
  function scheduleSync() {
    if (!DRIVE_MODE) { pending = []; saveLocal(); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, 700);
  }
  async function sync() {
    if (!DRIVE_MODE) return;
    if (!tokenValid()) {
      setSync('warn', pending.length ? `Tap to sync ${pending.length} change${pending.length > 1 ? 's' : ''}` : 'Tap to connect Drive');
      return;
    }
    if (syncing) { syncAgain = true; return syncing; }
    syncing = (async () => {
      setSync('busy', 'Syncing…');
      try {
        const id = await findFile();
        const remote = await readFile(id);
        const sent = pending.slice();
        sent.forEach((op) => applyOpData(remote, op));

        const notes = await readInbox();
        const from = []; const toTrash = [];
        for (const n of notes) {
          if (remote.processedNotes.includes(n.id)) { toTrash.push(n.id); continue; }
          if (n.error) {
            const seen = LS.get('hub.badNotes', []);
            if (!seen.includes(n.id)) {
              from.push(`couldn't read the note “${n.name}”`); LS.set('hub.badNotes', [...seen, n.id].slice(-50));
              trackProblem(`Couldn't read a Claude chat note (${n.name})`);
            }
            continue;
          }
          const res = changesToOps(n.changes, remote.tasks);
          res.ops.forEach((op) => applyOpData(remote, op));
          from.push(...res.did, ...res.skipped.map((s) => 'skipped: ' + s));
          remote.processedNotes.push(n.id);
          toTrash.push(n.id);
          track('notes.applied');
          if (res.skipped.length) trackProblem(`A Claude chat note had changes the app skipped: ${res.skipped.join('; ')}`);
        }
        remote.processedNotes = remote.processedNotes.slice(-300);

        if (sent.length || from.length) { remote.updatedAt = Date.now(); await writeFile(id, remote); }
        for (const nid of toTrash) { try { await trashFile(nid); } catch { /* retried next sync */ } }

        pending = pending.slice(sent.length);
        data = remote;
        pending.forEach((op) => applyOpData(data, op));
        saveLocal();
        LS.set('hub.lastSync', Date.now());
        setSync('ok', 'Synced just now');
        render();
        if (from.length) toast('From Claude chat: ' + from.join(' · '), 7000);
      } catch (e) {
        if (e && e.code === 'auth') setSync('warn', 'Tap to reconnect Drive');
        else if (e && e.code === 'corrupt') { trackProblem('Task file in Drive was unreadable'); setSync('err', 'Task file is unreadable'); showBanner('Your task file in Google Drive couldn’t be read, so nothing was overwritten. Restore an older version of “todo-hub-tasks.json” in Drive (right-click → Manage versions).'); }
        else {
          if (navigator.onLine) trackProblem(`Sync failed${e && e.status ? ` (HTTP ${e.status})` : ''}`);
          setSync('err', navigator.onLine ? 'Sync failed — tap to retry' : 'Offline — changes are kept on this device');
        }
      } finally {
        syncing = null;
        if (syncAgain) { syncAgain = false; sync(); }
      }
    })();
    return syncing;
  }
  function setSync(state, text) {
    const b = $('sync-btn');
    b.className = 'sync ' + state;
    $('sync-text').textContent = text;
    const ds = $('drive-status');
    if (ds) ds.textContent = DRIVE_MODE ? (tokenValid() ? 'Connected to Google Drive. ' + text + '.' : 'Not connected right now. ' + text + '.') : '';
  }
  function updateSyncAge() {
    if (!DRIVE_MODE || !$('sync-btn').classList.contains('ok')) return;
    const t = LS.get('hub.lastSync', 0);
    const m = Math.round((Date.now() - t) / 60000);
    $('sync-text').textContent = m < 1 ? 'Synced just now' : `Synced ${m} min ago`;
  }

  // ---------- Claude box ----------
  const RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['add', 'complete', 'resolve', 'reopen', 'update', 'delete', 'feedback'] },
            task: { type: 'string' },
            title: { type: 'string' },
            due: { type: 'string' },
            category: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'med', 'low', ''] },
            focus: { type: 'string', enum: ['yes', 'no', ''] },
            progress: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['action', 'task', 'title', 'due', 'category', 'priority', 'focus', 'progress', 'note'],
          additionalProperties: false,
        },
      },
    },
    required: ['reply', 'changes'],
    additionalProperties: false,
  };
  function buildPrompt(msg) {
    const t = todayStr();
    const recent = Date.now() - 14 * 864e5;
    const list = data.tasks
      .filter((x) => !x.done || (x.doneAt || 0) >= recent)
      .map((x) => {
        const o = { id: x.id, title: x.title, due: x.due, category: x.category, priority: x.priority, done: x.done, focus: x.focus, kind: kindOf(x) };
        if (o.kind === 'progress') { o.progress = x.prog; o.total = totalOf(x); }
        if (x.note) o.note = x.note;
        return o;
      });
    return `You manage a student's personal to-do list. Today is ${new Date().toLocaleDateString('en-US', { weekday: 'long' })}, ${t}.

Current tasks (open ones, plus anything finished in the last 14 days):
${JSON.stringify(list)}

Categories in use: ${JSON.stringify(categories())}

The user wrote:
"""${msg.slice(0, 4000)}"""

Turn the message into changes to the list.
- "task": the id of the existing task the change is about ("" for add).
- For add: "title" is required; "due" is YYYY-MM-DD or ""; "category" reuses an existing one when it fits, else a short name or ""; "priority" defaults to "med".
- For update: fill only the fields that change and leave the rest "". Use "due": "none" to remove a date.
- Prefer "complete" when the user finished something; use "delete" only when they cancel or remove it.
- Resolve relative dates ("tomorrow", "Friday" = the next Friday after today) against today.
- Kinds: "reminder" tasks are notices (they expire on their own; never complete them). "progress" tasks have parts (e.g. 9 lecture recordings): set "progress" to the number of parts done so far, e.g. "3" (it completes itself at the total); otherwise leave "progress" "". "issue" tasks are missed or missing things: use action "resolve" with a short "note" saying what happened, instead of "complete".
- If the user says anything about the To-Do Hub app itself (how it looks, how it works, a problem, an idea for it), log it with action "feedback": "title" = the feedback in one clear sentence, "category" = "look", "feature", "issue" or "idea", other fields "".
- When the user says they're behind on lectures, add one catch-up task per course titled like "Catch-up: BIOA01 lectures 4–6" or "Catch-up: CHMA10 lectures (5 recordings)" so the app shows a progress counter.
- Read each task's "note". If a resolved note implies a follow-up (e.g. "got notes, still need to review"), add that follow-up as a new task. Leave "note" "" unless you are resolving.
- "focus" puts a task on Today's focus (the list of what to work on today): "yes" to add it, "no" to take it off, "" to leave it. Use it when the user says they'll work on something today, or asks to plan today.
- Never add tasks the user didn't mention.
"reply": one short sentence saying what changed. If the message is a question about the list, return no changes and answer it in "reply" in at most 4 short plain-text lines.`;
  }
  async function callClaude(msg) {
    const key = LS.get('hub.apiKey', '');
    const model = LS.get('hub.model', 'claude-haiku-5-5');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2026-10-21',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4000,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
        messages: [{ role: 'user', content: buildPrompt(msg) }],
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw { status: res.status, message: body && body.error && body.error.message };
    }
    const j = await res.json();
    if (j.stop_reason === 'refusal') throw { status: 'refusal' };
    const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const out = lenientJson(text);
    if (!out) throw { status: 'parse' };
    return out;
  }
  function claudeError(e) {
    const s = e && e.status;
    const m = (e && e.message) || '';
    if (s === 401) return 'That API key wasn’t accepted. Check it in Settings.';
    if (/credit|billing|balance/i.test(m)) return 'Your API account is out of credit. Top up at console.anthropic.com.';
    if (s === 429) return 'Too many requests right now. Try again in a minute.';
    if (s === 529 || s === 503) return 'Claude is busy right now. Try again shortly.';
    if (s === 'refusal') return 'Claude couldn’t help with that one. Try rewording it.';
    if (s === 'parse') return 'Claude’s answer came back garbled. Try again.';
    if (!navigator.onLine) return 'You’re offline. The Claude box needs internet.';
    return 'Something went wrong talking to Claude. Try again.' + (m ? ` (${m})` : '');
  }
  async function runAsk(ev) {
    ev.preventDefault();
    const input = $('ask-input');
    const msg = input.value.trim();
    if (!msg) return;
    if (!LS.get('hub.apiKey', '')) { openSettings(); toast('Add your Anthropic API key here to turn on the Claude box.'); return; }
    const go = $('ask-go');
    go.disabled = true; go.textContent = 'Thinking…';
    try {
      const out = await callClaude(msg);
      track('box.use');
      const res = changesToOps(out.changes, data.tasks, 'box');
      const inv = inverseOps(res.ops);
      commit(res.ops);
      lastUndo = inv.length ? inv : null;
      let reply = String(out.reply || '').trim() || (res.ops.length ? 'Updated.' : 'No changes.');
      if (res.skipped.length) reply += `\n(Skipped: ${res.skipped.join('; ')})`;
      showReply(reply, Boolean(lastUndo));
      if (res.ops.length) input.value = '';
    } catch (e) {
      track('box.error');
      trackProblem('Claude box: ' + claudeError(e));
      showReply(claudeError(e), false);
    } finally {
      go.disabled = false; go.textContent = 'Update';
    }
  }
  function showReply(text, undo) {
    $('ask-reply').textContent = text;
    $('undo-btn').hidden = !undo;
    $('ask-out').hidden = false;
  }

  // ---------- rendering ----------
  // Earthy, desaturated course colours that sit in the fog (sage, mist teal, clay, ochre, slate, rose, sand, moss…).
  const PALETTE = ['#b5c49a', '#8fbdb3', '#d49a7c', '#d3b46e', '#97abcb', '#c79aac', '#bfae8c', '#8fa86f', '#a9a3c9', '#9ec7cc'];
  function categories() {
    const s = new Set();
    data.tasks.forEach((t) => { if (t.category) s.add(t.category); });
    return [...s].sort((a, b) => a.localeCompare(b));
  }
  function colorMap() {
    const m = {};
    categories().forEach((c, i) => { m[c] = PALETTE[i % PALETTE.length]; });
    return m;
  }
  const byPriority = (a, b) => (PRI_RANK[a.priority] - PRI_RANK[b.priority]) || (a.due || '9999').localeCompare(b.due || '9999') || a.createdAt - b.createdAt;
  const byDue = (a, b) => (a.due || '').localeCompare(b.due || '') || byPriority(a, b);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function render() {
    const now = new Date();
    const h = now.getHours();
    $('greet').textContent = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    $('date-label').textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

    const cats = categories();
    if (filterCat !== 'all' && !cats.includes(filterCat)) filterCat = 'all';
    const colors = colorMap();
    const t = todayStr();
    const inFilter = (x) => filterCat === 'all' || x.category === filterCat;
    const open = data.tasks.filter((x) => !x.done && !expired(x) && inFilter(x));

    renderSidebar(cats, colors);
    renderChips(cats, colors);
    renderQuickWins(colors);
    const dl = $('cats'); dl.textContent = '';
    cats.forEach((c) => { const o = document.createElement('option'); o.value = c; dl.append(o); });

    if (view === 'dashboard') {
      renderSummary(open, t);
      renderWeek(open, t, colors);
      renderBars(colors);
      // Today's focus in three zones:
      //  1. Due today / tomorrow: real deadlines only (plus anything overdue).
      //  2. Working on: things you pinned, own targets (aims) that have arrived, issues.
      //  3. Heads-up: reminders and work shifts today, in one quiet line each.
      const tomorrow = addDays(t, 1);
      const isNotice = (x) => kindOf(x) === 'reminder' || isShift(x);
      const dueRank = (x) => (x.due < t ? 0 : x.due === t ? 1 : 2);
      const dueZone = open.filter((x) => !isNotice(x) && !isAim(x) && x.due && x.due <= tomorrow)
        .sort((a, b) => dueRank(a) - dueRank(b) || byPriority(a, b));
      const zoneIds = new Set(dueZone.map((x) => x.id));
      const workZone = open.filter((x) => !zoneIds.has(x.id) && !isNotice(x)
          && (x.focus || (isAim(x) && x.due && x.due <= t) || kindOf(x) === 'issue'))
        .sort((a, b) => Number(b.focus) - Number(a.focus) || (a.due || '9999').localeCompare(b.due || '9999') || byPriority(a, b));
      workZone.forEach((x) => zoneIds.add(x.id));
      const heads = open.filter((x) => isNotice(x) && x.due === t);
      fillZone('zone-due', 'focus-due', dueZone, colors);
      // Always show the deadline zone, so "nothing due" is a clear, reassuring answer.
      $('zone-due').hidden = false;
      $('due-head').hidden = !dueZone.length; // no red heading when there's nothing due
      if (!dueZone.length) $('focus-due').append(el('li', 'empty all-clear', 'Nothing due today or tomorrow ✓'));
      fillZone('zone-work', 'focus-work', workZone, colors);
      fillZone('zone-heads', 'focus-heads', heads, colors, true);
      $('focus-empty').hidden = dueZone.length + workZone.length + heads.length > 0;
      const mustMin = dueZone.reduce((a, x) => a + estMinutes(x), 0);
      const workMin = workZone.reduce((a, x) => a + estMinutes(x), 0);
      $('focus-sub').textContent = [mustMin ? `~${fmtMin(mustMin)} due` : '', workMin ? `~${fmtMin(workMin)} in progress` : ''].filter(Boolean).join(' · ');
      // Coming soon: high-priority deadlines 2–3 days out, as a preview for spare time.
      const upNext = open.filter((x) => !zoneIds.has(x.id) && !isNotice(x) && x.due && x.due > tomorrow
          && x.due <= addDays(t, 3) && (x.priority === 'high' || x.due === addDays(t, 2)))
        .sort(byDue).slice(0, 5);
      $('upnext').hidden = !upNext.length;
      const ul = $('upnext-list'); ul.textContent = '';
      upNext.forEach((x) => ul.append(row(x, colors, true)));
      renderSections(open.filter((x) => !zoneIds.has(x.id) && x.due && x.due > t && x.due <= addDays(t, 7)).sort(byDue), colors);
    } else if (view === 'tasks') {
      renderGroups(open, t, colors);
    } else {
      renderDone(colors, inFilter);
    }
  }

  function renderSidebar(cats, colors) {
    const ul = $('cat-list'); ul.textContent = '';
    const counts = {};
    data.tasks.forEach((x) => { if (!x.done && !expired(x)) counts[x.category || ''] = (counts[x.category || ''] || 0) + 1; });
    const mk = (key, label, color) => {
      const li = el('li'); const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filterCat === key));
      if (color) { const s = el('span', 'swatch'); s.style.background = color; b.append(s); }
      b.append(el('span', null, label));
      b.append(el('span', 'n', String(key === 'all' ? data.tasks.filter((x) => !x.done && !expired(x)).length : counts[key] || 0)));
      b.onclick = () => { filterCat = key; render(); };
      li.append(b); ul.append(li);
    };
    mk('all', 'All tasks', null);
    cats.forEach((c) => mk(c, c, colors[c]));
  }
  function renderChips(cats, colors) {
    const box = $('chips'); box.textContent = '';
    if (!cats.length) return;
    ['all', ...cats].forEach((c) => {
      const b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filterCat === c));
      if (c !== 'all') { const s = el('span', 'swatch'); s.style.background = colors[c]; b.append(s); }
      b.append(c === 'all' ? 'All' : c);
      b.onclick = () => { filterCat = c; render(); };
      box.append(b);
    });
  }
  // One slim line under the date instead of four big number tiles.
  function renderSummary(open, t) {
    const box = $('summary'); box.textContent = '';
    const work = open.filter((x) => kindOf(x) !== 'reminder' && !isShift(x));
    const overdue = work.filter(hardLate).length;
    const today = work.filter((x) => x.due === t).length;
    const weekMin = work.filter((x) => x.focus || (x.due && x.due <= addDays(t, 7))).reduce((a, x) => a + estMinutes(x), 0);
    const weekAgo = Date.now() - 7 * 864e5;
    const done = data.tasks.filter((x) => x.done && x.doneAt >= weekAgo && (filterCat === 'all' || x.category === filterCat)).length;
    const bits = [];
    if (overdue) bits.push(['late', `${overdue} overdue`]);
    bits.push(['', today ? `${today} due today` : 'nothing due today']);
    bits.push(['', `~${fmtMin(weekMin)} of work this week`]);
    if (done) bits.push(['good', `${done} done this week`]);
    bits.forEach(([cls, text]) => box.append(el('span', 'pill ' + cls, text)));
  }

  // Task kinds: a normal task (checkbox), a reminder (no checkbox, hides itself after its date),
  // or a progress task like a batch of lectures (a 2/9 counter instead of a checkbox).
  const RANGE = /\b(?:L|lectures?\s+|ch\.?\s*)?(\d{1,2})\s*[–-]\s*L?(\d{1,2})\b/gi;
  function autoTotal(x) {
    const s = x.title;
    if (!/lecture|recording|video|chapter|\bL\d/i.test(s)) return 0;
    const m = s.match(/\b(\d+)\s*(recordings|videos)\b/i);
    if (m) return Number(m[1]);
    let n = 0;
    s.replace(RANGE, (all, a, b) => { a = Number(a); b = Number(b); if (b > a && b - a < 30) n += b - a + 1; return ''; });
    const singles = s.replace(RANGE, '').match(/\blecture\s+\d{1,2}\b/gi);
    if (singles) n += singles.length;
    return n;
  }
  const totalOf = (x) => (x.total > 0 ? x.total : autoTotal(x));
  function kindOf(x) {
    if (x.kind) return x.kind;
    if (/info only|last day|\breminder\b/i.test(x.title)) return 'reminder';
    if (/\b(missing|missed)\b/i.test(x.title)) return 'issue';
    if (totalOf(x) > 1) return 'progress';
    return 'task';
  }
  const expired = (x) => kindOf(x) === 'reminder' && x.due && x.due < todayStr();
  // Due = a real deadline (turns red when missed). Aim = a target you set yourself (never nags).
  // Catch-ups, study/practice work and issues default to Aim; everything else to Due.
  function isAim(x) {
    if (x.dateKind) return x.dateKind === 'aim';
    const k = kindOf(x);
    return k === 'progress' || k === 'issue' || /catch[- ]?up|\bstudy\b|review|practice|reading/i.test(x.title);
  }
  const hardLate = (x) => !!x.due && x.due < todayStr() && !isAim(x) && kindOf(x) !== 'reminder';
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  // "~2 a day to finish by Mon" for progress tasks with an aim date.
  function pacing(x) {
    if (kindOf(x) !== 'progress' || !x.due) return '';
    const left = Math.max(0, totalOf(x) - x.prog);
    if (!left) return '';
    const t = todayStr();
    if (x.due < t) return `${left} left · pick a new aim day`;
    const days = daysBetween(t, x.due) + 1;
    const per = Math.ceil(left / days);
    const by = x.due === t ? 'today' : parse(x.due).toLocaleDateString(undefined, { weekday: 'short' });
    return days === 1 ? `${left} left today` : `~${per} a day to finish by ${by}`;
  }

  // Time estimates: the task's own "est" (minutes) when set, otherwise a guess from its title.
  function estMinutes(x) {
    const kind = kindOf(x);
    if (kind === 'reminder') return 0;
    if (kind === 'progress') {
      const total = totalOf(x); const left = Math.max(0, total - x.prog);
      return x.est > 0 ? Math.round((x.est * left) / Math.max(1, total)) : left * 60;
    }
    if (x.est > 0) return x.est;
    const s = x.title.toLowerCase();
    if (isShift(x)) return 0;
    if (/info only/.test(s)) return 5;
    if (/\b(final exam|exam|term test|midterm)\b/.test(s) && !/viewing|conflict/.test(s)) return 300;
    const rec = s.match(/(\d+)\s*(recordings|lectures|videos)/);
    if (rec) return Number(rec[1]) * 60;
    if (/catch[- ]?up|lectures?\b/.test(s)) return 120;
    if (/quizzes/.test(s)) return 90;
    if (/quiz/.test(s)) return 30;
    if (/reflection|tracker|feedback|form|orientation|viewing|registration/.test(s)) return 20;
    if (/homework|\bhw\b|stemble|achieve|mindtap|data sheet/.test(s)) return 60;
    if (/\blab\b|lab #?\d/.test(s) && /assignment|report/.test(s)) return 120;
    if (/\blab\b|lab #?\d/.test(s)) return 180;
    if (/assignment|podcast|submission|essay|report|phase|create/.test(s)) return 120;
    return 60;
  }
  const fmtMin = (m) => (m >= 60 ? `${Math.round(m / 30) / 2}h` : `${m}m`);

  // Work shifts are Personal tasks with "shift" in the title; the week strip shows them as badges.
  const isShift = (x) => /\bshifts?\b/i.test(x.title) && String(x.category || '').toLowerCase() === 'personal';
  function shiftLabel(x) {
    const m = x.title.match(/\d{1,2}(:\d\d)?\s*(am|pm)?\s*[–-]\s*\d{1,2}(:\d\d)?\s*(am|pm)?/i);
    return 'Shift' + (m ? ' ' + m[0].replace(/\s+/g, ' ') : '');
  }
  function renderWeek(open, t, colors) {
    const box = $('week-strip'); box.textContent = '';
    // One dot per task (course colour; ringed = high priority), amber strip = work shift. Hover a day for titles.
    $('week-sub').textContent = 'hover a day for details';
    const days = Array.from({ length: 7 }, (_, i) => addDays(t, i));
    const per = days.map((d) => open.filter((x) => x.due === d && kindOf(x) !== 'reminder'));
    days.forEach((d, i) => {
      const shifts = per[i].filter(isShift);
      const work = per[i].filter((x) => !isShift(x)).sort(byPriority);
      const date = parse(d);
      const col = el('div', 'day' + (i === 0 ? ' today' : '') + (work.length ? '' : ' free') + (work.length >= 3 ? ' busy' : ''));
      const dow = i === 0 ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short' });
      col.title = `${dow} ${date.getDate()}` + (work.length ? '\n' + work.map((x) => `• ${x.title}${x.category ? ` (${x.category})` : ''}`).join('\n') : '\nNothing due')
        + (shifts.length ? '\n' + shifts.map((s) => `⏱ ${s.title}`).join('\n') : '');
      col.append(el('span', 'dow', dow), el('span', 'dnum', String(date.getDate())));
      const dots = el('div', 'dots');
      work.forEach((x) => {
        const dot = el('i', 'dot' + (x.priority === 'high' ? ' hi' : ''));
        dot.style.setProperty('--c', colors[x.category] || 'var(--muted)');
        dots.append(dot);
      });
      col.append(dots);
      if (shifts.length) col.append(el('span', 'shift-strip', shiftLabel(shifts[0]).replace('Shift ', '')));
      box.append(col);
    });
  }

  const sectionOf = (c) => { c = String(c || '').toLowerCase(); return c === 'personal' ? 'Personal' : c === 'admin' ? 'Admin' : 'Courses'; };
  function renderSections(items, colors) {
    // One glass panel each: Courses (grouped by course), Personal, Admin.
    const courses = items.filter((x) => sectionOf(x.category) === 'Courses');
    const box = $('soon-courses'); box.textContent = '';
    if (!courses.length) box.append(el('p', 'empty', 'No course work due in the next week.'));
    const byCourse = {};
    courses.forEach((x) => { (byCourse[x.category || 'Other'] = byCourse[x.category || 'Other'] || []).push(x); });
    Object.keys(byCourse).sort().forEach((c) => {
      const sec = el('section', 'sec');
      const lab = el('div', 'course-label'); const s = el('i', 'swatch'); s.style.background = colors[c] || 'var(--muted)';
      lab.append(s, c, el('span', 'n', String(byCourse[c].length)));
      const ul = el('ul', 'tasks compact');
      byCourse[c].forEach((x) => ul.append(row(x, colors, true)));
      sec.append(lab, ul);
      box.append(sec);
    });
    for (const [name, id] of [['Personal', 'soon-personal'], ['Admin', 'soon-admin']]) {
      const ul = $(id); ul.textContent = '';
      const list = items.filter((x) => sectionOf(x.category) === name);
      if (!list.length) ul.append(el('li', 'empty', `Nothing ${name.toLowerCase()} in the next week.`));
      list.forEach((x) => ul.append(row(x, colors, true)));
    }
  }

  function renderBars(colors) {
    const box = $('course-bars'); box.textContent = '';
    // Estimated hours per course: due within 7 days (incl. overdue and today's focus) vs later.
    const t = todayStr(); const wk = addDays(t, 7);
    const soon = (x) => x.focus || (x.due && x.due <= wk);
    const rows = categories().map((c) => {
      const open = data.tasks.filter((x) => !x.done && x.category === c && !isShift(x) && kindOf(x) !== 'reminder');
      const week = open.filter(soon);
      const weekMin = week.reduce((a, x) => a + estMinutes(x), 0);
      const laterMin = open.filter((x) => !soon(x)).reduce((a, x) => a + estMinutes(x), 0);
      const next = open.filter((x) => x.due && x.due >= t).sort(byDue)[0];
      const late = open.filter(hardLate).length;
      return { c, weekMin, laterMin, hi: week.filter((x) => x.priority === 'high').length, next, late, n: open.length };
    }).filter((r) => r.n).sort((a, b) => b.weekMin - a.weekMin || b.laterMin - a.laterMin);
    const total = rows.reduce((a, r) => a + r.weekMin, 0);
    $('course-sub').textContent = rows.length ? `hours this week · faded = later` : '';
    if (!rows.length) { box.append(el('p', 'empty', 'No open tasks.')); return; }
    const mx = Math.max(...rows.map((r) => r.weekMin + r.laterMin), 1);
    for (const r of rows) {
      const b = el('button', 'bar-row');
      b.type = 'button';
      if (filterCat !== 'all' && filterCat !== r.c) b.style.opacity = '.45';
      const name = el('div', 'name'); const sw = el('i', 'swatch'); sw.style.background = colors[r.c];
      name.append(sw, el('span', null, r.c));
      if (r.late) name.append(el('i', 'late-dot'));
      const count = el('div', 'count' + (r.weekMin ? ' strong' : ''), r.weekMin ? `~${fmtMin(r.weekMin)}` : '–');
      const track = el('div', 'track');
      if (r.weekMin) { const f = el('div', 'fill hi'); f.style.width = (r.weekMin / mx) * 100 + '%'; f.style.background = colors[r.c]; track.append(f); }
      if (r.laterMin) { const f = el('div', 'fill rest'); f.style.width = (r.laterMin / mx) * 100 + '%'; f.style.background = colors[r.c]; track.append(f); }
      const bits = [];
      if (r.late) bits.push(`${r.late} overdue`);
      if (r.hi) bits.push(`${r.hi} high`);
      if (r.next) bits.push(`next: ${r.next.due === t ? 'today' : parse(r.next.due).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}`);
      if (r.laterMin) bits.push(`~${fmtMin(r.laterMin)} later`);
      b.title = `${r.c}: ~${fmtMin(r.weekMin)} this week${bits.length ? ' · ' + bits.join(' · ') : ''}\n(Estimates; set exact times by editing a task. Click to filter.)`;
      b.append(name, count, track);
      b.onclick = () => { filterCat = filterCat === r.c ? 'all' : r.c; render(); };
      box.append(b);
    }
  }

  // Quick wins: short tasks whose deadline is still more than a week away.
  // Once a deadline is within 7 days the task shows in Coming up instead, then in Today's focus.
  function quickWins(t) {
    return data.tasks.filter((x) => !x.done && !x.focus && !isShift(x) && kindOf(x) !== 'reminder' && x.due && x.due > addDays(t, 7)
      && estMinutes(x) <= 60 && !/info only/i.test(x.title)
      && (filterCat === 'all' || x.category === filterCat)).sort(byDue);
  }
  function renderQuickWins(colors) {
    const t = todayStr();
    const items = quickWins(t);
    for (const id of ['quick-side', 'quick-mobile']) {
      const ul = $(id); if (!ul) continue;
      ul.textContent = '';
      if (!items.length) { ul.append(el('li', 'empty', 'No quick tasks with far-off deadlines right now.')); continue; }
      items.slice(0, 12).forEach((x) => {
        const li = el('li', 'qw');
        const cb = el('input', 'check'); cb.type = 'checkbox';
        cb.setAttribute('aria-label', 'Mark done: ' + x.title);
        cb.onchange = () => commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
        const body = el('div', 'qw-body');
        body.append(el('div', 'qw-title', x.title));
        const meta = el('div', 'qw-meta');
        const s = el('i', 'swatch'); s.style.background = colors[x.category] || 'var(--muted)';
        meta.append(s, `${parse(x.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ~${fmtMin(estMinutes(x))}`);
        body.append(meta);
        const pin = el('button', 'pin', '☆'); pin.type = 'button';
        pin.title = 'Work on this today'; pin.setAttribute('aria-label', 'Work on this today: ' + x.title);
        pin.onclick = () => { track('quickwin.pin'); commit([{ type: 'patch', id: x.id, fields: { focus: true } }]); };
        li.append(cb, body, pin);
        ul.append(li);
      });
    }
  }

  function fillZone(zoneId, listId, items, colors, compact) {
    const zone = $(zoneId); const ul = $(listId);
    ul.textContent = '';
    zone.hidden = !items.length;
    items.forEach((x) => ul.append(row(x, colors, compact)));
  }
  function fillList(ul, items, colors, emptyText) {
    ul.textContent = '';
    if (!items.length) { ul.append(el('li', 'empty', emptyText)); return; }
    items.forEach((x) => ul.append(row(x, colors)));
  }

  function renderGroups(open, t, colors) {
    const box = $('task-groups'); box.textContent = '';
    const wk = addDays(t, 7);
    const groups = [
      ['overdue', 'Overdue', open.filter((x) => x.due && x.due < t).sort(byDue)],
      ['today', 'Today', open.filter((x) => x.due === t).sort(byPriority)],
      ['week', 'This week', open.filter((x) => x.due && x.due > t && x.due <= wk).sort(byDue)],
      ['later', 'Later', open.filter((x) => x.due && x.due > wk).sort(byDue)],
      ['someday', 'No date', open.filter((x) => !x.due).sort(byPriority)],
    ];
    let any = false;
    for (const [key, title, items] of groups) {
      if (!items.length) continue;
      any = true;
      const sec = el('section', 'group ' + key);
      const head = el('div', 'group-title'); head.append(el('h2', null, title), el('span', 'n', String(items.length)));
      const card = el('div', 'card'); const ul = el('ul', 'tasks');
      items.forEach((x) => ul.append(row(x, colors)));
      card.append(ul); sec.append(head, card); box.append(sec);
    }
    if (!any) {
      const e = el('div', 'card empty');
      e.append(el('strong', null, filterCat === 'all' ? 'Your list is empty.' : `Nothing open in ${filterCat}.`));
      e.append('Add a task above, or load your starter tasks from Settings.');
      box.append(e);
    }
  }

  function renderDone(colors, inFilter) {
    const box = $('done-list'); box.textContent = '';
    const done = data.tasks.filter((x) => x.done && inFilter(x)).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    $('done-sub').textContent = `${done.length} task${done.length === 1 ? '' : 's'}`;
    if (!done.length) { box.append(el('p', 'empty', 'Finished tasks show up here, grouped by the day you finished them.')); return; }
    let last = null; let ul = null;
    done.slice(0, 300).forEach((x) => {
      const day = x.doneAt ? fmt(new Date(x.doneAt)) : '';
      if (day !== last) { last = day; box.append(el('p', 'day-label', day ? dueLabel(day) : 'Earlier')); ul = el('ul', 'tasks'); box.append(ul); }
      ul.append(row(x, colors));
    });
  }

  function row(x, colors, compact) {
    const kind = kindOf(x);
    const total = totalOf(x);
    const li = el('li', 'task' + (x.done ? ' done' : '') + (compact ? ' compact' : '') + (kind === 'reminder' ? ' reminder' : '')
      + (x.priority === 'high' ? ' hi' : x.priority === 'low' ? ' lo' : '') + (x.focus ? ' pinned' : ''));
    let cb;
    if (kind === 'reminder' && !x.done) {
      cb = el('span', 'bell');
      cb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
      cb.title = 'Reminder: it goes away by itself after its date';
    } else if (kind === 'issue' && !x.done) {
      cb = el('span', 'issue-ic', '!');
      cb.title = 'Missed or missing: resolve it instead of ticking it off';
    } else if (kind === 'progress' && !x.done) {
      // − 3/9 +  ; at the total the + becomes ✓, so finishing is always a deliberate tap.
      cb = el('div', 'prog-ctl');
      const minus = el('button', 'pc-btn', '−'); minus.type = 'button';
      minus.disabled = x.prog <= 0;
      minus.setAttribute('aria-label', 'One less done: ' + x.title);
      minus.onclick = () => { track('progress.minus'); commit([{ type: 'patch', id: x.id, fields: { prog: Math.max(0, x.prog - 1) } }]); };
      const count = el('span', 'pc-count', `${Math.min(x.prog, total)}/${total}`);
      const full = x.prog >= total;
      const plus = el('button', 'pc-btn' + (full ? ' finish' : ''), full ? '✓' : '+'); plus.type = 'button';
      plus.setAttribute('aria-label', (full ? 'Finish: ' : 'One more done: ') + x.title);
      plus.title = full ? 'All parts done: tap to finish' : 'One more done';
      plus.onclick = () => {
        track(full ? 'progress.finish' : 'progress.plus');
        if (full) {
          commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
          toast(`Finished “${x.title}”`, 6000, [{ type: 'patch', id: x.id, fields: { done: false, doneAt: null } }]);
        } else commit([{ type: 'patch', id: x.id, fields: { prog: x.prog + 1 } }]);
      };
      cb.append(minus, count, plus);
    } else {
      cb = el('input', 'check');
      cb.type = 'checkbox'; cb.checked = x.done;
      cb.setAttribute('aria-label', (x.done ? 'Mark not done: ' : 'Mark done: ') + x.title);
      cb.onchange = () => {
        if (x.done) { commit([{ type: 'patch', id: x.id, fields: { done: false, doneAt: null } }]); return; }
        commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
        toast(`Done: “${x.title}”`, 5000, [{ type: 'patch', id: x.id, fields: { done: false, doneAt: null } }]);
      };
    }
    const body = el('div', 'task-body');
    const title = el('button', 'task-title', x.title);
    title.type = 'button'; title.title = 'Edit';
    title.onclick = () => { editing = editing === x.id ? null : x.id; render(); const f = document.getElementById('edit-title'); if (f) f.focus(); };
    body.append(title);
    if (editing === x.id) body.append(editor(x));
    else {
      const meta = el('div', 'meta');
      if (x.due) {
        const t = todayStr();
        const aim = isAim(x) && kind !== 'reminder';
        const short = compact && x.due > addDays(t, 1);
        let label = short ? parse(x.due).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) : dueLabel(x.due);
        let cls = 'due';
        if (kind === 'reminder') {
          label = x.due === t ? 'today' : label;
        } else if (aim) {
          // Own targets: soft wording, never red.
          cls += ' aim';
          label = x.done ? label : x.due < t ? 'aim passed' : `aim: ${x.due === t ? 'today' : short ? label : parse(x.due).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}`;
        } else if (!x.done) {
          if (x.due < t) { cls += ' late'; label = `overdue · ${label}`; }
          else if (x.due === t) { cls += ' today'; label = 'due today'; }
          else if (x.due === addDays(t, 1)) { cls += ' soon'; label = 'due tomorrow'; }
        }
        meta.append(el('span', cls, label));
      }
      if (x.category && !compact) { const c = el('span', 'cat'); const s = el('i', 'swatch'); s.style.background = colors[x.category]; c.append(s, x.category); meta.append(c); }
      // Priority is shown by a pink dot before the title (high) or dimmer text (low), not pills.
      if (kind === 'progress' && !x.done && !compact) meta.append(el('span', 'est', pacing(x) || `~${fmtMin(estMinutes(x))} left`));
      if (meta.childNodes.length) body.append(meta);
      if (kind === 'progress' && !x.done && total) {
        const bar = el('div', 'prog-bar'); const fill = el('i');
        fill.style.width = (Math.min(x.prog, total) / total) * 100 + '%';
        bar.append(fill); body.append(bar);
      }
      if (x.note && (x.done || kind === 'issue')) body.append(el('div', 'note-line', (x.done && kind === 'issue' ? 'Resolved: ' : 'Note: ') + x.note));
      if (resolving === x.id) body.append(resolveBox(x));
    }
    li.append(cb, body);
    if (kind === 'issue' && !x.done && resolving !== x.id) {
      const rb = el('button', 'resolve-btn', 'Resolve'); rb.type = 'button';
      rb.setAttribute('aria-label', 'Resolve: ' + x.title);
      rb.onclick = () => { resolving = x.id; render(); const n = document.getElementById('resolve-note'); if (n) n.focus(); };
      li.append(rb);
    }
    if (kind === 'reminder' && !x.done) {
      const dis = el('button', 'pin', '✕'); dis.type = 'button';
      dis.title = 'Dismiss reminder'; dis.setAttribute('aria-label', 'Dismiss reminder: ' + x.title);
      dis.onclick = () => commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
      li.append(dis);
    } else if (!x.done) {
      const pin = el('button', 'pin' + (x.focus ? ' on' : ''), x.focus ? '★' : '☆');
      pin.type = 'button';
      pin.title = x.focus ? 'Remove from Today’s focus' : 'Work on this today';
      pin.setAttribute('aria-label', pin.title + ': ' + x.title);
      pin.setAttribute('aria-pressed', String(x.focus));
      pin.onclick = () => { track(x.focus ? 'pin.remove' : 'pin.add'); commit([{ type: 'patch', id: x.id, fields: { focus: !x.focus } }]); };
      li.append(pin);
    }
    return li;
  }

  function resolveBox(x) {
    const f = el('form', 'resolve');
    const ta = el('textarea'); ta.id = 'resolve-note'; ta.rows = 2; ta.value = x.note;
    ta.placeholder = 'What happened? (optional) e.g. got the notes from a friend, still need to review them';
    ta.setAttribute('aria-label', 'Resolution note');
    const row2 = el('div', 'actions');
    const ok = el('button', 'btn grad sm', 'Mark resolved'); ok.type = 'submit';
    const cancel = el('button', 'btn sm', 'Cancel'); cancel.type = 'button';
    row2.append(ok, cancel);
    f.append(ta, row2);
    f.onsubmit = (e) => {
      e.preventDefault();
      resolving = null;
      track('issue.resolve');
      commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now(), focus: false, note: ta.value.trim().slice(0, 1000) } }]);
      toast('Resolved. Claude can see your note next time it reads your list.');
    };
    cancel.onclick = () => { resolving = null; render(); };
    return f;
  }

  function editor(x) {
    const f = el('form', 'editor');
    const ti = el('input', 'full'); ti.id = 'edit-title'; ti.value = x.title; ti.required = true; ti.setAttribute('aria-label', 'Task title');
    const du = el('input'); du.type = 'date'; du.id = 'edit-due'; du.value = x.due || ''; du.setAttribute('aria-label', 'Due date');
    const ca = el('input'); ca.id = 'edit-cat'; ca.value = x.category; ca.placeholder = 'Category'; ca.setAttribute('list', 'cats'); ca.setAttribute('aria-label', 'Category');
    const pr = el('select'); pr.id = 'edit-pri'; pr.setAttribute('aria-label', 'Priority');
    [['high', 'High'], ['med', 'Medium'], ['low', 'Low']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; pr.append(o); });
    pr.value = x.priority;
    const auto = { ...x, kind: '', total: 0, est: 0 };
    const ki = el('select'); ki.id = 'edit-kind'; ki.setAttribute('aria-label', 'Type');
    const kindNames = { task: 'Task (checkbox)', reminder: 'Reminder', progress: 'Progress (parts)', issue: 'Issue (resolve)' };
    [['', `Type: auto (${kindNames[kindOf(auto)]})`], ...Object.entries(kindNames)].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; ki.append(o); });
    ki.value = x.kind;
    const es = el('select'); es.id = 'edit-est'; es.setAttribute('aria-label', 'Time needed');
    [[0, `Time: auto (~${fmtMin(estMinutes(auto))})`], ...[15, 30, 45, 60, 90, 120, 180, 240, 300, 480, 600].map((m) => [m, `Time: ${fmtMin(m)}`])]
      .forEach(([v, l]) => { const o = el('option', null, l); o.value = String(v); es.append(o); });
    es.value = String(x.est || 0);
    const to = el('input'); to.type = 'number'; to.min = '0'; to.id = 'edit-total'; to.value = x.total || '';
    to.placeholder = `Parts (auto: ${autoTotal(x) || 'none'})`; to.setAttribute('aria-label', 'Number of parts');
    const pg = el('input'); pg.type = 'number'; pg.min = '0'; pg.id = 'edit-prog'; pg.value = x.prog || '';
    pg.placeholder = 'Parts done'; pg.setAttribute('aria-label', 'Parts done so far');
    const dk = el('select'); dk.id = 'edit-datekind'; dk.setAttribute('aria-label', 'Kind of date');
    [['', `Date: auto (${isAim({ ...x, dateKind: '' }) ? 'aim' : 'due'})`], ['due', 'Date: real deadline (due)'], ['aim', 'Date: my own target (aim)']]
      .forEach(([v, l]) => { const o = el('option', null, l); o.value = v; dk.append(o); });
    dk.value = x.dateKind;
    const no = el('input', 'full'); no.id = 'edit-note'; no.value = x.note; no.placeholder = 'Note for you and Claude (optional)'; no.setAttribute('aria-label', 'Note');
    const actions = el('div', 'actions');
    const save = el('button', 'btn grad sm', 'Save'); save.type = 'submit';
    const cancel = el('button', 'btn sm', 'Cancel'); cancel.type = 'button';
    const del = el('button', 'btn sm danger', 'Delete'); del.type = 'button';
    actions.append(save, cancel, el('span', 'spacer'), del);
    f.append(ti, du, dk, ca, pr, ki, es, to, pg, no, actions);
    f.onsubmit = (e) => {
      e.preventDefault();
      const title = ti.value.trim(); if (!title) return;
      editing = null;
      commit([{ type: 'patch', id: x.id, fields: {
        title: title.slice(0, 300), due: du.value || null, category: cleanCat(ca.value), priority: normPri(pr.value),
        kind: ki.value, dateKind: dk.value, est: Number(es.value) || 0, total: Math.max(0, Number(to.value) || 0), prog: Math.max(0, Number(pg.value) || 0),
        note: no.value.trim().slice(0, 1000),
      } }]);
    };
    cancel.onclick = () => { editing = null; render(); };
    del.onclick = () => {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Tap again to delete'; return; }
      editing = null;
      commit([{ type: 'delete', id: x.id }]);
    };
    return f;
  }

  // ---------- views ----------
  function setView() {
    const h = location.hash.replace('#', '');
    view = ['dashboard', 'tasks', 'done'].includes(h) ? h : 'dashboard';
    track('view.' + view);
    ['dashboard', 'tasks', 'done'].forEach((v) => { $('view-' + v).hidden = v !== view; });
    document.querySelectorAll('[data-view]').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    editing = null;
    resolving = null;
    render();
  }

  // ---------- toast / banner ----------
  let toastTimer = null;
  // A short message at the bottom; pass undoOps to show an Undo button that applies them.
  function toast(msg, ms = 4000, undoOps) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    if (undoOps && undoOps.length) {
      const u = el('button', 'toast-undo', 'Undo'); u.type = 'button';
      u.onclick = () => { track('undo'); commit(undoOps); t.hidden = true; };
      t.append(u);
    }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = false; }

  // ---------- settings ----------
  function openSettings() {
    $('api-key').value = LS.get('hub.apiKey', '');
    $('api-model').value = LS.get('hub.model', 'claude-haiku-5-5');
    $('api-saved').textContent = '';
    if (DRIVE_MODE) {
      $('drive-connect').hidden = false;
      $('drive-connect').textContent = tokenValid() ? 'Sync now' : 'Connect Google Drive';
      $('drive-disconnect').hidden = !tokenValid();
      $('drive-status').textContent = tokenValid() ? 'Connected to Google Drive.' : 'Not connected right now.';
    } else {
      $('drive-connect').hidden = true; $('drive-disconnect').hidden = true;
      $('drive-status').textContent = 'Google Drive isn’t set up yet (see SETUP.md). For now your tasks are saved on this device only.';
    }
    const dlg = $('settings');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }
  function importTasks(list) {
    const incoming = (Array.isArray(list) ? list : (list && list.tasks) || []).map(normalizeTask).filter(Boolean);
    const have = new Set(data.tasks.map((t) => t.id));
    const ops = incoming.filter((t) => !have.has(t.id)).map((task) => ({ type: 'add', task }));
    commit(ops);
    toast(ops.length ? `Imported ${ops.length} task${ops.length === 1 ? '' : 's'}.` : 'Nothing new to import.');
  }

  // ---------- feedback log & report ----------
  const FB_LABEL = { look: 'Looks', feature: 'How it works', issue: 'Problems', idea: 'Ideas' };
  const SRC_LABEL = { app: 'you', box: 'Claude box', chat: 'Claude chat' };
  const shortDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  function renderFeedbackList() {
    const ul = $('fb-list'); ul.textContent = '';
    $('fb-count').textContent = data.feedback.length ? `${data.feedback.length} logged` : '';
    if (!data.feedback.length) { ul.append(el('li', 'empty', 'Nothing logged yet.')); return; }
    [...data.feedback].reverse().slice(0, 30).forEach((f) => {
      const li = el('li', 'fb-item');
      li.append(el('span', 'fb-tag ' + f.type, FB_LABEL[f.type]), el('span', 'fb-text', f.text), el('span', 'fb-meta', `${shortDate(f.at)} · ${SRC_LABEL[f.source]}`));
      ul.append(li);
    });
  }
  function openFeedback() {
    if ($('settings').open) $('settings').close();
    renderFeedbackList();
    $('fb-out').hidden = true; $('fb-copy').hidden = true; $('fb-clear').hidden = true;
    const dlg = $('feedback');
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    $('fb-text').focus();
  }
  function buildReport() {
    const s = stats(); const c = s.counts; const t = todayStr();
    const lines = [];
    const phone = window.matchMedia('(max-width: 860px)').matches;
    lines.push('# To-Do Hub feedback report');
    lines.push(`Made ${new Date().toLocaleString()} · app ${APP_VERSION} · ${phone ? 'phone' : 'desktop'} ${innerWidth}×${innerHeight} · ${navigator.userAgent.match(/(Chrome|Safari|Firefox|Edg)\/[\d.]+/)?.[0] || 'browser'}`);
    lines.push('');
    lines.push(`## Feedback (${data.feedback.length})`);
    if (!data.feedback.length) lines.push('- none logged');
    for (const type of FB_TYPES) {
      const list = data.feedback.filter((f) => f.type === type);
      if (!list.length) continue;
      lines.push(`### ${FB_LABEL[type]}`);
      list.forEach((f) => lines.push(`- ${f.text}  _(${shortDate(f.at)}, from ${SRC_LABEL[f.source]})_`));
    }
    lines.push('');
    lines.push(`## Problems the app noticed on this device`);
    if (!s.problems.length) lines.push('- none');
    s.problems.slice(-15).forEach((p) => lines.push(`- ${p.msg}${p.times > 1 ? ` (×${p.times})` : ''}, last ${new Date(p.at).toLocaleString()}`));
    lines.push('');
    lines.push(`## How the app gets used on this device (since ${shortDate(s.since)})`);
    const n = (k) => c[k] || 0;
    lines.push(`- Views: dashboard ${n('view.dashboard')}, tasks ${n('view.tasks')}, done ${n('view.done')}`);
    lines.push(`- Pins to Today's focus: ${n('pin.add')} (from Quick wins: ${n('quickwin.pin')}), unpins ${n('pin.remove')}`);
    lines.push(`- Lecture counters: +${n('progress.plus')} / −${n('progress.minus')}, finished ${n('progress.finish')}`);
    lines.push(`- Issues resolved: ${n('issue.resolve')} · Undo used: ${n('undo')}`);
    lines.push(`- Claude box: ${n('box.use')} updates, ${n('box.error')} errors · Claude chat notes applied: ${n('notes.applied')}`);
    lines.push(`- Rain effect: ${LS.get('hub.rain', true) === false ? 'off' : 'on'} · Claude box set up: ${LS.get('hub.apiKey', '') ? 'yes' : 'no'}`);
    lines.push('');
    const open = data.tasks.filter((x) => !x.done && !expired(x));
    const kinds = {}; open.forEach((x) => { const k = kindOf(x); kinds[k] = (kinds[k] || 0) + 1; });
    const manual = data.tasks.filter((x) => x.est > 0).length;
    lines.push('## List snapshot');
    lines.push(`- Open: ${open.length} (${Object.entries(kinds).map(([k, v]) => `${v} ${k}`).join(', ')}) · overdue ${open.filter((x) => x.due && x.due < t && kindOf(x) !== 'reminder').length} · pinned ${open.filter((x) => x.focus).length}`);
    lines.push(`- Done total: ${data.tasks.filter((x) => x.done).length} · tasks with a time set by hand: ${manual}`);
    lines.push(`- Categories: ${categories().join(', ')}`);
    return lines.join('\n');
  }

  // ---------- wire up ----------
  $('feedback-btn').onclick = openFeedback;
  $('feedback-open').onclick = openFeedback;
  $('fb-add').onclick = () => {
    const text = $('fb-text').value.trim();
    if (!text) return;
    const type = (document.querySelector('input[name="fb-type"]:checked') || {}).value || 'idea';
    commit([{ type: 'fb', entry: { id: newId(), at: Date.now(), type, source: 'app', text } }]);
    $('fb-text').value = '';
    renderFeedbackList();
  };
  $('fb-report').onclick = () => {
    const out = $('fb-out');
    out.value = buildReport(); out.hidden = false;
    $('fb-copy').hidden = false; $('fb-clear').hidden = !data.feedback.length;
  };
  $('fb-copy').onclick = async () => {
    const out = $('fb-out');
    try { await navigator.clipboard.writeText(out.value); toast('Report copied. Paste it to Claude Code.'); }
    catch { out.focus(); out.select(); toast('Press Ctrl+C (or long-press → Copy) to copy the selected report.'); }
  };
  $('fb-clear').onclick = () => {
    const btn = $('fb-clear');
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Tap again: clear after sending'; return; }
    btn.dataset.armed = ''; btn.textContent = 'Clear logged feedback';
    commit([{ type: 'fb-clear', ids: data.feedback.map((f) => f.id) }]);
    const s = stats(); s.problems = []; LS.set('hub.stats', s);
    renderFeedbackList(); btn.hidden = true;
    toast('Feedback list cleared.');
  };
  $('ask').addEventListener('submit', runAsk);
  $('ask-close').onclick = () => { $('ask-out').hidden = true; };
  $('undo-btn').onclick = () => {
    if (!lastUndo) return;
    commit(lastUndo); lastUndo = null;
    $('undo-btn').hidden = true; $('ask-reply').textContent = 'Undone.';
  };
  $('add').addEventListener('submit', (e) => {
    e.preventDefault();
    const task = newTask({ title: $('add-title').value, due: $('add-due').value, category: $('add-cat').value, priority: $('add-pri').value });
    if (!task) return;
    commit([{ type: 'add', task }]);
    $('add-title').value = ''; $('add-due').value = '';
    $('add-title').focus();
  });
  $('sync-btn').onclick = () => { if (!DRIVE_MODE) openSettings(); else if (!tokenValid()) connect(); else sync(); };
  $('settings-btn').onclick = openSettings;
  $('tab-settings').onclick = openSettings;
  $('drive-connect').onclick = () => { if (tokenValid()) sync(); else connect(); $('settings').close(); };
  $('drive-disconnect').onclick = () => {
    try { if (token && window.google) google.accounts.oauth2.revoke(token.access_token, () => {}); } catch { /* ignore */ }
    token = null; LS.del('hub.gtoken'); LS.del('hub.gconsent'); LS.del('hub.fileId');
    setSync('warn', 'Tap to connect Drive');
    $('settings').close();
  };
  $('api-save').onclick = () => {
    LS.set('hub.apiKey', $('api-key').value.trim());
    LS.set('hub.model', $('api-model').value);
    $('api-saved').textContent = 'Saved on this device.';
  };
  $('import-seed').onclick = async () => {
    try { importTasks(await (await fetch('seed-tasks.json', { cache: 'no-store' })).json()); }
    catch { toast('Couldn’t load the starter tasks file.'); }
  };
  $('import-file').onchange = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const j = lenientJson(await file.text());
    if (!j) { toast('That file isn’t valid task JSON.'); return; }
    importTasks(j);
    e.target.value = '';
  };
  $('export-btn').onclick = () => {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `todo-hub-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  window.addEventListener('hashchange', setView);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); sync(); } });
  setInterval(() => { if (document.visibilityState === 'visible' && tokenValid()) sync(); }, 60000);
  setInterval(updateSyncAge, 30000);
  setInterval(() => { if (!editing) render(); }, 30 * 60000); // date rollover

  track(window.matchMedia('(max-width: 860px)').matches ? 'open.phone' : 'open.desktop');
  setView();
  if (DRIVE_MODE) {
    if (tokenValid()) sync();
    else setSync('warn', LS.get('hub.gconsent', false) ? 'Tap to reconnect Drive' : 'Tap to connect Drive');
  } else {
    setSync('warn', 'Saved on this device only');
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
