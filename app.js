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
    // One format everywhere: "Thu 26" within a week either way, otherwise "Dec 2".
    const d = parse(due);
    const diff = Math.round((d - parse(t)) / 864e5);
    if (Math.abs(diff) <= 6) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`;
    const o = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) o.year = 'numeric';
    return d.toLocaleDateString(undefined, o);
  }

  // ---------- state ----------
  const APP_VERSION = 'hub-v30';
  const emptyData = () => ({ app: 'todo-hub', version: 1, updatedAt: 0, tasks: [], processedNotes: [], feedback: [], log: [] });
  // Shared notes: short dated lines both Claudes (and the user) add so the other one has the context.
  const LOG_MAX = 60;
  const LOG_SOURCES = ['app', 'box', 'chat'];
  function normalizeLog(e) {
    if (!e || typeof e !== 'object') return null;
    const text = String(e.text || '').trim().replace(/\s+/g, ' ').slice(0, 400);
    if (!text) return null;
    const at = Number(e.at) || Date.now();
    return { id: String(e.id || newId()), at, text, source: LOG_SOURCES.includes(e.source) ? e.source : 'chat' };
  }
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
  let handling = null;  // id of the missed deadline whose "Handle" box is open
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
      kind: ['task', 'reminder', 'progress', 'issue', 'shift', 'class'].includes(t.kind) ? t.kind : '', // '' = guess from the title
      off: Boolean(t.off), // shifts: not working that day (requested off, cancelled)
      skipped: Boolean(t.done && t.skipped), // cleared without doing it: not counted as "done"
      repeat: t.repeat === 'weekly' ? 'weekly' : '', // recurring: next one appears when this one is done / its day passes
      nextMade: Boolean(t.nextMade),
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
      log: Array.isArray(d.log) ? d.log.map(normalizeLog).filter(Boolean).slice(-LOG_MAX) : [],
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
    } else if (op.type === 'log') {
      const e = normalizeLog(op.entry);
      if (!Array.isArray(d.log)) d.log = [];
      if (e && !d.log.some((x) => x.id === e.id)) { d.log.push(e); d.log.sort((a, b) => a.at - b.at); d.log = d.log.slice(-LOG_MAX); }
    } else if (op.type === 'log-del') {
      const ids = new Set(op.ids || []);
      d.log = (d.log || []).filter((x) => !ids.has(x.id));
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
      if (action === 'log' || action === 'remember') {
        const e = normalizeLog({ text: c.text || c.note || c.title, source });
        if (e) { ops.push({ type: 'log', entry: e }); did.push(`remembered: “${e.text.slice(0, 60)}${e.text.length > 60 ? '…' : ''}”`); }
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
        if (c.repeat === 'weekly') task.repeat = 'weekly';
        if (c.kind === 'shift') task.kind = 'shift';
        ops.push({ type: 'add', task }); work.push(task); did.push(`added “${task.title}”`);
        continue;
      }
      const t = findTask(c.task || c.id || c.title, work);
      if (!t) { skipped.push(`couldn't find “${c.task || c.title || '?'}”`); continue; }
      let op = null;
      if (action === 'skip') {
        const f = { done: true, skipped: true, doneAt: Date.now(), focus: false };
        if (c.note) f.note = String(c.note).slice(0, 1000);
        op = { type: 'patch', id: t.id, fields: f }; did.push(`skipped “${t.title}”`);
      } else if (action === 'resolve') {
        const f = { done: true, doneAt: Date.now(), focus: false };
        if (c.note) f.note = String(c.note).slice(0, 1000);
        op = { type: 'patch', id: t.id, fields: f }; did.push(`resolved “${t.title}”`);
      } else if (action === 'complete' || action === 'done') {
        const f = { done: true, doneAt: Date.now() };
        if (c.note) f.note = String(c.note).slice(0, 1000);
        op = { type: 'patch', id: t.id, fields: f }; did.push(`finished “${t.title}”`);
      } else if (action === 'reopen' || action === 'undone') {
        op = { type: 'patch', id: t.id, fields: { done: false, doneAt: null, skipped: false } }; did.push(`reopened “${t.title}”`);
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
        if (['task', 'reminder', 'progress', 'issue', 'shift', 'class'].includes(c.kind)) f.kind = c.kind;
        if (['due', 'aim'].includes(c.dateKind)) f.dateKind = c.dateKind;
        if (c.off === true || c.off === 'true' || c.off === 'yes') f.off = true;
        else if (c.off === false || c.off === 'false' || c.off === 'no') f.off = false;
        if (c.repeat === 'weekly' || c.repeat === '' || c.repeat === 'none') f.repeat = c.repeat === 'weekly' ? 'weekly' : '';
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
  // Written into the task file so any Claude chat that reads it knows how to change the list,
  // even if its project instructions haven't been updated yet.
  const ABOUT_FOR_CLAUDE = [
    'This is the To-Do Hub task list (app: https://repxore23.github.io/todo-hub/). It is the single source of truth for the user\'s to-dos and deadlines; it replaces the old "To-do & deadlines" doc.',
    'You cannot edit this file. To change the list, create a NEW Google Drive file titled todo-hub-inbox-YYYYMMDD-HHMM.json (contentMimeType text/plain, disableConversionToGoogleType true) containing {"changes":[...]}. The app applies it next time it opens, then deletes it.',
    'Change actions: {"action":"add","title":...,"due":"YYYY-MM-DD","category":...,"priority":"high|med|low","dateKind":"due|aim","repeat":"weekly","est":minutes} · {"action":"complete","task":"<exact title>","note":...} · {"action":"skip","task":...,"note":...} when the user won\'t do it (not counted as done) · {"action":"update","task":"<exact title>", only changed fields; "due":"none" clears; "focus":"yes|no"; "progress":N; "off":true for a shift day off; "note":...} · {"action":"resolve","task":...,"note":...} for missed/missing items · {"action":"reopen"|"delete","task":...} · {"action":"feedback","type":"look|feature|issue|idea","text":...} for comments about the app itself · {"action":"log","text":"<one short line>"} to add to the shared notes.',
    'Shared notes ("log" field): short dated lines about the user\'s situation, decisions, preferences and plans, written by the user, the in-app Claude box and Claude chat, so each knows what the other heard. Read them before answering. Add one (action "log") when the user says something that matters later and doesn\'t belong on a single task; skip small talk and anything already logged.',
    'Meanings: "due" = real deadline (overdue when missed); "aim" = the user\'s own target (never overdue). Reminders ("info only", "last day"), work shifts and class sessions (kind "class": a lab or tutorial itself, e.g. "Lab 5: Gel electrophoresis", attended on its date) are events, never complete them; they clear after their day. Pre-lab quizzes, post-lab sheets and lab assignments are normal tasks. If the user missed a lab/tutorial, update it with "kind":"issue" and a "note". Progress tasks (lecture batches) use "progress", not complete. Read each task\'s "note" for context the user wrote. Only count real deadlines as overdue.',
  ].join(' ');
  async function writeFile(id, d) {
    await gfetch(`${UPLOAD}/files/${id}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'text/plain; charset=UTF-8' }, body: JSON.stringify({ about: ABOUT_FOR_CLAUDE, ...d }, null, 1) });
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
      setSync('warn', pending.length ? `Sync (${pending.length})` : 'Connect');
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
        setSync('ok', 'Synced');
        autoPlan(); // once a day, after the freshest list has loaded
        render();
        if (from.length) toast('From Claude chat: ' + from.join(' · '), 7000);
      } catch (e) {
        if (e && e.code === 'auth') setSync('warn', 'Reconnect');
        else if (e && e.code === 'corrupt') { trackProblem('Task file in Drive was unreadable'); setSync('err', 'Task file is unreadable'); showBanner('Your task file in Google Drive couldn’t be read, so nothing was overwritten. Restore an older version of “todo-hub-tasks.json” in Drive (right-click → Manage versions).'); }
        else {
          if (navigator.onLine) trackProblem(`Sync failed${e && e.status ? ` (HTTP ${e.status})` : ''}`);
          setSync('err', navigator.onLine ? 'Retry sync' : 'Offline');
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
    $('sync-text').textContent = m < 1 ? 'Synced' : `Synced ${m}m ago`;
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
            action: { type: 'string', enum: ['add', 'complete', 'skip', 'resolve', 'reopen', 'update', 'delete', 'feedback', 'log'] },
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

Shared notes about the user (oldest first; written by the user, by you, and by Claude chat; use them as context):
${logForPrompt()}

The user wrote:
"""${msg.slice(0, 4000)}"""

Turn the message into changes to the list.
- "task": the id of the existing task the change is about ("" for add).
- For add: "title" is required; "due" is YYYY-MM-DD or ""; "category" reuses an existing one when it fits, else a short name or ""; "priority" defaults to "med".
- For update: fill only the fields that change and leave the rest "". Use "due": "none" to remove a date.
- Prefer "complete" when the user finished something; use "skip" when they're not going to do it (it's cleared but not counted as done); use "delete" only for mistakes or duplicates.
- Resolve relative dates ("tomorrow", "Friday" = the next Friday after today) against today.
- Kinds: "reminder" tasks are notices (they expire on their own; never complete them). "class" tasks are a lab or tutorial session the user attends on its date (they clear by themselves; never complete them; the prep and follow-up work are separate normal tasks). "progress" tasks have parts (e.g. 9 lecture recordings): set "progress" to the number of parts done so far, e.g. "3" (it completes itself at the total); otherwise leave "progress" "". "issue" tasks are missed or missing things: use action "resolve" with a short "note" saying what happened, instead of "complete".
- If the user says anything about the To-Do Hub app itself (how it looks, how it works, a problem, an idea for it), log it with action "feedback": "title" = the feedback in one clear sentence, "category" = "look", "feature", "issue" or "idea", other fields "".
- When the user says they're behind on lectures, add one catch-up task per course titled like "Catch-up: BIOA01 lectures 4–6" or "Catch-up: CHMA10 lectures (5 recordings)" so the app shows a progress counter.
- Read each task's "note". If a resolved note implies a follow-up (e.g. "got notes, still need to review"), add that follow-up as a new task. Leave "note" "" unless you are resolving.
- "focus" puts a task on Today's focus (the list of what to work on today): "yes" to add it, "no" to take it off, "" to leave it. Use it when the user says they'll work on something today, or asks to plan today.
- Shared notes: when the user tells you something that would change how to help them later and doesn't belong on one task (their situation, a decision, a preference, a plan, why something slipped, "remember that…"), add action "log" with "note" = one short line in third person (the app adds the date), e.g. "Sick this week; pushing study aims back 2–3 days". Other fields "". Not for small talk, not for things already in the shared notes, not for details that belong in a task's note.
- Never add tasks the user didn't mention.
"reply": one short sentence saying what changed. If the message is a question about the list, return no changes and answer it in "reply" in at most 4 short plain-text lines.`;
  }
  function logForPrompt() {
    const recent = (data.log || []).slice(-40);
    if (!recent.length) return '(none yet)';
    return recent.map((e) => `- ${new Date(e.at).toISOString().slice(0, 10)}: ${e.text}`).join('\n');
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
  async function runAsk() {
    const input = $('bar-input');
    const msg = input.value.trim();
    if (!msg) return;
    if (!LS.get('hub.apiKey', '')) { openSettings(); toast('Add your Anthropic API key here to use Ask Claude.'); return; }
    const go = $('bar-go');
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
      input.value = '';
    } catch (e) {
      track('box.error');
      trackProblem('Claude box: ' + claudeError(e));
      showReply(claudeError(e), false);
    } finally {
      go.disabled = false; setBarMode(barMode);
    }
  }
  // One bar for both: "Add" reads the line as a task (instant, free); "Ask Claude" sends it to Claude.
  let barMode = LS.get('hub.barMode', 'add') === 'ask' ? 'ask' : 'add';
  function setBarMode(m) {
    barMode = m; LS.set('hub.barMode', m);
    document.querySelectorAll('#bar .seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    $('bar-input').placeholder = ''; // no placeholder text: the Add / Ask Claude switch already says what the bar does
    $('bar-input').setAttribute('aria-label', m === 'add' ? 'Add a task' : 'Ask Claude');
    $('bar-go').textContent = m === 'add' ? 'Add' : 'Ask';
    quickPreview(m === 'add' ? parseMany($('bar-input').value) : [], $('quick-preview'));
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
    const rops = recurringOps();
    if (rops.length) { commit(rops); return; } // commit re-renders; nextMade stops this repeating
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
    renderPlant();
    const dl = $('cats'); dl.textContent = '';
    cats.forEach((c) => { const o = document.createElement('option'); o.value = c; dl.append(o); });

    if (view === 'dashboard') {
      renderSummary(open, t);
      renderWeek(open, t, colors);
      renderBars(colors);
      // Today's focus in three zones:
      //  1. Due today / tomorrow: real deadlines only (plus anything overdue).
      //  2. Working on: things you pinned, own targets (aims) that have arrived, issues.
      //  3. Heads-up: reminders and work shifts today, labs/tutorials today or tomorrow, one quiet line each.
      const tomorrow = addDays(t, 1);
      const isNotice = (x) => EVENT_KINDS.includes(kindOf(x));
      const dueRank = (x) => (x.due < t ? 0 : x.due === t ? 1 : 2);
      const dueZone = open.filter((x) => !isNotice(x) && !isAim(x) && x.due && x.due <= tomorrow)
        .sort((a, b) => dueRank(a) - dueRank(b) || byPriority(a, b));
      const zoneIds = new Set(dueZone.map((x) => x.id));
      const workZone = open.filter((x) => !zoneIds.has(x.id) && !isNotice(x)
          && (x.focus || (isAim(x) && x.due && x.due <= t) || kindOf(x) === 'issue'))
        .sort((a, b) => Number(b.focus) - Number(a.focus) || (a.due || '9999').localeCompare(b.due || '9999') || byPriority(a, b));
      workZone.forEach((x) => zoneIds.add(x.id));
      const heads = open.filter((x) => isNotice(x) && (x.due === t || (kindOf(x) === 'class' && x.due === tomorrow)))
        .sort(byDue);
      fillZone('zone-due', 'focus-due', dueZone, colors);
      // Always show the deadline zone, so "nothing due" is a clear, reassuring answer.
      $('zone-due').hidden = false;
      $('due-head').hidden = !dueZone.length; // no red heading when there's nothing due
      if (!dueZone.length) $('focus-due').append(el('li', 'empty all-clear', 'Nothing due today or tomorrow'));
      fillZone('zone-work', 'focus-work', workZone, colors);
      fillZone('zone-heads', 'focus-heads', heads, colors, true);
      $('focus-empty').hidden = dueZone.length + workZone.length + heads.length > 0;
      const mustMin = dueZone.reduce((a, x) => a + estMinutes(x), 0);
      const workMin = workZone.reduce((a, x) => a + estMinutes(x), 0);
      $('focus-sub').textContent = [mustMin ? `${fmtMin(mustMin)} due` : '', workMin ? `${fmtMin(workMin)} in progress` : ''].filter(Boolean).join(' · ');
      // Coming soon: high-priority deadlines 2–3 days out, as a preview for spare time.
      const upNext = open.filter((x) => !zoneIds.has(x.id) && !isNotice(x) && x.due && x.due > tomorrow
          && x.due <= addDays(t, 3) && (x.priority === 'high' || x.due === addDays(t, 2)))
        .sort(byDue).slice(0, 5);
      // One quiet line instead of a second list (the same tasks are in Courses below).
      const nl = $('upnext'); nl.textContent = '';
      nl.hidden = !upNext.length;
      if (upNext.length) {
        nl.append(el('span', 'next-label', 'Next'));
        const byDay = {};
        upNext.forEach((x) => { (byDay[x.due] = byDay[x.due] || []).push(x.title); });
        Object.keys(byDay).sort().forEach((d) => {
          const g = el('span', 'next-group');
          g.append(el('b', null, parse(d).toLocaleDateString(undefined, { weekday: 'short' })), ' ' + byDay[d].join(', '));
          nl.append(g);
        });
      }
      renderLabs(open, t, colors);
      renderExams(t, colors);
      balanceHero();
      // Labs & tutorials have their own panel, so they're left out of the Courses list.
      renderSections(open.filter((x) => !zoneIds.has(x.id) && !isLabItem(x) && x.due && x.due > t && x.due <= addDays(t, 7)).sort(byDue), colors);
    } else if (view === 'tasks') {
      renderGroups(open, t, colors);
    } else {
      renderDone(colors, inFilter);
    }
    if (oneMode) renderOne();
    else {
      $('onething').hidden = true; document.body.classList.remove('one-mode');
      $('onething-btn').setAttribute('aria-pressed', 'false'); $('onething-btn').textContent = 'One thing';
      ['dashboard', 'tasks', 'done'].forEach((v) => { $('view-' + v).hidden = v !== view; });
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
    const done = data.tasks.filter((x) => x.done && !x.skipped && x.doneAt >= weekAgo && (filterCat === 'all' || x.category === filterCat)).length;
    const bits = [];
    if (overdue) bits.push(['late', `${overdue} overdue`]);
    bits.push(['', today ? `${today} due today` : 'nothing due today']);
    bits.push(['', `${fmtMin(weekMin)} of work this week`]);
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
  // Events happen on their day and then clear themselves; they're never homework you can "do now".
  const EVENT_KINDS = ['reminder', 'shift', 'class'];
  // Class sessions you attend (a lab or tutorial itself), not the work around them
  // (pre-lab quizzes, post-lab sheets, lab assignments and reports stay normal tasks).
  const isClassTitle = (s) => /^\s*(lab|tutorial|tut|practical|talklab)\s*#?\s*\d+\b/i.test(s)
    && !/quiz|assignment|report|upload|data ?sheet|post-?lab|pre-?lab|notebook|worksheet|submission|questions|write-?up|homework/i.test(s);
  function kindOf(x) {
    if (x.kind) return x.kind;
    if (isShift(x)) return 'shift';
    if (/info only|last day|\breminder\b/i.test(x.title)) return 'reminder';
    if (/\b(missing|missed)\b/i.test(x.title)) return 'issue';
    if (isClassTitle(x.title)) return 'class';
    if (totalOf(x) > 1) return 'progress';
    return 'task';
  }
  const classWord = (x) => (/^\s*(tutorial|tut)\b/i.test(x.title) ? 'tutorial' : /^\s*practical/i.test(x.title) ? 'practical' : 'lab');
  // Reminders and shifts are events: once their day has passed they quietly disappear.
  const expired = (x) => EVENT_KINDS.includes(kindOf(x)) && x.due && x.due < todayStr();
  // Due = a real deadline (turns red when missed). Aim = a target you set yourself (never nags).
  // Catch-ups, study/practice work and issues default to Aim; everything else to Due.
  function isAim(x) {
    if (x.dateKind) return x.dateKind === 'aim';
    const k = kindOf(x);
    return k === 'progress' || k === 'issue' || /catch[- ]?up|\bstudy(ing)?\b(?!\s*tracker)|\breview\b(?!\s*(form|quiz|assignment))|practice|reading/i.test(x.title);
  }
  const hardLate = (x) => !x.done && !!x.due && x.due < todayStr() && !isAim(x) && !EVENT_KINDS.includes(kindOf(x));
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
  // "~2 a day to finish by Mon" for progress tasks with an aim date.
  function pacing(x) {
    if (kindOf(x) !== 'progress' || !x.due) return '';
    const left = Math.max(0, totalOf(x) - x.prog);
    if (!left) return '';
    const t = todayStr();
    if (x.due <= t) return `${left} left`;
    const days = daysBetween(t, x.due) + 1;
    const per = Math.ceil(left / days);
    const by = x.due === t ? 'today' : parse(x.due).toLocaleDateString(undefined, { weekday: 'short' });
    return days === 1 ? `${left} left today` : `~${per} a day to finish by ${by}`;
  }

  // Time estimates: the task's own "est" (minutes) when set, otherwise a guess from its title.
  function estMinutes(x) {
    const kind = kindOf(x);
    if (kind === 'reminder' || kind === 'class') return 0; // a class is scheduled time, not homework
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
  const isShift = (x) => x.kind === 'shift' || (!x.kind && /\bshifts?\b/i.test(x.title) && String(x.category || '').toLowerCase() === 'personal');
  function shiftLabel(x) {
    const m = x.title.match(/\d{1,2}(:\d\d)?\s*(am|pm)?\s*[–-]\s*\d{1,2}(:\d\d)?\s*(am|pm)?/i);
    return 'Shift' + (m ? ' ' + m[0].replace(/\s+/g, ' ') : '');
  }
  // Fits a week cell without truncating: "8:30 am–5 pm" → "8:30–5".
  const shiftShort = (x) => shiftLabel(x).replace(/^Shift ?/, '').replace(/\s*(am|pm)\s*/gi, '').replace(/-/g, '–') || 'work';
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
      if (shifts.length) {
        const s0 = shifts[0];
        col.append(el('span', 'shift-strip' + (s0.off ? ' off' : ''), s0.off ? 'off' : shiftShort(s0)));
      }
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
      lab.append(s, c);
      const ul = el('ul', 'tasks compact');
      byCourse[c].forEach((x) => ul.append(row(x, colors, true)));
      sec.append(lab, ul);
      box.append(sec);
    });
    for (const [name, id] of [['Personal', 'soon-personal'], ['Admin', 'soon-admin']]) {
      const ul = $(id); ul.textContent = '';
      const list = items.filter((x) => sectionOf(x.category) === name);
      // Errands and appointments often have no date: list them under "Anytime" so they never disappear.
      const anytime = data.tasks.filter((x) => doable(x) && !x.due && !x.focus && sectionOf(x.category) === name
        && (filterCat === 'all' || x.category === filterCat));
      if (!list.length && !anytime.length) ul.append(el('li', 'empty', `Nothing ${name.toLowerCase()} in the next week.`));
      list.forEach((x) => ul.append(row(x, colors, true)));
      if (anytime.length) {
        ul.append(el('li', 'anytime-head', 'Anytime'));
        anytime.forEach((x) => ul.append(row(x, colors, true)));
      }
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
    }).filter((r) => r.weekMin > 0).sort((a, b) => b.weekMin - a.weekMin || b.laterMin - a.laterMin); // only courses with work this week
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
      const count = el('div', 'count' + (r.weekMin ? ' strong' : ''), r.weekMin ? `${fmtMin(r.weekMin)}` : '–');
      const track = el('div', 'track');
      if (r.weekMin) { const f = el('div', 'fill hi'); f.style.width = (r.weekMin / mx) * 100 + '%'; f.style.background = colors[r.c]; track.append(f); }
      if (r.laterMin) { const f = el('div', 'fill rest'); f.style.width = (r.laterMin / mx) * 100 + '%'; f.style.background = colors[r.c]; track.append(f); }
      const bits = [];
      if (r.late) bits.push(`${r.late} overdue`);
      if (r.hi) bits.push(`${r.hi} high`);
      if (r.next) bits.push(`next: ${r.next.due === t ? 'today' : parse(r.next.due).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })}`);
      if (r.laterMin) bits.push(`${fmtMin(r.laterMin)} later`);
      b.title = `${r.c}: ${fmtMin(r.weekMin)} this week${bits.length ? ' · ' + bits.join(' · ') : ''}\n(Estimates; set exact times by editing a task. Click to filter.)`;
      b.append(name, count, track);
      b.onclick = () => { filterCat = filterCat === r.c ? 'all' : r.c; render(); };
      box.append(b);
    }
  }

  // Quick wins: short tasks whose deadline is still more than a week away.
  // Once a deadline is within 7 days the task shows in Coming up instead, then in Today's focus.
  function quickWins(t) {
    return data.tasks.filter((x) => !x.done && !x.focus && !EVENT_KINDS.includes(kindOf(x)) && x.due && x.due > addDays(t, 7)
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
        cb.onchange = () => { commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]); doneToast(x); };
        const body = el('div', 'qw-body');
        body.append(el('div', 'qw-title', x.title));
        const meta = el('div', 'qw-meta');
        const s = el('i', 'swatch'); s.style.background = colors[x.category] || 'var(--muted)';
        meta.append(s, `${parse(x.due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${fmtMin(estMinutes(x))}`);
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
      // Only real missed deadlines are "Overdue"; aims whose day has come or passed are just "Today".
      ['overdue', 'Overdue', open.filter(hardLate).sort(byDue)],
      ['today', 'Today', open.filter((x) => x.due && !hardLate(x) && x.due <= t).sort(byPriority)],
      ['g-week', 'This week', open.filter((x) => x.due && x.due > t && x.due <= wk).sort(byDue)],
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
    const blooms = LS.get('hub.blooms', []).length;
    $('done-sub').textContent = `${done.length} task${done.length === 1 ? '' : 's'}` + (blooms ? ` · your plant bloomed on ${blooms} day${blooms === 1 ? '' : 's'}` : '');
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
    const li = el('li', 'task' + (x.done ? ' done' : '') + (x.skipped ? ' skipped' : '') + (compact ? ' compact' : '') + (kind === 'reminder' ? ' reminder' : '') + (kind === 'class' ? ' class' : '')
      + (kind === 'shift' ? ' shift' + (x.off ? ' off' : '') : '')
      + (x.priority === 'high' ? ' hi' : x.priority === 'low' ? ' lo' : '') + (x.focus ? ' pinned' : ''));
    let cb;
    let progAct = null; // − / + buttons sit at the row's right edge, so every title lines up
    if (kind === 'shift') {
      cb = el('span', 'bell');
      cb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
      cb.title = x.off ? 'Day off' : 'Work shift: it goes away by itself after the day';
    } else if (kind === 'class' && !x.done) {
      // A lab or tutorial you attend: a small flask/calendar mark instead of a checkbox.
      cb = el('span', 'bell class-ic');
      cb.innerHTML = /lab|practical/i.test(classWord(x))
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 15h9"/></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';
      cb.title = `Class session: you attend it on the day, then it clears by itself`;
    } else if (kind === 'reminder' && !x.done) {
      cb = el('span', 'bell');
      cb.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
      cb.title = 'Reminder: it goes away by itself after its date';
    } else if (kind === 'issue' && !x.done) {
      cb = el('span', 'issue-ic', '!');
      cb.title = 'Missed or missing: resolve it instead of ticking it off';
    } else if (kind === 'progress' && !x.done) {
      // − 3/9 +  ; at the total the + becomes ✓, so finishing is always a deliberate tap.
      const minus = el('button', 'pc-btn', '−'); minus.type = 'button';
      minus.disabled = x.prog <= 0;
      minus.setAttribute('aria-label', 'One less done: ' + x.title);
      minus.onclick = () => { track('progress.minus'); addGrowth(-60); commit([{ type: 'patch', id: x.id, fields: { prog: Math.max(0, x.prog - 1) } }]); };
      const count = el('span', 'pc-count', `${Math.min(x.prog, total)}/${total}`);
      const full = x.prog >= total;
      const plus = el('button', 'pc-btn' + (full ? ' finish' : ''), full ? '✓' : '+'); plus.type = 'button';
      plus.setAttribute('aria-label', (full ? 'Finish: ' : 'One more done: ') + x.title);
      plus.title = full ? 'All parts done: tap to finish' : 'One more done';
      plus.onclick = () => {
        track(full ? 'progress.finish' : 'progress.plus');
        if (!full) addGrowth(60); // each lecture watched grows the plant
        if (full) {
          commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
          toast(`Finished “${x.title}”`, 6000, [{ type: 'patch', id: x.id, fields: { done: false, doneAt: null } }]);
        } else commit([{ type: 'patch', id: x.id, fields: { prog: x.prog + 1 } }]);
      };
      cb = count;
      cb.classList.add('prog-lead');
      progAct = el('div', 'prog-ctl');
      progAct.append(minus, plus);
    } else {
      cb = el('input', 'check');
      cb.type = 'checkbox'; cb.checked = x.done;
      cb.setAttribute('aria-label', (x.done ? 'Mark not done: ' : 'Mark done: ') + x.title);
      cb.onchange = () => {
        if (x.done) { commit([{ type: 'patch', id: x.id, fields: { done: false, doneAt: null, skipped: false } }]); return; }
        commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
        doneToast(x);
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
        let label = short ? dueLabel(x.due) : dueLabel(x.due);
        let cls = 'due';
        if (kind === 'shift') {
          label = x.off ? `day off · ${label}` : label;
        } else if (kind === 'reminder') {
          label = x.due === t ? 'today' : label;
        } else if (kind === 'class') {
          // "lab tomorrow" / "tutorial today", never "due".
          const w = classWord(x);
          cls += ' class';
          label = x.due === t ? `${w} today` : x.due === addDays(t, 1) ? `${w} tomorrow` : label;
        } else if (aim) {
          // Own targets: soft wording, never red.
          cls += ' aim';
          // An aim that's today or already past just means "work on it today": no "passed", no nagging.
          label = x.done ? label : x.due <= t ? 'aim for today'
            : `aim for ${x.due === addDays(t, 1) ? 'tomorrow' : dueLabel(x.due)}`;
        } else if (!x.done) {
          if (x.due < t) { cls += ' late'; label = `overdue · ${label}`; }
          else if (x.due === t) { cls += ' today'; label = 'due today'; }
          else if (x.due === addDays(t, 1)) { cls += ' soon'; label = 'due tomorrow'; }
        }
        // Tap the date to change it (or switch deadline/target) without opening the editor.
        if (!x.done && kind !== 'shift') {
          const chip = el('button', cls + ' date-chip', label); chip.type = 'button';
          chip.title = 'Change date';
          chip.setAttribute('aria-label', `Change date (${label}): ${x.title}`);
          chip.onclick = (e) => { e.stopPropagation(); openDateMenu(x, chip); };
          meta.append(chip);
        } else meta.append(el('span', cls, label));
      } else if (!x.done && kind !== 'shift' && !compact) {
        const chip = el('button', 'due date-chip add-date', '+ date'); chip.type = 'button';
        chip.setAttribute('aria-label', 'Add a date: ' + x.title);
        chip.onclick = (e) => { e.stopPropagation(); openDateMenu(x, chip); };
        meta.append(chip);
      }
      if (x.skipped) meta.append(el('span', 'pri low', 'Skipped'));
      if (x.category && !compact) { const c = el('span', 'cat'); const s = el('i', 'swatch'); s.style.background = colors[x.category]; c.append(s, x.category); meta.append(c); }
      // Priority is shown by a pink dot before the title (high) or dimmer text (low), not pills.
      if (kind === 'progress' && !x.done && !compact) meta.append(el('span', 'est', pacing(x) || `${fmtMin(estMinutes(x))} left`));
      if (meta.childNodes.length) body.append(meta);
      if (kind === 'progress' && !x.done && total) {
        const bar = el('div', 'prog-bar'); const fill = el('i');
        fill.style.width = (Math.min(x.prog, total) / total) * 100 + '%';
        bar.append(fill); body.append(bar);
      }
      if (x.note) body.append(el('div', 'note-line', (x.done && kind === 'issue' ? 'Resolved: ' : '') + x.note));
      if (resolving === x.id) body.append(resolveBox(x));
      if (handling === x.id) body.append(handleBox(x));
    }
    li.append(cb, body);
    if (progAct) li.append(progAct);
    if (hardLate(x) && handling !== x.id) {
      const hb = el('button', 'resolve-btn', 'Handle'); hb.type = 'button';
      hb.title = 'Missed deadline: submitted late, got an extension, or skipping it';
      hb.setAttribute('aria-label', 'Handle missed deadline: ' + x.title);
      hb.onclick = () => { handling = x.id; render(); };
      li.append(hb);
    }
    if (kind === 'shift') {
      const off = el('button', 'resolve-btn' + (x.off ? ' undo' : ''), x.off ? 'Working' : 'Day off'); off.type = 'button';
      off.title = x.off ? 'I am working this shift after all' : 'Not working this day (requested off, cancelled…)';
      off.setAttribute('aria-label', off.title + ': ' + x.title);
      off.onclick = () => {
        track(x.off ? 'shift.on' : 'shift.off');
        commit([{ type: 'patch', id: x.id, fields: { off: !x.off } }]);
        if (!x.off) toast('Marked as a day off.', 5000, [{ type: 'patch', id: x.id, fields: { off: false } }]);
      };
      li.append(off);
      return li;
    }
    if (kind === 'class' && !x.done) {
      // Couldn't make it? It turns into something to sort out (make-up, notes, emailing the TA).
      const miss = el('button', 'resolve-btn', 'Missed it'); miss.type = 'button';
      miss.title = `Didn't go to this ${classWord(x)}: keep it as something to sort out`;
      miss.setAttribute('aria-label', miss.title + ': ' + x.title);
      miss.onclick = () => {
        track('class.missed');
        commit([{ type: 'patch', id: x.id, fields: { kind: 'issue' } }]);
        toast(`Kept “${x.title}” to sort out. Resolve it when it’s handled.`, 6000, [{ type: 'patch', id: x.id, fields: { kind: '' } }]);
      };
      li.append(miss);
      return li;
    }
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

  // A missed real deadline: say what actually happened instead of just ticking it or leaving it red.
  function handleBox(x) {
    const f = el('form', 'resolve');
    const opts = el('div', 'handle-opts');
    const choices = [['late', 'Submitted late'], ['ext', 'Got an extension'], ['skip', 'Skipping it'], ['other', 'Something else']];
    let pick = 'late';
    const dateIn = el('input'); dateIn.type = 'date'; dateIn.id = 'handle-date'; dateIn.hidden = true; dateIn.setAttribute('aria-label', 'New due date');
    choices.forEach(([v, l]) => {
      const b = el('button', 'chip' + (v === pick ? ' on' : ''), l); b.type = 'button';
      b.setAttribute('aria-pressed', String(v === pick));
      b.onclick = () => {
        pick = v;
        opts.querySelectorAll('.chip').forEach((c) => { c.classList.toggle('on', c === b); c.setAttribute('aria-pressed', String(c === b)); });
        dateIn.hidden = v !== 'ext';
        ta.placeholder = v === 'other' ? 'What happened? Claude will read this.' : 'Anything to add? (optional)';
        if (v === 'ext') dateIn.focus();
      };
      opts.append(b);
    });
    const ta = el('textarea'); ta.id = 'handle-note'; ta.rows = 2; ta.value = x.note;
    ta.placeholder = 'Anything to add? (optional)'; ta.setAttribute('aria-label', 'Note');
    const row2 = el('div', 'actions');
    const ok = el('button', 'btn grad sm', 'Save'); ok.type = 'submit';
    const cancel = el('button', 'btn sm', 'Cancel'); cancel.type = 'button';
    row2.append(ok, cancel);
    f.append(opts, dateIn, ta, row2);
    f.onsubmit = (e) => {
      e.preventDefault();
      const extra = ta.value.trim();
      const join = (a) => [a, extra].filter(Boolean).join(' — ').slice(0, 1000);
      let fields;
      if (pick === 'ext') {
        if (!isDate(dateIn.value)) { dateIn.focus(); return; }
        fields = { due: dateIn.value, dateKind: 'due', note: join(`Extension to ${parse(dateIn.value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`) };
      } else if (pick === 'late') fields = { done: true, doneAt: Date.now(), focus: false, note: join('Submitted late') };
      else if (pick === 'skip') fields = { done: true, skipped: true, doneAt: Date.now(), focus: false, note: join('Skipped') };
      else {
        if (!extra) { ta.focus(); return; }
        fields = { kind: 'issue', note: extra }; // stays open as an issue to resolve, with the explanation attached
      }
      handling = null;
      track('late.' + pick);
      const prev = {}; Object.keys(fields).forEach((k) => { prev[k] = x[k]; });
      commit([{ type: 'patch', id: x.id, fields }]);
      toast('Saved. Claude can see the note.', 5000, [{ type: 'patch', id: x.id, fields: prev }]);
    };
    cancel.onclick = () => { handling = null; render(); };
    return f;
  }

  // Tap a date: quick choices instead of the full editor.
  function openDateMenu(x, anchor) {
    closeDateMenu();
    const t = todayStr();
    const menu = el('div', 'date-menu'); menu.id = 'date-menu'; menu.setAttribute('role', 'menu');
    const set = (fields) => { closeDateMenu(); commit([{ type: 'patch', id: x.id, fields }]); };
    const nextMon = addDays(t, ((8 - parse(t).getDay()) % 7) || 7);
    const base = x.due && x.due > t ? x.due : t;
    [['Today', t], ['Tomorrow', addDays(t, 1)], ['+1 day', addDays(base, 1)], ['Next week (Mon)', nextMon]].forEach(([l, d]) => {
      const b = el('button', null, l); b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.onclick = () => set({ due: d });
      menu.append(b);
    });
    const pick = el('input'); pick.type = 'date'; pick.value = x.due || ''; pick.setAttribute('aria-label', 'Pick a date');
    pick.onchange = () => { if (isDate(pick.value)) set({ due: pick.value }); };
    menu.append(pick);
    if (x.due) { const nd = el('button', null, 'No date'); nd.type = 'button'; nd.onclick = () => set({ due: null }); menu.append(nd); }
    const skip = el('button', null, 'Not doing it (skip)'); skip.type = 'button';
    skip.title = 'Clears it without counting it as done';
    skip.onclick = () => {
      closeDateMenu(); track('skip');
      commit([{ type: 'patch', id: x.id, fields: { done: true, skipped: true, doneAt: Date.now(), focus: false } }]);
      toast(`Skipped “${x.title}”`, 5000, [{ type: 'patch', id: x.id, fields: { done: false, skipped: false, doneAt: null } }]);
    };
    menu.append(skip);
    const aim = isAim(x);
    const sw = el('button', 'switch', aim ? 'Make it a real deadline' : 'Just my own target');
    sw.type = 'button'; sw.title = aim ? 'Turns red if missed' : 'Never turns red';
    sw.onclick = () => set({ dateKind: aim ? 'due' : 'aim' });
    menu.append(sw);
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const w = 210;
    menu.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + 'px';
    const below = r.bottom + 6;
    menu.style.top = (below + 260 > innerHeight ? Math.max(8, r.top - 266) : below) + 'px';
    setTimeout(() => document.addEventListener('click', outsideClose), 0);
    menu.querySelector('button').focus();
  }
  function outsideClose(e) { const m = $('date-menu'); if (m && !m.contains(e.target)) closeDateMenu(); }
  function closeDateMenu() { const m = $('date-menu'); if (m) m.remove(); document.removeEventListener('click', outsideClose); }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDateMenu(); });

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
    const kindNames = { task: 'Task (checkbox)', class: 'Lab / tutorial (attend)', reminder: 'Reminder', progress: 'Progress (parts)', issue: 'Issue (resolve)', shift: 'Work shift' };
    [['', `Type: auto (${kindNames[kindOf(auto)]})`], ...Object.entries(kindNames)].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; ki.append(o); });
    ki.value = x.kind;
    const es = el('select'); es.id = 'edit-est'; es.setAttribute('aria-label', 'Time needed');
    [[0, `Time: auto (${fmtMin(estMinutes(auto))})`], ...[15, 30, 45, 60, 90, 120, 180, 240, 300, 480, 600].map((m) => [m, `Time: ${fmtMin(m)}`])]
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
    const rp = el('select'); rp.id = 'edit-repeat'; rp.setAttribute('aria-label', 'Repeat');
    [['', 'Repeat: no'], ['weekly', 'Repeat: every week']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; rp.append(o); });
    rp.value = x.repeat;
    const no = el('input', 'full'); no.id = 'edit-note'; no.value = x.note; no.placeholder = 'Note for you and Claude (optional)'; no.setAttribute('aria-label', 'Note');
    const actions = el('div', 'actions');
    const save = el('button', 'btn grad sm', 'Save'); save.type = 'submit';
    const cancel = el('button', 'btn sm', 'Cancel'); cancel.type = 'button';
    const del = el('button', 'btn sm danger', 'Delete'); del.type = 'button';
    actions.append(save, cancel, el('span', 'spacer'), del);
    f.append(ti, du, dk, ca, pr, ki, es, rp, to, pg, no, actions);
    f.onsubmit = (e) => {
      e.preventDefault();
      const title = ti.value.trim(); if (!title) return;
      editing = null;
      commit([{ type: 'patch', id: x.id, fields: {
        title: title.slice(0, 300), due: du.value || null, category: cleanCat(ca.value), priority: normPri(pr.value),
        kind: ki.value, dateKind: dk.value, repeat: rp.value, est: Number(es.value) || 0, total: Math.max(0, Number(to.value) || 0), prog: Math.max(0, Number(pg.value) || 0),
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
    handling = null;
    closeDateMenu();
    render();
  }

  // ---------- toast / banner ----------
  let toastTimer = null;
  // A short message at the bottom; pass undoOps to show an Undo button that applies them.
  // extra: more buttons, [{label, ops, track}].
  function toast(msg, ms = 4000, undoOps, extra = []) {
    const t = $('toast'); t.textContent = ''; t.append(el('span', null, msg)); t.hidden = false;
    const btn = (label, ops, key) => {
      const u = el('button', 'toast-undo', label); u.type = 'button';
      u.onclick = () => { track(key); commit(ops); t.hidden = true; };
      t.append(u);
    };
    if (undoOps && undoOps.length) btn('Undo', undoOps, 'undo');
    extra.forEach((e) => btn(e.label, e.ops, e.track || 'toast.extra'));
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms);
  }
  // Tick-off confirmation, with a one-tap switch to "not doing it" (cleared, but not counted as done).
  function doneToast(x) {
    toast(`Done: “${x.title}”`, 6000, [{ type: 'patch', id: x.id, fields: { done: false, doneAt: null, skipped: false } }],
      [{ label: 'Not doing it', ops: [{ type: 'patch', id: x.id, fields: { skipped: true } }], track: 'skip' }]);
  }
  function showBanner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = false; }

  // ---------- settings ----------
  function openSettings() {
    renderLogList();
    $('api-key').value = LS.get('hub.apiKey', '');
    $('api-model').value = LS.get('hub.model', 'claude-haiku-5-5');
    $('autoplan-toggle').checked = LS.get('hub.autoplan', true) !== false;
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

  // ---------- natural quick add ----------
  // "lab report fri high BIOA01" · "study ch 7 aim sun 2h" · "stemble hw every mon" · "dentist dec 3 #Personal"
  const WD = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function weekdayOnOrAfter(t, name) {
    const want = WD.indexOf(name.slice(0, 3).toLowerCase());
    const d = parse(t); const diff = (want - d.getDay() + 7) % 7;
    return addDays(t, diff);
  }
  // Everyday words for subjects, so "bio quiz fri" files under BIOA01 and "chem lab 6" under CHMA10.
  const SUBJECT_WORDS = {
    bio: ['bio', 'biol', 'biology'], chm: ['chem', 'chemistry', 'chm'], che: ['chem', 'chemistry'],
    psy: ['psych', 'psyc', 'psychology', 'psy'], hlt: ['health', 'hlth', 'hlt'], mat: ['math', 'maths', 'calc', 'calculus'],
    phy: ['physics', 'phys'], eng: ['english'], ant: ['anthro', 'anthropology'], soc: ['sociology', 'soci'],
    eco: ['econ', 'economics'], sta: ['stats', 'statistics', 'stat'], csc: ['cs', 'compsci', 'coding', 'programming'],
    his: ['history', 'hist'], phl: ['philosophy', 'philo'], pol: ['polisci', 'politics'], lin: ['linguistics', 'ling'],
    fre: ['french'], nro: ['neuro', 'neuroscience'], ast: ['astro', 'astronomy'], env: ['enviro', 'environment'],
  };
  const PERSONAL_RE = /\b(shift|work(?:ing)?|dentist|doctor|doc|dr|appointment|appt|return|buy|pick ?up|groceries|grocery|laundry|gym|call|text|pay|rent|bank|haircut|clean|x-?ray|pharmacy|prescription|birthday|gift|package|parcel|amazon|car|oil change|mom|dad|psychiatrist|therapist|therapy|physio|optometrist|eye exam|vaccine|flu shot|blood ?work|passport|license|licence)\b/i;
  const ADMIN_RE = /\b(acorn|e-?service|osap|tuition|fees?|registrar|enrol(?:l|ment)?|drop(?:ping)? (?:a |the |my )?(?:course|class)(?:es|s)?|withdraw|petition|transcript|exam conflict|deferr?al|accessibility|accommodation|financial aid|scholarship|bursary|residence|parking|t-?card|student card|course selection)\b/i;
  // Abbreviations → how the rest of the list writes them.
  const WORD_FIX = [
    [/\bhw\s*#?(\d+)\b/gi, 'Homework $1'], [/\bhw\b/gi, 'homework'], [/\b(?:assn|asgn|assgn|assignmt)\s*#?(\d+)\b/gi, 'Assignment $1'], [/\b(?:assn|asgn|assgn|assignmt)\b/gi, 'assignment'],
    [/\bpre[- ]?lab\b/gi, 'pre-lab'], [/\bpost[- ]?lab\b/gi, 'post-lab'], [/\btut\s*#?(\d+)\b/gi, 'Tutorial $1'], [/\btut\b/gi, 'tutorial'],
    [/\blecs\b/gi, 'lectures'], [/\blec\s*#?(\d+)\b/gi, 'Lecture $1'], [/\blec\b/gi, 'lecture'], [/\blab\s*#?(\d+)\b/gi, 'Lab $1'], [/\bquiz\s*#?(\d+)\b/gi, 'Quiz $1'],
    [/\bch\.?\s*(\d+)\b/gi, 'Ch $1'], [/\bmod(?:ule)?\s*(\d+)\b/gi, 'Module $1'], [/\bmidterm\b/gi, 'midterm'], [/\bappt\b/gi, 'appointment'],
    [/\bx[- ]?ray\b/gi, 'X-ray'], [/\bdr\.?(?=\s)/gi, 'Dr.'], [/\bstemble\b/gi, 'Stemble'], [/\bmindtap\b/gi, 'MindTap'], [/\bachieve\b/gi, 'Achieve'],
    [/\bpeer ?scholar\b/gi, 'peerScholar'], [/\bacorn\b/gi, 'ACORN'], [/\bquercus\b/gi, 'Quercus'], [/\be-?service\b/gi, 'eService'], [/\bosap\b/gi, 'OSAP'],
    [/\btalk ?lab\b/gi, 'TalkLab'], [/\bamazon\b/gi, 'Amazon'], [/\bta\b/gi, 'TA'], [/\bta's\b/gi, "TA's"], [/\bprob(?:lem)? ?sets?\b/gi, 'problem set'], [/\b(\d{1,2})(?::(\d\d))?\s*(am|pm)\b/gi, (m, h, mm, ap) => `${h}${mm ? ':' + mm : ''} ${ap.toLowerCase()}`],
  ];
  const FILLER = /^(?:(?:ok(?:ay)?|so|um+|hey|yo|pls|please|add|todo|to-?do|task|new task|remember to|remind me to|reminder to|don'?t forget to|dont forget to|i (?:need|have|got|gotta|should|must|want) to|i gotta|need to|have to|gotta|got to|should|must|i must|i should|i need|make sure (?:to|i)|also)\s*[:,-]?\s+)+/i;
  const EDGE = /^(?:\s|[-:,;.]|\b(?:on|for|by|at|due|the|this|next|before|in|and|to|is|it'?s|its|until|till)\b)+|(?:\s|[-:,;.]|\b(?:on|for|by|at|due|the|this|next|before|in|and|to|is|until|till)\b)+$/gi;

  // Turns one line of everyday typing into a task that looks like the rest of the list.
  function parseQuick(raw) {
    const t = todayStr();
    const out = { title: '', due: null, category: '', priority: 'med', dateKind: '', est: 0, repeat: '', kind: '' };
    let s = ` ${String(raw || '').replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()} `;
    const take = (re, fn) => { s = s.replace(re, (...m) => { fn(...m); return ' '; }); };
    const has = (re) => re.test(s);
    let optional = false; let info = false; let shiftTimes = '';

    // Work shifts: "work sat 8:30-5", "shift fri 5-10", "working 5 to 10 tmrw"
    const TIME = '(\\d{1,2}(?::\\d\\d)?)\\s*(am|pm)?';
    const timeRange = new RegExp(`\\b${TIME}\\s*(?:-|to|till|until)\\s*${TIME}\\b`, 'i');
    if (/\b(shifts?|work(?:ing)?|closing|opening)\b/i.test(s) && (timeRange.test(s) || /\bshifts?\b/i.test(s))) {
      out.kind = 'shift'; out.category = 'Personal';
      take(timeRange, (_, a, ap1, b, ap2) => {
        const hr = (x) => Number(String(x).split(':')[0]);
        let p1 = ap1 && ap1.toLowerCase(); let p2 = ap2 && ap2.toLowerCase();
        if (!p1 && !p2) {
          if (hr(b) < hr(a) || hr(b) === 12) { p1 = 'am'; p2 = 'pm'; } // 8:30-5 → 8:30 am–5 pm
          else if (hr(a) <= 7) { p2 = 'pm'; } // 5-10 → 5–10 pm
          else { p2 = 'am'; } // 9-11 → 9–11 am
        } else if (!p2) p2 = hr(b) < hr(a) ? (p1 === 'am' ? 'pm' : 'am') : p1;
        shiftTimes = (p1 && p1 !== p2 ? `${a} ${p1}` : a) + '–' + `${b} ${p2}`;
      });
      take(/\b(?:(?:evening|morning|night|closing|opening)\s+)?(?:work(?:ing)?\s+)?shifts?\b|\bwork(?:ing)?\b|\bclosing\b|\bopening\b/gi, () => {});
    }

    // Repeats
    take(/\b(?:every|each)\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i, (_, d) => { out.repeat = 'weekly'; out.due = weekdayOnOrAfter(t, d); });
    take(/\b(?:weekly|every week|each week)\b/i, () => { out.repeat = 'weekly'; });

    // Deadline vs own target
    take(/\b(?:aim(?:ing)?(?:\s+(?:for|to))?|try(?:ing)? to|plan(?:ning)? to|hope to|want to|goal(?: is)?(?: to)?)\b/i, () => { out.dateKind = 'aim'; });
    take(/\bdue\b/i, () => { if (!out.dateKind) out.dateKind = 'due'; });

    // Dates
    const md = (m, d) => {
      if (out.due || !(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return;
      const y = Number(t.slice(0, 4));
      let iso = `${y}-${pad(m)}-${pad(d)}`;
      if (iso < addDays(t, -30)) iso = `${y + 1}-${pad(m)}-${pad(d)}`;
      out.due = iso;
    };
    const setDue = (d) => { if (!out.due) out.due = d; };
    take(/\b(?:the\s+)?day after (?:tomorrow|tmrw?|tmr)\b/i, () => setDue(addDays(t, 2)));
    take(/\b(?:today|tonight|tonite|tn|this (?:morning|afternoon|evening)|now|asap)\b/i, (m) => { setDue(t); if (/asap/i.test(m)) out.priority = 'high'; });
    take(/\b(?:tomorrow|tomorow|tmrw?|tmr|2moro|tmro)(?:\s+(?:morning|night|evening|afternoon))?\b/i, () => setDue(addDays(t, 1)));
    take(/\b(?:end of (?:the )?week|eow|this week)\b/i, () => setDue(weekdayOnOrAfter(t, 'fri')));
    take(/\b(?:this )?weekend\b/i, () => setDue(weekdayOnOrAfter(t, 'sat')));
    take(/\bnext week\b/i, () => setDue(weekdayOnOrAfter(addDays(t, 1), 'mon')));
    take(/\bin (?:a|1|one) week\b/i, () => setDue(addDays(t, 7)));
    take(/\bin (\d{1,2}|two|three|four) weeks?\b/i, (_, n) => setDue(addDays(t, 7 * ({ two: 2, three: 3, four: 4 }[n] || Number(n)))));
    take(/\bin (\d{1,2}|a|one|two|three|four|five|six|seven) days?\b/i, (_, n) => setDue(addDays(t, { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 }[n] || Number(n))));
    // "next wed" = the Wednesday of next week (Mon–Sun)
    take(/\bnext\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i, (_, d) => setDue(weekdayOnOrAfter(weekdayOnOrAfter(addDays(t, 1), 'mon'), d)));
    take(/\b(?:this\s+)?(mon|tues?|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?s?\b(?!-)/i, (_, d) => setDue(weekdayOnOrAfter(t, d)));
    take(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/i, (_, mo, d) => md(MON.indexOf(mo.slice(0, 3).toLowerCase()) + 1, Number(d)));
    take(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i, (_, d, mo) => md(MON.indexOf(mo.toLowerCase()) + 1, Number(d)));
    take(/\b(\d{1,2})\/(\d{1,2})\b/, (_, m, d) => md(Number(m), Number(d)));
    take(/\b(?:on\s+)?the\s+(\d{1,2})(?:st|nd|rd|th)\b/i, (_, d) => {
      // "the 5th" = the next 5th of a month
      const n = Number(d); let probe = t;
      for (let i = 0; i < 62 && !out.due; i++) { if (Number(probe.slice(8)) === n) setDue(probe); probe = addDays(probe, 1); }
    });

    // How long it takes
    take(/\b(?:takes?\s+|~\s*|about\s+)?(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\b/i, (_, n) => { out.est = Math.round(Number(n) * 60); });
    take(/\b(?:takes?\s+|~\s*|about\s+)?(\d+)\s*(?:m|min|mins|minutes)\b/i, (_, n) => { out.est = Number(n); });

    // Priority / optional / info only
    take(/(^|\s)(?:!{1,3}|high(?: priority)?|urgent|important|imp|asap|priority)(?=\s)/i, () => { out.priority = 'high'; });
    take(/(^|\s)(?:low(?: priority)?|not urgent|whenever|no rush)(?=\s)/i, () => { out.priority = 'low'; });
    take(/\(?\b(?:optional|if (?:i have )?time|maybe|might)\b\)?/i, () => { out.priority = 'low'; optional = true; });
    take(/\(?\b(?:info only|fyi|heads up|just so i know)\b\)?/i, () => { info = true; });

    // Course: #tag, course code, or everyday subject word
    take(/#([\w/-]+)/, (_, c) => { if (!out.category) out.category = c; });
    take(/\b([A-Za-z]{3,4}[A-Da-d]?\d{2})(?:[HhYy]\d)?\b/, (_, c) => { if (!out.category && /[a-z]{3}/i.test(c)) out.category = c.toUpperCase(); });
    if (!out.category) {
      const courses = categories().filter((c) => /^[A-Za-z]{3,4}[A-Da-d]?\d{2,3}$/.test(c));
      outer: for (const c of courses) {
        const letters = c.match(/^[A-Za-z]+/)[0].toLowerCase();
        const words = [letters, letters.slice(0, 3), ...(SUBJECT_WORDS[letters.slice(0, 3)] || [])];
        for (const w of [...new Set(words)].sort((a, b) => b.length - a.length)) {
          const re = new RegExp(`(^|\\s)${w}(?:'?s)?(?=\\s)`, 'i');
          if (re.test(s)) { out.category = c; s = s.replace(re, ' '); break outer; }
        }
      }
    }
    if (!out.category) {
      const named = categories().find((c) => new RegExp(`(^|\\s)${c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=\\s)`, 'i').test(s));
      if (named) { out.category = named; s = s.replace(new RegExp(`(^|\\s)${named.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?=\\s)`, 'i'), ' '); }
    }
    const cats = categories();
    const known = cats.find((c) => c.toLowerCase() === out.category.toLowerCase());
    if (known) out.category = known;
    // Learn from the list: a word only ever used under one course ("stemble" → CHMA10, "achieve" → BIOA01).
    if (!out.category) {
      const words = (s.toLowerCase().match(/[a-z][a-z-]{2,}/g) || []).filter((w) => !STOP_WORDS.has(w) && !['the', 'and', 'for', 'due', 'get', 'got', 'put', 'see', 'set', 'new', 'old', 'add'].includes(w));
      for (const w of words) {
        const re = new RegExp(`\\b${w.replace(/-/g, '\\-')}\\b`, 'i');
        const seen = new Set(data.tasks.filter((x) => x.category && re.test(x.title)).map((x) => x.category));
        if (seen.size === 1) { out.category = [...seen][0]; break; }
      }
    }
    if (!out.category && ADMIN_RE.test(s)) out.category = cats.find((c) => /^admin$/i.test(c)) || 'Admin';
    if (!out.category && PERSONAL_RE.test(s)) out.category = cats.find((c) => /^personal$/i.test(c)) || 'Personal';

    // Title: drop filler, fix abbreviations, tidy edges
    let title = s.replace(/\s+/g, ' ').trim();
    title = title.replace(/\b(?:to|on|onto) (?:my )?(?:list|to-?do(?: list)?|todos?)\b\s*:?/i, ' ').replace(FILLER, '');
    for (const [re, rep] of WORD_FIX) title = title.replace(re, rep);
    title = title.replace(/\s+/g, ' ').replace(EDGE, '').replace(/\s+/g, ' ').trim();
    // "do the bio assignment" → "Assignment"; keep the verb when it's the whole point ("do laundry" stays).
    title = title.replace(/^(?:do|finish|complete|work on|get done|start on|start)\s+(?:the|my)\s+/i, '').replace(/^(?:the|my)\s+(?=\S+\s)/i, '');
    // Spell words the way your list already does ("fsg" → "FSG", "genwell" → "GenWell").
    const casing = listCasing();
    title = title.replace(/[A-Za-z][A-Za-z-]+/g, (w) => (w === w.toLowerCase() && casing.has(w) ? casing.get(w) : w));

    // Lecture catch-ups: "watch bio lectures 4-6" → "Catch-up: BIOA01 lectures 4–6" (a counter you tick through)
    const lecRange = title.match(/\b(?:lectures?|L)\s*(\d{1,2})\s*(?:-|to|through|thru)\s*L?(\d{1,2})\b/i);
    const lecCount = title.match(/\b(\d{1,2})\s+(?:lectures|recordings|videos)\b/i);
    if ((lecRange || lecCount) && /\b(?:watch|catch(?:ing)?[- ]?up|behind|lectures?|recordings|videos)\b/i.test(title) && !/\bquiz|test|exam\b/i.test(title)) {
      const who = out.category && !/^(personal|admin)$/i.test(out.category) ? out.category + ' ' : '';
      title = lecRange ? `Catch-up: ${who}lectures ${lecRange[1]}–${lecRange[2]}` : `Catch-up: ${who}lectures (${lecCount[1]} recordings)`;
      if (!out.dateKind) out.dateKind = 'aim';
    }
    // Exams read like the rest: "CHMA10 final exam", "BIOA01 midterm"
    if (/^(?:the\s+)?(final(?: exam)?|exam|midterm(?: exam)?|term test(?: \d)?|test)$/i.test(title) && out.category && !/^(personal|admin)$/i.test(out.category)) {
      title = `${out.category} ${/^final$/i.test(title) ? 'final exam' : title.toLowerCase().replace(/^the\s+/, '')}`;
    }
    if (out.kind === 'shift') title = `Work shift${shiftTimes ? ' ' + shiftTimes : ''}`;
    if (optional && !/\(optional\)/i.test(title)) title += ' (optional)';
    if (info && !/info only|last day/i.test(title)) title += ' (info only)';
    // Capitalise the first letter, unless it's a word like "peerScholar" or "eService".
    out.title = !title ? '' : /^[a-z]+[A-Z]/.test(title) ? title : title.charAt(0).toUpperCase() + title.slice(1);
    return out;
  }
  const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'into', 'about', 'before', 'after', 'next', 'week', 'weeks', 'today', 'tomorrow', 'need', 'have', 'gotta', 'should', 'finish', 'start', 'work', 'study', 'review', 'quiz', 'quizzes', 'test', 'exam', 'final', 'homework', 'assignment', 'lecture', 'lectures', 'notes', 'reading', 'lab', 'labs', 'tutorial', 'submission', 'submit', 'phase', 'module', 'chapter', 'week', 'reflection', 'report', 'optional', 'info', 'only', 'catch-up', 'catch', 'make-up', 'email', 'upload', 'form', 'forms', 'data', 'sheet', 'questions', 'prep', 'practice', 'problem', 'problems', 'online', 'post-lab', 'pre-lab']);
  // Words written with capitals somewhere in the list (FSG, GenWell, ACORN, Quercus…).
  let casingCache = { n: -1, map: new Map() };
  function listCasing() {
    if (casingCache.n === data.tasks.length) return casingCache.map;
    const map = new Map();
    for (const x of data.tasks) for (const w of x.title.match(/[A-Za-z][A-Za-z-]+/g) || []) {
      if (w !== w.toLowerCase() && w.slice(1) !== w.slice(1).toLowerCase()) map.set(w.toLowerCase(), w); // has capitals beyond the first letter
    }
    casingCache = { n: data.tasks.length, map };
    return map;
  }
  // Several at once: one per line, or separated by ";".
  const parseMany = (raw) => String(raw || '').split(/\s*(?:;|\n)\s*/).map(parseQuick).filter((p) => p.title);

  // The live line under the bar shows exactly how it'll be filed, before Enter.
  function quickPreview(p, box) {
    box.textContent = '';
    const list = Array.isArray(p) ? p : (p && p.title ? [p] : []);
    if (!list.length) return;
    const colors = colorMap();
    list.slice(0, 4).forEach((q) => {
      const row = el('div', 'qp-row');
      const kind = q.kind || kindOf({ ...q, kind: '', total: 0, prog: 0, title: q.title });
      const chip = (text, cls = '') => row.append(el('span', 'qp-chip' + cls, text));
      row.append(el('span', 'qp-title', q.title));
      if (q.category) {
        const c = el('span', 'qp-chip qp-cat'); const sw = el('i', 'swatch'); sw.style.background = colors[q.category] || 'var(--muted)';
        c.append(sw, q.category); row.append(c);
      }
      if (q.due) {
        const t = todayStr();
        const lbl = dueLabel(q.due);
        const aim = q.dateKind === 'aim' || (!q.dateKind && isAim({ ...q, kind, total: 0, prog: 0 }));
        chip(kind === 'class' ? `${classWord(q)} ${q.due === t ? 'today' : q.due === addDays(t, 1) ? 'tomorrow' : lbl}`
          : kind === 'shift' || kind === 'reminder' ? lbl : aim ? `aim for ${lbl}` : `due ${lbl}`);
      } else chip('no date', ' qp-soft');
      const kindName = { class: classWord(q), shift: 'shift', reminder: 'reminder', progress: 'lecture counter', issue: 'to sort out' }[kind];
      if (kindName) chip(kindName, ' qp-soft');
      if (q.priority === 'high') chip('high priority');
      if (q.est) chip(fmtMin(q.est), ' qp-soft');
      if (q.repeat) chip('every week', ' qp-soft');
      box.append(row);
    });
    if (list.length > 4) box.append(el('div', 'qp-more', `+ ${list.length - 4} more`));
  }
  function quickAdd(text) {
    const list = parseMany(text);
    if (!list.length) return false;
    const ops = list.map((p) => {
      const task = newTask({ title: p.title, due: p.due, category: p.category, priority: p.priority });
      if (p.dateKind) task.dateKind = p.dateKind;
      if (p.est) task.est = p.est;
      if (p.repeat) task.repeat = p.repeat;
      if (p.kind) task.kind = p.kind;
      return { type: 'add', task };
    });
    track('quickadd', ops.length);
    commit(ops);
    const first = ops[0].task;
    toast(ops.length > 1 ? `Added ${ops.length} tasks` : `Added “${first.title}”${first.due ? ' · ' + dueLabel(first.due) : ''}`, 5000,
      ops.map((o) => ({ type: 'delete', id: o.task.id })));
    return true;
  }

  // ---------- recurring tasks ----------
  // When a weekly task is done (or a weekly shift's day has passed), the next one appears 7 days later.
  function recurringOps() {
    const t = todayStr(); const ops = [];
    for (const x of data.tasks) {
      if (x.repeat !== 'weekly' || x.nextMade || !x.due) continue;
      const finished = x.done || (kindOf(x) === 'shift' && x.due < t);
      if (!finished) continue;
      let nd = addDays(x.due, 7);
      while (nd < t) nd = addDays(nd, 7);
      const id = x.id.replace(/-r\d{8}$/, '') + '-r' + nd.replace(/-/g, '');
      ops.push({ type: 'patch', id: x.id, fields: { nextMade: true } });
      ops.push({ type: 'add', task: normalizeTask({ ...x, id, due: nd, done: false, doneAt: null, prog: 0, off: false, nextMade: false, focus: false, note: '', createdAt: Date.now() }) });
    }
    return ops;
  }

  // ---------- labs & tutorials panel, tests & exams timeline ----------
  const isLabItem = (x) => !isShift(x) && /\blab\b|\blab ?#?\d|pre-?lab|post-?lab|tutorial|practical|talklab/i.test(x.title);
  const isExam = (x) => /\b(final exam|exam|term test|midterm|final)\b/i.test(x.title) && !/viewing|conflict|feedback|review/i.test(x.title);
  // The two top columns change height with what's due. Put Workload under whichever is shorter,
  // so there's never a big empty gap beside one of them. (One column on narrow screens: keep it last.)
  // Tests & exams joins in too; on one-column screens it goes back to its full-width spot.
  function balanceHero() {
    const L = $('hero-left'), R = $('hero-right'), w = $('workload-card'), ex = $('exams-card'), home = $('exams-home');
    if (!L || !R || !w || !ex || !home) return;
    if (window.matchMedia('(max-width: 1100px)').matches) {
      R.append(w);
      home.parentNode.insertBefore(ex, home);
      ex.classList.remove('in-col');
      return;
    }
    const GAP = 20;
    const cards = [w];
    if (!ex.hidden) { cards.push(ex); ex.classList.add('in-col'); }
    cards.forEach((c) => L.append(c)); // measure everything at column width first
    const sizes = new Map(cards.map((c) => [c, c.offsetHeight]));
    const left = L.offsetHeight - cards.reduce((s, c) => s + sizes.get(c) + GAP, 0);
    const right = R.offsetHeight;
    // Try every arrangement (Workload left/right; Tests & exams left/right/full width below) and keep the most even one.
    // Ties go to Tests & exams staying full width.
    let best = null;
    for (const wSide of ['L', 'R']) {
      for (const eSide of ex.hidden ? ['home'] : ['home', 'L', 'R']) {
        let l = left, r = right;
        const add = (side, c) => { if (side === 'L') l += sizes.get(c) + GAP; else if (side === 'R') r += sizes.get(c) + GAP; };
        add(wSide, w); if (eSide !== 'home') add(eSide, ex);
        const score = Math.abs(l - r) + (eSide === 'home' ? 0 : 1);
        if (!best || score < best.score) best = { score, wSide, eSide };
      }
    }
    (best.wSide === 'L' ? L : R).append(w);
    if (best.eSide === 'home') { home.parentNode.insertBefore(ex, home); ex.classList.remove('in-col'); }
    else (best.eSide === 'L' ? L : R).append(ex);
  }
  let balanceTimer = 0;
  window.addEventListener('resize', () => { clearTimeout(balanceTimer); balanceTimer = setTimeout(() => { if (view === 'dashboard') balanceHero(); }, 120); });

  function renderLabs(open, t, colors) {
    const items = open.filter((x) => isLabItem(x) && x.due && x.due <= addDays(t, 14) && kindOf(x) !== 'reminder').sort(byDue);
    $('labs-card').hidden = !items.length;
    const box = $('labs-list'); box.textContent = '';
    const by = {};
    items.forEach((x) => { (by[x.category || 'Other'] = by[x.category || 'Other'] || []).push(x); });
    Object.keys(by).sort().forEach((c) => {
      const g = el('div', 'lab-group');
      const h = el('div', 'course-label'); const s = el('i', 'swatch'); s.style.background = colors[c] || 'var(--muted)';
      h.append(s, c); g.append(h);
      const ul = el('ul', 'tasks compact');
      by[c].slice(0, 4).forEach((x) => { const li = row(x, colors, true); if (x.due <= t) li.classList.add('lab-now'); ul.append(li); });
      g.append(ul); box.append(g);
    });
  }
  function renderExams(t, colors) {
    const all = data.tasks.filter((x) => !x.done && isExam(x));
    const dated = all.filter((x) => x.due && x.due >= t).sort(byDue);
    const tba = all.filter((x) => !x.due);
    $('exams-card').hidden = !dated.length && !tba.length;
    const tl = $('exam-timeline'); tl.textContent = ''; tl.hidden = !dated.length;
    $('exams-card').querySelectorAll('.exam-list').forEach((n) => n.remove());
    if (dated.length) {
      const span = Math.max(14, daysBetween(t, dated[dated.length - 1].due) + 4);
      // The line shows how they're spread out (dots only, so exams close together never overlap);
      // the names sit in a dated list underneath.
      tl.append(el('div', 'tl-line'), el('span', 'tl-today', 'Today'));
      const list = el('ul', 'exam-list');
      dated.forEach((x) => {
        const d = daysBetween(t, x.due);
        const c = colors[x.category] || 'var(--violet-2)';
        const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
        const m = el('div', 'tl-mark');
        m.style.left = (d / span) * 100 + '%';
        m.style.setProperty('--c', c);
        m.title = `${x.title} · ${dueLabel(x.due)}`;
        m.append(el('i', 'tl-dot'));
        tl.append(m);
        const li = el('li', 'exam-row');
        const dot = el('i', 'exam-dot'); dot.style.background = c;
        li.append(dot, el('span', 'exam-title', x.title), el('span', 'exam-date', dueLabel(x.due)), el('span', 'exam-when' + (d <= 7 ? ' near' : ''), when));
        list.append(li);
      });
      tl.after(list);
    }
    const tbaEl = $('exam-tba');
    tbaEl.hidden = !tba.length;
    tbaEl.textContent = tba.length ? `Date not set yet: ${tba.map((x) => x.title).join(', ')}` : '';
  }

  // ---------- the plant: grows as you finish things today ----------
  // Finished work (by estimated minutes) grows it toward a daily goal; it blooms at the goal and resets each morning.
  // No streaks, nothing lost: the Done page just counts blooms.
  const doneValue = (x) => Math.min(120, Math.max(15, kindOf(x) === 'progress' ? 60 : (x.est || estMinutes({ ...x, kind: 'task' }) || 30)));
  // The plant's day runs 5 am to 5 am, so late-night work counts toward the day you were still up for.
  const plantDay = (ms = Date.now()) => fmt(new Date(ms - 5 * 3600 * 1000));
  function addGrowth(min) {
    const t = plantDay(); const g = LS.get('hub.growth', { date: t, extra: 0 });
    LS.set('hub.growth', { date: t, extra: Math.max(0, (g.date === t ? g.extra : 0) + min) });
  }
  function shiftMinutes(x) {
    const m = x.title.match(/(\d{1,2})(?::(\d\d))?\s*(am|pm)?\s*[–-]\s*(\d{1,2})(?::(\d\d))?\s*(am|pm)?/i);
    if (!m) return 300;
    let a = Number(m[1]) + (Number(m[2]) || 0) / 60; let b = Number(m[4]) + (Number(m[5]) || 0) / 60;
    if (/pm/i.test(m[3] || m[6] || '') && a < 12 && (m[3] ? /pm/i.test(m[3]) : true) && a < b) a += 12;
    if (/pm/i.test(m[6] || '') && b < 12) b += 12;
    return Math.max(60, Math.round((b - a) * 60));
  }
  function growth() {
    const t = plantDay();
    const g = LS.get('hub.growth', { date: t, extra: 0 });
    const done = data.tasks.filter((x) => x.done && !x.skipped && x.doneAt && plantDay(x.doneAt) === t && !EVENT_KINDS.includes(kindOf(x)));
    const mins = done.reduce((a, x) => a + doneValue(x), 0) + (g.date === t ? g.extra : 0);
    const working = data.tasks.some((x) => isShift(x) && x.due === t && !x.off);
    const goal = working ? 60 : 120;
    const pct = mins / goal;
    if (pct >= 1) { const b = LS.get('hub.blooms', []); if (!b.includes(t)) LS.set('hub.blooms', [...b, t].slice(-400)); }
    return { mins, goal, pct, count: done.length };
  }
  const stageName = (p) => (p >= 1 ? 'In bloom' : p >= 0.75 ? 'Budding' : p >= 0.4 ? 'Growing' : p > 0 ? 'Sprouting' : 'A seed, waiting');
  function plantSVG(p, size) {
    const q = Math.min(1, p);
    const stem = 8 + q * 46;               // stem height
    const top = 70 - stem;
    const leaves = Math.min(6, Math.floor(q * 6.5)) + (p > 1 ? Math.min(3, Math.floor((p - 1) * 3)) : 0);
    let lv = '';
    for (let i = 0; i < leaves; i++) {
      const y = 68 - (i + 1) * (stem / (leaves + 1.2));
      const side = i % 2 ? 1 : -1;
      lv += `<path d="M40 ${y} q ${side * 12} ${-8} ${side * 20} ${-2} q ${-side * 9} ${8} ${-side * 20} ${2}z" fill="#9fbf84" opacity="${0.75 + i * 0.04}"/>`;
    }
    const bud = p >= 0.75 && p < 1 ? `<ellipse cx="40" cy="${top - 2}" rx="4.5" ry="6" fill="#c9a0b0"/>` : '';
    let bloom = '';
    if (p >= 1) {
      for (let k = 0; k < 6; k++) { const a = (k * Math.PI) / 3; bloom += `<ellipse cx="${40 + Math.cos(a) * 6}" cy="${top - 4 + Math.sin(a) * 6}" rx="5" ry="3.4" transform="rotate(${(a * 180) / Math.PI} ${40 + Math.cos(a) * 6} ${top - 4 + Math.sin(a) * 6})" fill="#e9b8c6"/>`; }
      bloom += `<circle cx="40" cy="${top - 4}" r="3.6" fill="#f3d58a"/>`;
    }
    const seed = p <= 0 ? '<ellipse cx="40" cy="69" rx="3" ry="2" fill="#7b6a4f"/>' : `<path d="M40 70 C ${39} ${70 - stem / 2} ${41} ${70 - stem / 2} 40 ${top}" stroke="#86a96f" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
    return `<svg viewBox="0 0 80 100" width="${size}" height="${size * 1.25}" aria-hidden="true">${seed}${lv}${bud}${bloom}
      <path d="M22 70 h36 l-4 24 h-28z" fill="#b9775a"/><rect x="19" y="66" width="42" height="7" rx="2" fill="#c98a6b"/></svg>`;
  }
  function renderPlant() {
    const g = growth();
    const mini = $('plant-mini');
    mini.innerHTML = plantSVG(g.pct, 36);
    mini.title = `${stageName(g.pct)}: ${g.count} done today`;
    $('plant-big').innerHTML = plantSVG(g.pct, 96);
    $('one-progress').textContent = g.count ? `${stageName(g.pct)} · ${g.count} done today` : stageName(g.pct);
  }

  // ---------- One thing mode ----------
  // A switch: the dashboard becomes one card with the single best next task. Done / Not now / Skip it.
  let oneMode = LS.get('hub.oneMode', false) === true;
  let oneState = 'pick';
  const notNow = new Set();
  function scoreTask(x, t) {
    let s = 0;
    if (hardLate(x)) s += 1000;
    if (x.due === t) s += 600;
    if (x.focus) s += 400;
    if (x.due === addDays(t, 1)) s += 300;
    if (isAim(x) && x.due && x.due < t) s += 250;
    if (x.priority === 'high') s += 150;
    if (x.priority === 'low') s -= 100;
    if (estMinutes(x) <= 30) s += 60;
    if (x.due) s += Math.max(0, 100 - daysBetween(t, x.due) * 10);
    return s;
  }
  const doable = (x) => !x.done && !expired(x) && !EVENT_KINDS.includes(kindOf(x));
  function pickOne() {
    const t = todayStr();
    return data.tasks.filter((x) => doable(x) && !notNow.has(x.id)).sort((a, b) => scoreTask(b, t) - scoreTask(a, t))[0];
  }
  function reasonFor(x, t) {
    if (hardLate(x)) return 'Overdue';
    if (x.due && x.due <= t) return isAim(x) ? 'Planned for today' : 'Due today';
    if (x.due === addDays(t, 1)) return 'Due tomorrow';
    if (x.focus) return 'On today’s list';
    if (estMinutes(x) <= 30) return 'A quick one';
    return x.due ? `Due ${dueLabel(x.due)}` : 'Next up';
  }
  function renderOne() {
    const on = oneMode;
    $('onething-btn').setAttribute('aria-pressed', String(on));
    $('onething-btn').textContent = on ? 'Show everything' : 'One thing';
    $('onething').hidden = !on;
    document.body.classList.toggle('one-mode', on);
    if (!on) return;
    ['dashboard', 'tasks', 'done'].forEach((v) => { $('view-' + v).hidden = true; });
    const body = $('one-body'); body.textContent = '';
    const t = todayStr();
    if (LS.get('hub.oneRest', '') === t && oneState !== 'after') oneState = 'rest';
    const btn = (label, cls, fn) => { const b = el('button', 'btn ' + cls, label); b.type = 'button'; b.onclick = fn; return b; };
    if (oneState === 'rest') {
      body.append(el('h2', 'one-title', 'That’s it for today.'), el('p', 'one-meta', 'Nice work. Your plant will be here tomorrow.'));
      const row2 = el('div', 'one-actions');
      row2.append(btn('One more anyway', 'sm', () => { LS.set('hub.oneRest', ''); oneState = 'pick'; renderOne(); }));
      body.append(row2); return;
    }
    if (oneState === 'after') {
      body.append(el('h2', 'one-title', 'Nice.'), el('p', 'one-meta', 'Your plant grew a little. One more?'));
      const row2 = el('div', 'one-actions');
      row2.append(btn('One more', 'grad', () => { oneState = 'pick'; renderOne(); }),
        btn('Done for today', '', () => { LS.set('hub.oneRest', t); oneState = 'rest'; renderOne(); }));
      body.append(row2); return;
    }
    const x = pickOne();
    if (!x) {
      body.append(el('h2', 'one-title', notNow.size ? 'That’s everything for now.' : 'Nothing left to do.'), el('p', 'one-meta', 'Enjoy the rest of your day.'));
      if (notNow.size) { const r = el('div', 'one-actions'); r.append(btn('Start over', 'sm', () => { notNow.clear(); renderOne(); })); body.append(r); }
      return;
    }
    const colors = colorMap();
    const kind = kindOf(x);
    body.append(el('p', 'one-reason', reasonFor(x, t)), el('h2', 'one-title', x.title));
    const meta = el('p', 'one-meta');
    if (x.category) { const s = el('i', 'swatch'); s.style.background = colors[x.category] || 'var(--muted)'; meta.append(s, ' ' + x.category + ' · '); }
    meta.append(kind === 'progress' ? `${x.prog}/${totalOf(x)} done · about ${fmtMin(Math.round(estMinutes(x) / Math.max(1, totalOf(x) - x.prog)))} each` : `about ${fmtMin(estMinutes(x))}`);
    body.append(meta);
    const acts = el('div', 'one-actions');
    const finish = () => {
      if (kind === 'progress') {
        const n = x.prog + 1; const total = totalOf(x);
        addGrowth(n >= total ? 0 : 60);
        commit([{ type: 'patch', id: x.id, fields: n >= total ? { prog: total, done: true, doneAt: Date.now() } : { prog: n } }]);
      } else if (kind === 'issue') { resolving = x.id; oneMode = false; LS.set('hub.oneMode', false); location.hash = '#dashboard'; render(); return; }
      else commit([{ type: 'patch', id: x.id, fields: { done: true, doneAt: Date.now() } }]);
      track('one.done'); oneState = 'after'; render();
    };
    acts.append(btn(kind === 'progress' ? 'Did one' : kind === 'issue' ? 'Sort it out' : 'Done', 'grad', finish),
      btn('Not now', '', () => { notNow.add(x.id); track('one.notnow'); renderOne(); }),
      btn('Skip it', 'ghost', () => { track('one.skip'); commit([{ type: 'patch', id: x.id, fields: { done: true, skipped: true, doneAt: Date.now(), focus: false } }]); toast(`Skipped “${x.title}”`, 5000, [{ type: 'patch', id: x.id, fields: { done: false, skipped: false, doneAt: null } }]); }));
    body.append(acts);
  }

  // ---------- today plans itself ----------
  // Once a day: add a few tasks to Today's focus that fit the free time left after shifts. Undo-able.
  function autoPlan() {
    if (LS.get('hub.autoplan', true) === false) return;
    const t = todayStr();
    if (LS.get('hub.planned', '') === t) return;
    LS.set('hub.planned', t);
    const shiftMin = data.tasks.filter((x) => isShift(x) && x.due === t && !x.off).reduce((a, x) => a + shiftMinutes(x), 0);
    let budget = Math.max(60, 300 - shiftMin * 0.6);
    const open = data.tasks.filter(doable);
    const inFocus = new Set(open.filter((x) => x.focus || (x.due && x.due <= addDays(t, 1))).map((x) => x.id));
    budget -= open.filter((x) => inFocus.has(x.id)).reduce((a, x) => a + Math.min(180, estMinutes(x)), 0);
    const cands = open.filter((x) => !inFocus.has(x.id) && x.due && x.due <= addDays(t, 5)).sort((a, b) => scoreTask(b, t) - scoreTask(a, t));
    const ops = [];
    for (const x of cands) {
      const m = Math.min(180, estMinutes(x));
      if (m > budget) continue;
      budget -= m; ops.push({ type: 'patch', id: x.id, fields: { focus: true } });
      if (ops.length >= 3) break;
    }
    if (ops.length) {
      commit(ops);
      toast(`Planned today: added ${ops.length} thing${ops.length > 1 ? 's' : ''} to your focus`, 6000, ops.map((o) => ({ type: 'patch', id: o.id, fields: { focus: false } })));
    }
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
    lines.push(`- Done total: ${data.tasks.filter((x) => x.done && !x.skipped).length} · skipped: ${data.tasks.filter((x) => x.skipped).length} · tasks with a time set by hand: ${manual}`);
    lines.push(`- Categories: ${categories().join(', ')}`);
    return lines.join('\n');
  }

  // ---------- shared notes (Settings) ----------
  const LOG_SRC = { app: 'you', box: 'Claude box', chat: 'Claude chat' };
  function renderLogList() {
    const ul = $('log-list'); ul.textContent = '';
    const log = data.log || [];
    if (!log.length) { ul.append(el('li', 'empty', 'Nothing yet.')); return; }
    [...log].reverse().forEach((e) => {
      const li = el('li', 'log-item');
      const del = el('button', 'pin', '✕'); del.type = 'button';
      del.title = 'Remove'; del.setAttribute('aria-label', 'Remove note: ' + e.text);
      del.onclick = () => { commit([{ type: 'log-del', ids: [e.id] }]); renderLogList(); };
      li.append(el('span', 'log-text', e.text), del, el('span', 'log-meta', `${shortDate(e.at)} · ${LOG_SRC[e.source]}`));
      ul.append(li);
    });
  }
  function addLogFromInput() {
    const text = $('log-text').value.trim();
    if (!text) return;
    commit([{ type: 'log', entry: { id: newId(), at: Date.now(), source: 'app', text } }]);
    $('log-text').value = '';
    renderLogList();
  }
  $('log-add').onclick = addLogFromInput;
  $('log-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addLogFromInput(); } });

  // ---------- wire up ----------
  $('bar-input').addEventListener('input', (e) => { if (barMode === 'add') quickPreview(parseMany(e.target.value), $('quick-preview')); });
  document.querySelectorAll('#bar .seg button').forEach((b) => { b.onclick = () => { setBarMode(b.dataset.mode); $('bar-input').focus(); }; });
  $('bar').addEventListener('submit', (e) => {
    e.preventDefault();
    if (barMode === 'ask') { runAsk(); return; }
    if (quickAdd($('bar-input').value)) { $('bar-input').value = ''; $('quick-preview').textContent = ''; }
  });
  setBarMode(barMode);
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
  $('ask-close').onclick = () => { $('ask-out').hidden = true; };
  $('undo-btn').onclick = () => {
    if (!lastUndo) return;
    commit(lastUndo); lastUndo = null;
    $('undo-btn').hidden = true; $('ask-reply').textContent = 'Undone.';
  };
  $('add').addEventListener('submit', (e) => {
    e.preventDefault();
    // The title is read naturally too ("lab report fri high BIOA01"); the form fields win when filled in.
    const p = parseQuick($('add-title').value);
    const task = newTask({
      title: p.title || $('add-title').value,
      due: $('add-due').value || p.due,
      category: $('add-cat').value || p.category,
      priority: $('add-pri').value !== 'med' ? $('add-pri').value : p.priority,
    });
    if (!task) return;
    if (p.dateKind) task.dateKind = p.dateKind;
    if (p.est) task.est = p.est;
    if (p.repeat) task.repeat = p.repeat;
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
    setSync('warn', 'Connect');
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

  // Clicking a page in the menu leaves One thing mode.
  window.addEventListener('hashchange', () => { if (oneMode) { oneMode = false; LS.set('hub.oneMode', false); } setView(); });
  document.querySelectorAll('[data-view]').forEach((a) => a.addEventListener('click', () => {
    if (oneMode) { oneMode = false; LS.set('hub.oneMode', false); setView(); }
  }));
  $('onething-btn').onclick = () => {
    oneMode = !oneMode; LS.set('hub.oneMode', oneMode); oneState = 'pick'; notNow.clear();
    track(oneMode ? 'one.on' : 'one.off');
    render();
  };
  $('autoplan-toggle').onchange = (e) => { LS.set('hub.autoplan', e.target.checked); if (e.target.checked) { LS.set('hub.planned', ''); autoPlan(); } };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); sync(); } });
  setInterval(() => { if (document.visibilityState === 'visible' && tokenValid()) sync(); }, 60000);
  setInterval(updateSyncAge, 30000);
  setInterval(() => { if (!editing) render(); }, 30 * 60000); // date rollover

  track(window.matchMedia('(max-width: 860px)').matches ? 'open.phone' : 'open.desktop');
  setView();
  if (DRIVE_MODE) {
    if (tokenValid()) sync();
    else setSync('warn', LS.get('hub.gconsent', false) ? 'Reconnect' : 'Connect');
  } else {
    setSync('warn', 'This device only');
    autoPlan();
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
