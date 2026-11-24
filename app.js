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
  const emptyData = () => ({ app: 'todo-hub', version: 1, updatedAt: 0, tasks: [], processedNotes: [] });
  let data = normalizeData(LS.get('hub.data', null)) || emptyData();
  let pending = LS.get('hub.pending', []);
  let filterCat = 'all';
  let editing = null;
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

  // ---------- operations ----------
  // op: {type:'add', task} | {type:'patch', id, fields} | {type:'delete', id}
  function applyOp(tasks, op) {
    const id = op.type === 'add' ? op.task.id : op.id;
    const i = tasks.findIndex((t) => t.id === id);
    if (op.type === 'add') { if (i < 0) tasks.push({ ...op.task }); }
    else if (op.type === 'patch') { if (i >= 0) Object.assign(tasks[i], op.fields); }
    else if (op.type === 'delete') { if (i >= 0) tasks.splice(i, 1); }
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
    ops.forEach((op) => applyOp(data.tasks, op));
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
  function changesToOps(changes, tasks) {
    const ops = []; const did = []; const skipped = [];
    const work = tasks.map((t) => ({ ...t }));
    for (const c of Array.isArray(changes) ? changes : []) {
      if (!c || typeof c !== 'object') continue;
      const action = String(c.action || '').toLowerCase();
      if (action === 'add') {
        const task = newTask({ title: c.title, due: c.due, category: c.category, priority: c.priority });
        if (!task) { skipped.push('an add with no title'); continue; }
        ops.push({ type: 'add', task }); work.push(task); did.push(`added “${task.title}”`);
        continue;
      }
      const t = findTask(c.task || c.id || c.title, work);
      if (!t) { skipped.push(`couldn't find “${c.task || c.title || '?'}”`); continue; }
      let op = null;
      if (action === 'complete' || action === 'done') {
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
        sent.forEach((op) => applyOp(remote.tasks, op));

        const notes = await readInbox();
        const from = []; const toTrash = [];
        for (const n of notes) {
          if (remote.processedNotes.includes(n.id)) { toTrash.push(n.id); continue; }
          if (n.error) {
            const seen = LS.get('hub.badNotes', []);
            if (!seen.includes(n.id)) { from.push(`couldn't read the note “${n.name}”`); LS.set('hub.badNotes', [...seen, n.id].slice(-50)); }
            continue;
          }
          const res = changesToOps(n.changes, remote.tasks);
          res.ops.forEach((op) => applyOp(remote.tasks, op));
          from.push(...res.did, ...res.skipped.map((s) => 'skipped: ' + s));
          remote.processedNotes.push(n.id);
          toTrash.push(n.id);
        }
        remote.processedNotes = remote.processedNotes.slice(-300);

        if (sent.length || from.length) { remote.updatedAt = Date.now(); await writeFile(id, remote); }
        for (const nid of toTrash) { try { await trashFile(nid); } catch { /* retried next sync */ } }

        pending = pending.slice(sent.length);
        data = remote;
        pending.forEach((op) => applyOp(data.tasks, op));
        saveLocal();
        LS.set('hub.lastSync', Date.now());
        setSync('ok', 'Synced just now');
        render();
        if (from.length) toast('From Claude chat: ' + from.join(' · '), 7000);
      } catch (e) {
        if (e && e.code === 'auth') setSync('warn', 'Tap to reconnect Drive');
        else if (e && e.code === 'corrupt') { setSync('err', 'Task file is unreadable'); showBanner('Your task file in Google Drive couldn’t be read, so nothing was overwritten. Restore an older version of “todo-hub-tasks.json” in Drive (right-click → Manage versions).'); }
        else setSync('err', navigator.onLine ? 'Sync failed — tap to retry' : 'Offline — changes are kept on this device');
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
            action: { type: 'string', enum: ['add', 'complete', 'reopen', 'update', 'delete'] },
            task: { type: 'string' },
            title: { type: 'string' },
            due: { type: 'string' },
            category: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'med', 'low', ''] },
          },
          required: ['action', 'task', 'title', 'due', 'category', 'priority'],
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
      .map((x) => ({ id: x.id, title: x.title, due: x.due, category: x.category, priority: x.priority, done: x.done }));
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
      const res = changesToOps(out.changes, data.tasks);
      const inv = inverseOps(res.ops);
      commit(res.ops);
      lastUndo = inv.length ? inv : null;
      let reply = String(out.reply || '').trim() || (res.ops.length ? 'Updated.' : 'No changes.');
      if (res.skipped.length) reply += `\n(Skipped: ${res.skipped.join('; ')})`;
      showReply(reply, Boolean(lastUndo));
      if (res.ops.length) input.value = '';
    } catch (e) {
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
  const PALETTE = ['#9d8cff', '#3dd6f5', '#ff7eb6', '#ffc361', '#4fe0a5', '#6aa8ff', '#ff9f5a', '#c3e86b', '#e58cff', '#7ee7e0'];
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
    const open = data.tasks.filter((x) => !x.done && inFilter(x));

    renderSidebar(cats, colors);
    renderChips(cats, colors);
    const dl = $('cats'); dl.textContent = '';
    cats.forEach((c) => { const o = document.createElement('option'); o.value = c; dl.append(o); });

    if (view === 'dashboard') {
      renderKpis(open, t);
      renderChart(open, t);
      renderBars(colors);
      fillList($('focus-list'), open.filter((x) => x.due && x.due <= t).sort(byDue), colors, 'Nothing overdue or due today. Nice.');
      fillList($('soon-list'), open.filter((x) => x.due && x.due > t && x.due <= addDays(t, 7)).sort(byDue), colors, 'Nothing due in the next week.');
    } else if (view === 'tasks') {
      renderGroups(open, t, colors);
    } else {
      renderDone(colors, inFilter);
    }
  }

  function renderSidebar(cats, colors) {
    const ul = $('cat-list'); ul.textContent = '';
    const counts = {};
    data.tasks.forEach((x) => { if (!x.done) counts[x.category || ''] = (counts[x.category || ''] || 0) + 1; });
    const mk = (key, label, color) => {
      const li = el('li'); const b = el('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(filterCat === key));
      if (color) { const s = el('span', 'swatch'); s.style.background = color; b.append(s); }
      b.append(el('span', null, label));
      b.append(el('span', 'n', String(key === 'all' ? data.tasks.filter((x) => !x.done).length : counts[key] || 0)));
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
  function renderKpis(open, t) {
    const box = $('kpis'); box.textContent = '';
    const overdue = open.filter((x) => x.due && x.due < t).length;
    const today = open.filter((x) => x.due === t).length;
    const high = open.filter((x) => x.priority === 'high').length;
    const inF = (x) => filterCat === 'all' || x.category === filterCat;
    const doneDays = Array.from({ length: 7 }, (_, i) => addDays(t, i - 6));
    const doneCounts = doneDays.map((d) => data.tasks.filter((x) => x.done && inF(x) && x.doneAt && fmt(new Date(x.doneAt)) === d).length);
    const doneWeek = doneCounts.reduce((a, b) => a + b, 0);
    const tiles = [
      { label: 'Overdue', value: overdue, note: overdue ? 'needs attention' : 'all clear', color: 'var(--pink)', tint: 'rgba(255,111,168,.9)' },
      { label: 'Due today', value: today, note: today ? 'on today’s plate' : 'nothing due today', color: 'var(--cyan)', tint: 'rgba(61,214,245,.9)' },
      { label: 'Open', value: open.length, note: `${high} high priority`, color: 'var(--violet)', tint: 'rgba(139,123,255,.9)' },
      { label: 'Done this week', value: doneWeek, note: 'last 7 days', color: 'var(--green)', tint: 'rgba(79,224,165,.9)', spark: doneCounts },
    ];
    for (const k of tiles) {
      const c = el('div', 'card kpi');
      c.style.setProperty('--tint', k.tint);
      const lab = el('div', 'label'); const dot = el('i'); dot.style.background = k.color; lab.append(dot, k.label);
      c.append(lab, el('div', 'value', String(k.value)), el('div', 'note', k.note));
      if (k.spark) {
        const sb = el('div', 'spark-bars');
        const mx = Math.max(1, ...k.spark);
        k.spark.forEach((v, i) => { const s = el('span'); s.style.height = Math.max(2, (v / mx) * 30) + 'px'; s.title = `${dueLabel(doneDays[i])}: ${v}`; sb.append(s); });
        c.append(sb);
      }
      box.append(c);
    }
  }

  function renderChart(open, t) {
    const wrap = $('chart-wrap');
    const days = Array.from({ length: 14 }, (_, i) => addDays(t, i));
    const per = days.map((d) => open.filter((x) => x.due === d));
    const counts = per.map((a) => a.length);
    const W = 640; const H = 220; const L = 30; const R = 14; const T = 16; const B = 30;
    const maxV = Math.max(1, ...counts);
    const step = maxV <= 4 ? 1 : maxV <= 10 ? 2 : 5;
    const yMax = Math.ceil(maxV / step) * step;
    const x = (i) => L + (i * (W - L - R)) / 13;
    const y = (v) => T + (H - T - B) * (1 - v / yMax);
    let line = `M${x(0)},${y(counts[0])}`;
    for (let i = 1; i < 14; i++) { const xm = (x(i - 1) + x(i)) / 2; line += ` C${xm},${y(counts[i - 1])} ${xm},${y(counts[i])} ${x(i)},${y(counts[i])}`; }
    const area = `${line} L${x(13)},${y(0)} L${x(0)},${y(0)} Z`;
    let g = '';
    for (let v = 0; v <= yMax; v += step) g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 10}" y="${y(v) + 3.5}" text-anchor="end">${v}</text>`;
    let xl = '';
    for (let i = 0; i < 14; i += 2) {
      const d = parse(days[i]);
      const lab = i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' }) + ' ' + d.getDate();
      xl += `<text class="axis" x="${x(i)}" y="${H - 8}" text-anchor="middle">${lab}</text>`;
    }
    let dots = '';
    counts.forEach((v, i) => { if (v) dots += `<circle cx="${x(i)}" cy="${y(v)}" r="4" fill="#0b0b16" stroke="url(#gl)" stroke-width="2"/>`; });
    let hits = '';
    const half = (W - L - R) / 26;
    for (let i = 0; i < 14; i++) hits += `<rect data-i="${i}" x="${x(i) - half}" y="${T}" width="${half * 2}" height="${H - T - B}" fill="transparent" style="pointer-events:all"/>`;
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Tasks due per day over the next 14 days">
      <defs>
        <linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8b7bff" stop-opacity=".5"/><stop offset="1" stop-color="#3dd6f5" stop-opacity="0"/></linearGradient>
        <linearGradient id="gl" gradientUnits="userSpaceOnUse" x1="${L}" y1="0" x2="${W - R}" y2="0"><stop offset="0" stop-color="#8b7bff"/><stop offset="1" stop-color="#3dd6f5"/></linearGradient>
      </defs>
      ${g}${xl}
      <path d="${area}" fill="url(#ga)"/>
      <path d="${line}" stroke="url(#gl)" stroke-width="2.5" fill="none"/>
      <line class="hover-line" id="hover-line" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
      ${dots}${hits}
    </svg>`;
    const tip = el('div', 'tip'); tip.hidden = true; wrap.append(tip);
    const svg = wrap.querySelector('svg');
    const hl = wrap.querySelector('#hover-line');
    const show = (i) => {
      tip.textContent = '';
      tip.append(el('b', null, `${dueLabel(days[i])} · ${counts[i]} due`));
      if (per[i].length) {
        const ul = el('ul');
        per[i].slice(0, 4).forEach((task) => ul.append(el('li', null, task.title)));
        if (per[i].length > 4) ul.append(el('li', null, `+${per[i].length - 4} more`));
        tip.append(ul);
      }
      tip.style.left = (x(i) / W) * 100 + '%';
      tip.style.top = (y(counts[i]) / H) * 100 + '%';
      tip.hidden = false;
      hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.setAttribute('visibility', 'visible');
    };
    svg.querySelectorAll('rect[data-i]').forEach((r) => {
      const i = Number(r.dataset.i);
      r.addEventListener('pointerenter', () => show(i));
      r.addEventListener('pointerdown', () => show(i));
    });
    svg.addEventListener('pointerleave', () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); });
    const overdue = open.filter((x2) => x2.due && x2.due < t).length;
    wrap.closest('.card').querySelector('.sub').textContent = 'tasks due per day' + (overdue ? ` · plus ${overdue} overdue` : '');
  }

  function renderBars(colors) {
    const box = $('course-bars'); box.textContent = '';
    const rows = categories().map((c) => {
      const open = data.tasks.filter((x) => !x.done && x.category === c);
      return { c, n: open.length, hi: open.filter((x) => x.priority === 'high').length };
    }).filter((r) => r.n).sort((a, b) => b.n - a.n);
    $('course-sub').textContent = rows.length ? 'bright = high priority' : '';
    if (!rows.length) { box.append(el('p', 'empty', 'No open tasks.')); return; }
    const mx = Math.max(...rows.map((r) => r.n));
    for (const r of rows) {
      const b = el('button', 'bar-row');
      b.type = 'button';
      b.title = `Show ${r.c} tasks`;
      if (filterCat !== 'all' && filterCat !== r.c) b.style.opacity = '.45';
      const name = el('div', 'name'); const sw = el('i', 'swatch'); sw.style.background = colors[r.c];
      name.append(sw, el('span', null, r.c));
      const count = el('div', 'count', r.hi ? `${r.n} · ${r.hi} high` : String(r.n));
      const track = el('div', 'track');
      if (r.hi) { const f = el('div', 'fill hi'); f.style.width = (r.hi / mx) * 100 + '%'; f.style.background = colors[r.c]; track.append(f); }
      if (r.n - r.hi) { const f = el('div', 'fill rest'); f.style.width = ((r.n - r.hi) / mx) * 100 + '%'; f.style.background = colors[r.c]; track.append(f); }
      b.append(name, count, track);
      b.onclick = () => { filterCat = filterCat === r.c ? 'all' : r.c; render(); };
      box.append(b);
    }
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

  function row(x, colors) {
    const li = el('li', 'task' + (x.done ? ' done' : ''));
    const cb = el('input', 'check');
    cb.type = 'checkbox'; cb.checked = x.done;
    cb.setAttribute('aria-label', (x.done ? 'Mark not done: ' : 'Mark done: ') + x.title);
    cb.onchange = () => commit([{ type: 'patch', id: x.id, fields: x.done ? { done: false, doneAt: null } : { done: true, doneAt: Date.now() } }]);
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
        meta.append(el('span', 'due' + (!x.done && x.due < t ? ' late' : x.due === t ? ' today' : ''), dueLabel(x.due)));
      }
      if (x.category) { const c = el('span', 'cat'); const s = el('i', 'swatch'); s.style.background = colors[x.category]; c.append(s, x.category); meta.append(c); }
      if (x.priority === 'high') meta.append(el('span', 'pri high', 'High'));
      if (x.priority === 'low') meta.append(el('span', 'pri low', 'Low'));
      if (meta.childNodes.length) body.append(meta);
    }
    li.append(cb, body);
    return li;
  }

  function editor(x) {
    const f = el('form', 'editor');
    const ti = el('input', 'full'); ti.id = 'edit-title'; ti.value = x.title; ti.required = true; ti.setAttribute('aria-label', 'Task title');
    const du = el('input'); du.type = 'date'; du.id = 'edit-due'; du.value = x.due || ''; du.setAttribute('aria-label', 'Due date');
    const ca = el('input'); ca.id = 'edit-cat'; ca.value = x.category; ca.placeholder = 'Category'; ca.setAttribute('list', 'cats'); ca.setAttribute('aria-label', 'Category');
    const pr = el('select'); pr.id = 'edit-pri'; pr.setAttribute('aria-label', 'Priority');
    [['high', 'High'], ['med', 'Medium'], ['low', 'Low']].forEach(([v, l]) => { const o = el('option', null, l); o.value = v; pr.append(o); });
    pr.value = x.priority;
    const actions = el('div', 'actions');
    const save = el('button', 'btn grad sm', 'Save'); save.type = 'submit';
    const cancel = el('button', 'btn sm', 'Cancel'); cancel.type = 'button';
    const del = el('button', 'btn sm danger', 'Delete'); del.type = 'button';
    actions.append(save, cancel, el('span', 'spacer'), del);
    f.append(ti, du, ca, pr, actions);
    f.onsubmit = (e) => {
      e.preventDefault();
      const title = ti.value.trim(); if (!title) return;
      editing = null;
      commit([{ type: 'patch', id: x.id, fields: { title: title.slice(0, 300), due: du.value || null, category: cleanCat(ca.value), priority: normPri(pr.value) } }]);
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
    ['dashboard', 'tasks', 'done'].forEach((v) => { $('view-' + v).hidden = v !== view; });
    document.querySelectorAll('[data-view]').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    editing = null;
    render();
  }

  // ---------- toast / banner ----------
  let toastTimer = null;
  function toast(msg, ms = 4000) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
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

  // ---------- wire up ----------
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
