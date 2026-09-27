'use strict';
// GenOffice_XLSX_Tasklist board engine v1.1
// - Team mode: one orchestrator owns task definitions; workers may only complete a task assigned to them.
// - Solo mode: one agent owns and works the list; no worker path exists.
// - Every change publishes a NEW immutable version on disk (never opened) and refreshes ONE live workbook tab
//   in GenOffice (close that tab, swap the file, reopen) instead of opening a new tab per version.
// - lookup / selection let the operator discuss tasks by pasting rows, typing IDs, row numbers or words,
//   or selecting cells in GenOffice; answers are cross-referenced against the published version via the CLI.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ID = /^T\d{3,4}$/;
const ID_ANY = /\bT\d{3,4}\b/gi;
const STATUS = /^[A-Z][A-Z -]{1,30}$/;
// Eleven general progress states (custom UPPERCASE statuses are still accepted and shown in amber).
const STATUS_META = {
  'TODO': { color: '#98651D', meaning: 'Not started yet.' },
  'READY': { color: '#0E7490', meaning: 'Specified and unblocked; can start now.' },
  'IN PROGRESS': { color: '#1C66AD', meaning: 'Being worked. The only status a worker can complete from.' },
  'IN REVIEW': { color: '#6D28D9', meaning: 'Work finished; waiting for review or operator approval.' },
  'VERIFYING': { color: '#0F766E', meaning: 'Running the real end-to-end proof; not done until it passes.' },
  'WAITING': { color: '#8A6D1F', meaning: 'Waiting on an external party, host, download or reply; not a fault.' },
  'BLOCKED': { color: '#BA3434', meaning: 'Cannot proceed: a failure, missing access or a gate. Blocked is not done.' },
  'DECISION NEEDED': { color: '#C2410C', meaning: 'Needs an operator choice before work can continue.' },
  'ON HOLD': { color: '#6B7280', meaning: 'Paused by the operator; do not work it until released.' },
  'DONE': { color: '#237446', meaning: 'Outcome met and evidence published. Checkbox ticked, task struck through.' },
  'CANCELLED': { color: '#9CA3AF', meaning: 'Dropped by the owner; not done, kept for the record (greyed, not struck).' },
};
const STATUSES = Object.keys(STATUS_META);
const DONE_ON = '\u2611', DONE_OFF = '\u2610'; // the Done dropdown shows a ticked or empty box
const FIRST_ROW = 5;
const COLUMN_KEYS = ['id', 'done', 'task', 'scope', 'status', 'worker', 'evidence'];
const HEADERS = { id: 'ID', done: 'Done', task: 'Task / acceptance outcome', scope: 'Host / scope', status: 'Status', worker: 'Assigned worker', evidence: 'Evidence / dependency' };
const WIDTHS = { id: 65, done: 60, task: 445, scope: 145, status: 165, worker: 170, evidence: 400 };
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const write = (p, x) => fs.writeFileSync(p, JSON.stringify(x, null, 2) + '\n', { flag: 'wx' });
const isSolo = defs => defs.mode === 'solo';
const letter = i => String.fromCharCode(65 + i);
const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---------- GenOffice CLI resolution (Windows, macOS, Linux) ----------
function launcherIn(dir) {
  if (!dir) return null;
  if (process.platform === 'win32') {
    const cjs = path.join(dir, 'genoffice.cjs');
    const exe = path.resolve(dir, '..', '..', 'GenOffice.exe');
    if (fs.existsSync(cjs) && fs.existsSync(exe)) return { cmd: exe, pre: [cjs], env: { ELECTRON_RUN_AS_NODE: '1' } };
    const c = path.join(dir, 'genoffice.cmd');
    if (fs.existsSync(c)) return { cmd: process.env.ComSpec || 'cmd.exe', pre: ['/d', '/c', c], env: {} };
    return null;
  }
  const b = path.join(dir, 'genoffice');
  return fs.existsSync(b) ? { cmd: b, pre: [], env: {} } : null;
}
function resolveGenoffice() {
  const bin = process.env.GENOFFICE_BIN;
  if (bin) return /\.cmd$/i.test(bin) ? { cmd: process.env.ComSpec || 'cmd.exe', pre: ['/d', '/c', bin], env: {} } : { cmd: bin, pre: [], env: {} };
  let fromApp = null;
  try { fromApp = fs.readFileSync(path.join(os.homedir(), '.genoffice', 'launcher'), 'utf8').trim(); } catch {}
  const defaults = {
    win32: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'GenOffice', 'resources', 'cli'),
    darwin: '/Applications/GenOffice.app/Contents/Resources/cli',
    linux: '/opt/GenOffice/resources/cli',
  };
  for (const d of [fromApp, defaults[process.platform]]) { const l = launcherIn(d); if (l) return l; }
  throw new Error('GenOffice CLI not found. Install/start GenOffice once, or set GENOFFICE_BIN to the genoffice launcher.');
}
function genRaw(args) {
  const l = resolveGenoffice();
  const p = cp.spawnSync(l.cmd, [...l.pre, ...args, '--json'], {
    env: { ...process.env, ...l.env }, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
  });
  if (p.error) throw p.error;
  try { return { code: p.status, r: JSON.parse(p.stdout) }; } catch { throw new Error('Invalid GenOffice response: ' + (p.stderr || p.stdout)); }
}
function gen(args) {
  const { code, r } = genRaw(args);
  if (code !== 0 || r.status !== 'ok') throw new Error('GenOffice ' + args[0] + ' failed: ' + JSON.stringify(r));
  return r;
}

// ---------- GenOffice GUI tab registry and single-tab refresh ----------
function userDataDir() {
  if (process.env.GENOFFICE_USER_DATA) return process.env.GENOFFICE_USER_DATA;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GenOffice');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'GenOffice');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'GenOffice');
}
function guiPid() {
  try { const c = read(path.join(userDataDir(), 'control.json')); process.kill(c.pid, 0); return c.pid; } catch { return null; }
}
// Paths GenOffice has open in tabs, from its own registry (userData/open-documents.json).
function openPaths() {
  try {
    const j = read(path.join(userDataDir(), 'open-documents.json'));
    if (!j.pid) return [];
    try { process.kill(j.pid, 0); } catch { return []; }
    return (j.paths || []).map(norm);
  } catch { return []; }
}
function isOpenInGui(p) { return openPaths().includes(norm(p)); }
// Registry paths with their original letter case (tab titles are matched exactly).
function openPathsRaw() {
  try {
    const j = read(path.join(userDataDir(), 'open-documents.json'));
    if (!j.pid) return [];
    try { process.kill(j.pid, 0); } catch { return []; }
    return j.paths || [];
  } catch { return []; }
}
// Close exactly one GenOffice tab (the file p) and prove from the registry that only that tab closed.
function closeTab(p, { save = false } = {}) {
  const target = norm(p);
  const before = openPaths();
  if (!before.includes(target)) return { closed: true, method: 'not-open' };
  const pid = guiPid();
  if (!pid) return { closed: false, error: 'GenOffice control endpoint not found' };
  // Windows: click that tab's own "Close tab" button through UI Automation (no keystrokes, focus handed back).
  // Any unsaved-changes dialog is answered "Don't Save": the engine has already read the operator's edits.
  // macOS keystroke close (Cmd+W) steals focus, so it only runs with GXT_ALLOW_KEYS=1. Elsewhere: report, never guess.
  let method, k;
  if (process.platform === 'win32') {
    method = 'ui-automation close-tab button';
    k = cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'close-tab-uia.ps1'), '-GuiPid', String(pid), '-Title', path.basename(p), '-Answer', 'DontSave'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } else if (process.platform === 'darwin' && process.env.GXT_ALLOW_KEYS === '1') {
    method = 'cmd+w keystroke (opted in with GXT_ALLOW_KEYS=1)';
    gen(['open', p]);
    sleep(900);
    k = cp.spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of (first process whose unix id is ' + pid + ') to true', '-e', 'delay 0.4', '-e', 'tell application "System Events" to keystroke "w" using command down'], { encoding: 'utf8', timeout: 20000 });
  } else {
    return { closed: false, error: 'No focus-safe scripted tab close on this platform: close the tab by hand (or set GXT_ALLOW_KEYS=1 on macOS); nothing else was changed' };
  }
  if (k.status !== 0) return { closed: false, method, error: ((k.stdout || '') + (k.stderr || '')).trim() || 'close failed' };
  {
    for (let i = 0; i < 15; i++) {
      sleep(300);
      const after = openPaths();
      const otherTabsClosed = before.filter(x => x !== target && !after.includes(x));
      if (otherTabsClosed.length) return { closed: !after.includes(target), method, otherTabsClosed, error: 'another tab closed; stopped' };
      if (!after.includes(target)) return { closed: true, method, otherTabsClosed, detail: (k.stdout || '').trim() };
    }
  }
  return { closed: false, method, error: 'tab still open after the close request; nothing else was changed' };
}
function atomicCopy(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = dst + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}
// After a tab closes GenOffice may still be flushing a save; wait until the file stops changing (max ~6 s).
function waitStable(p) {
  let last = null;
  for (let i = 0; i < 20; i++) {
    let cur = null;
    try { const s = fs.statSync(p); cur = s.size + ':' + s.mtimeMs; } catch { return; }
    if (cur === last) return;
    last = cur;
    sleep(300);
  }
}
// Prove the GUI tab shows this revision: row 2 of the Tasks sheet carries "Revision <rev>".
function verifyDisplayed(liveBook, rev) {
  for (let i = 0; i < 10; i++) {
    const { code, r } = genRaw(['selection', liveBook]);
    if (code === 0 && r.status === 'ok') {
      const shown = JSON.stringify(r.detail?.values || []);
      if (shown.includes('Revision ' + rev)) return { displayedRevisionVerified: true };
    }
    sleep(500);
  }
  return { displayedRevisionVerified: false };
}
// GenOffice autosave default (Home > Auto-save). On by default for tasklists; the running app caches it,
// so a change takes effect at the next GenOffice start (or one flip of the Home toggle).
function ensureAutosave(defs) {
  if (defs.autosave === false || process.env.GENOFFICE_TASKLIST_NO_AUTOSAVE === '1') return { autosave: 'left as is (opted out)' };
  const p = path.join(userDataDir(), 'app-settings.json');
  let s = {};
  try { s = read(p); } catch (e) { if (fs.existsSync(p)) return { autosave: 'not changed: app-settings.json unreadable', error: e.message }; }
  if (s.autoSaveDefault === true) return { autosave: 'already on' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak-tasklist-' + stamp);
  const next = { ...s, autoSaveDefault: true, autoSaveDefaultUpdatedAt: Date.now() };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx' });
  fs.renameSync(tmp, p);
  return { autosave: 'turned on', effective: guiPid() ? 'next GenOffice start (the running app cached the old value) or flip Home > Auto-save once' : 'next GenOffice start', backup: p + '.bak-tasklist-' + stamp };
}
// Where the visible workbook lives. Standard layout: <project root>/GenOffice_XLSX_Tasklist/ holds the live .xlsx
// and TASKLIST-LOG.md at its top level, with tasks.json, HEAD.json and versions/ beside them.
// Otherwise tasks.json "liveDir" (relative to the board folder), otherwise <board>/LIVE.
const BOARD_FOLDER = 'GenOffice_XLSX_Tasklist';
// Sessions are named Genofficetasklist<MMDDYY><Tree>: one word from California's ten most voluminous trees,
// the first one not yet used in this project on that date.
const TREES = ['Ponderosa', 'Douglas', 'Redwood', 'Incense', 'Live', 'Jeffrey', 'White', 'Black', 'Lodgepole', 'Madrone'];
function sessionNameFor(folder, date = new Date(), tree = null) {
  const stamp = String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0') + String(date.getFullYear()).slice(-2);
  const used = new Set(fs.existsSync(folder) ? fs.readdirSync(folder).map(n => n.replace(/\.(xlsx|md)$/i, '').toLowerCase()) : []);
  const prefix = 'Genofficetasklist' + stamp;
  if (tree) { const t = TREES.find(x => x.toLowerCase() === String(tree).toLowerCase()) || tree; if (used.has((prefix + t).toLowerCase())) throw new Error(prefix + t + ' already exists in ' + folder); return prefix + t; }
  for (let round = 1; ; round++) for (const t of TREES) { const n = prefix + t + (round > 1 ? round : ''); if (!used.has(n.toLowerCase())) return n; }
}
// Layout: <project>/GenOffice_XLSX_Tasklist/<session>.xlsx and <session>.md, engine files in <project>/GenOffice_XLSX_Tasklist/<session>/.
function inSessionLayout(root) { return path.basename(path.dirname(root)) === BOARD_FOLDER; }
function livePathFor(root, defs) {
  const dir = defs.liveDir ? path.resolve(root, defs.liveDir) : inSessionLayout(root) ? path.dirname(root) : path.basename(root) === BOARD_FOLDER ? root : path.join(root, 'LIVE');
  return path.join(dir, workbookName(defs));
}
function logPathFor(root, defs) {
  return inSessionLayout(root) ? path.join(path.dirname(root), path.parse(workbookName(defs)).name + '.md') : path.join(root, 'TASKLIST-LOG.md');
}
// Snapshot files get their own names so every GenOffice tab title is unique (the tab close targets titles).
function versionBookName(defs, rev) { return path.parse(workbookName(defs)).name + '@' + rev.slice(11, 16) + '-' + rev.slice(-6) + '.xlsx'; }
// Refresh the single live tab: close it if open, keep any operator/autosave edit, swap in the new version,
// reopen at the same spot, verify the displayed revision.
function refreshLive(versionBook, liveBook, { open = true, rev = null, expectedLiveSha = null, root = null, preserveDrift = false, save = false } = {}) {
  const wasOpen = isOpenInGui(liveBook);
  const preserve = () => {
    if (!preserveDrift || !expectedLiveSha || !fs.existsSync(liveBook) || hash(fs.readFileSync(liveBook)) === expectedLiveSha) return null;
    const keep = path.join(root || path.dirname(liveBook), 'operator-edits', new Date().toISOString().replace(/[:.]/g, '-') + '-' + path.basename(liveBook));
    fs.mkdirSync(path.dirname(keep), { recursive: true });
    fs.copyFileSync(liveBook, keep);
    return keep;
  };
  if (wasOpen) {
    if (!open) return { live: liveBook, liveUpdated: false, liveStale: true, reason: 'live tab is open and --no-open was given; file left untouched' };
    const c = closeTab(liveBook, { save });
    if (!c.closed) return { live: liveBook, liveUpdated: false, liveStale: true, reason: c.error, closeMethod: c.method };
    waitStable(liveBook);
    const operatorEditPreserved = preserve();
    atomicCopy(versionBook, liveBook);
    gen(['open', liveBook, '--range', 'Tasks!A1:G14']);
    let shown = rev ? verifyDisplayed(liveBook, rev) : {};
    let retried = false;
    if (rev && !shown.displayedRevisionVerified) {
      // A late save can land after the swap: close once more without saving, swap again, reopen.
      retried = true;
      const c2 = closeTab(liveBook);
      if (c2.closed) { waitStable(liveBook); atomicCopy(versionBook, liveBook); gen(['open', liveBook, '--range', 'Tasks!A1:G14']); shown = verifyDisplayed(liveBook, rev); }
    }
    return { live: liveBook, liveUpdated: true, liveStale: rev ? !shown.displayedRevisionVerified : false, tab: 'refreshed in place', closeMethod: c.method, otherTabsClosed: c.otherTabsClosed, operatorEditPreserved, retried, ...shown };
  }
  const operatorEditPreserved = preserve();
  atomicCopy(versionBook, liveBook);
  if (!open) return { live: liveBook, liveUpdated: true, liveStale: false, tab: 'not opened (--no-open)', operatorEditPreserved };
  gen(['open', liveBook, '--range', 'Tasks!A1:G14']);
  return { live: liveBook, liveUpdated: true, liveStale: false, tab: 'opened (single live tab)', operatorEditPreserved, ...(rev ? verifyDisplayed(liveBook, rev) : {}) };
}
// Close stale snapshot tabs of this board (anything open under <board>/versions), one verified close at a time.
function tidy(boardDir) {
  const root = path.resolve(boardDir);
  const vdir = norm(path.join(root, 'versions')) + (process.platform === 'win32' ? '\\' : '/');
  const stale = openPathsRaw().filter(p => norm(p).startsWith(vdir));
  const closed = [], failed = [];
  for (const p of stale) {
    const c = closeTab(p);
    if (c.closed && !(c.otherTabsClosed || []).length) closed.push(p);
    else { failed.push({ path: p, error: c.error || 'another tab closed unexpectedly', otherTabsClosed: c.otherTabsClosed }); break; }
  }
  return { board: root, staleFound: stale.length, closed, failed, stillOpenUnderBoard: openPaths().filter(p => p.startsWith(norm(root))) };
}

// ---------- validation ----------
function columnsOf(defs) {
  const cols = (defs.layout && defs.layout.columns) || COLUMN_KEYS;
  return cols;
}
function validateDefinitions(defs) {
  if (!defs || typeof defs !== 'object') throw new Error('tasks.json must be an object');
  for (const k of ['title', 'ownerId', 'ownerLabel']) if (typeof defs[k] !== 'string' || !defs[k].trim()) throw new Error('tasks.json needs a non-empty "' + k + '"');
  if (defs.mode !== undefined && !['team', 'solo'].includes(defs.mode)) throw new Error('"mode" must be "team" or "solo"');
  const cols = columnsOf(defs);
  if (!Array.isArray(cols) || cols.length !== COLUMN_KEYS.length || COLUMN_KEYS.some(k => !cols.includes(k))) throw new Error('layout.columns must be a permutation of ' + COLUMN_KEYS.join(', '));
  if (!Array.isArray(defs.tasks) || !defs.tasks.length) throw new Error('tasks.json needs a non-empty "tasks" array');
  const seen = new Set();
  for (const t of defs.tasks) {
    if (!ID.test(t.id || '')) throw new Error('Bad task id ' + JSON.stringify(t.id) + ' (use T001..T9999)');
    if (seen.has(t.id)) throw new Error('Duplicate task id ' + t.id);
    seen.add(t.id);
    if (typeof t.task !== 'string' || !t.task.trim()) throw new Error(t.id + ': "task" text required');
    if (typeof t.status !== 'string' || !STATUS.test(t.status)) throw new Error(t.id + ': status must be UPPERCASE words, e.g. ' + STATUSES.join(', '));
    if (isSolo(defs) && t.worker) throw new Error(t.id + ': solo boards have no workers; remove "worker" or set "mode": "team"');
    if (t.deps !== undefined && (!Array.isArray(t.deps) || t.deps.some(d => typeof d !== 'string' || d === t.id))) throw new Error(t.id + ': "deps" must be a list of other task IDs');
    for (const k of ['context', 'acceptance']) if (t[k] !== undefined && (typeof t[k] !== 'string' || t[k].length > 20000)) throw new Error(t.id + ': "' + k + '" must be text up to 20000 characters');
  }
  for (const t of defs.tasks) for (const d of t.deps || []) if (!seen.has(d)) throw new Error(t.id + ': depends on unknown task ' + d);
  const dc = defs.layout && defs.layout.doneControl;
  if (dc !== undefined && !['dropdown', 'checkbox'].includes(dc)) throw new Error('layout.doneControl must be "dropdown" or "checkbox"');
  if (defs.scopes !== undefined && (!Array.isArray(defs.scopes) || defs.scopes.some(s => typeof s !== 'string' || !s.trim()))) throw new Error('"scopes" must be a list of names');
  return defs;
}
function validateCompletion(defs, state, actor, id, owner) {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('Existing task ID required (Tnnn); no edits or new tasks accepted');
  const task = defs.tasks.find(t => t.id === id);
  if (!task) throw new Error('Unknown task ID ' + id);
  if (actor !== owner && isSolo(defs)) throw new Error('Solo board: only the owning agent completes tasks');
  if (actor !== owner && task.worker !== actor) throw new Error('Task ' + id + ' is not assigned to this worker');
  if (actor !== owner && task.status !== 'IN PROGRESS') throw new Error('Task ' + id + ' is ' + task.status + ', not released for worker completion');
  return task;
}

// ---------- workbook content ----------
function evidenceText(t, state) {
  const note = state.notes && state.notes[t.id];
  return [t.evidence || '', note ? 'Done note: ' + note : ''].filter(Boolean).join(' | ');
}
function workerText(defs, t) {
  if (isSolo(defs)) return defs.ownerLabel + ' (solo)';
  return t.workerLabel || (t.worker ? 'Assigned worker' : defs.ownerLabel + ' / unassigned');
}
function cellValues(defs, state, t) {
  const done = Boolean(state.done[t.id]);
  const checkbox = defs.layout && defs.layout.doneControl === 'checkbox';
  return { id: t.id, done: checkbox ? done : (done ? DONE_ON : DONE_OFF), doneFlag: done, task: t.task, scope: t.scope || '', status: done ? 'DONE' : t.status, worker: workerText(defs, t), evidence: evidenceText(t, state) };
}
function statusChoices(defs) { return [...new Set([...STATUSES, ...defs.tasks.map(t => t.status)])].slice(0, 100); }
function scopeChoices(defs) { return [...new Set([...(defs.scopes || []), ...defs.tasks.map(t => t.scope).filter(s => s && s.trim())])].slice(0, 100); }
function notesFor(root, id, limit = 5) {
  try {
    return fs.readFileSync(path.join(root, 'notes.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(n => n.id === id).slice(-limit);
  } catch { return []; }
}
// ---------- tracking over time: change summaries, History sheet, TASKLIST-LOG.md ----------
function actorLabel(defs, actor, owner) {
  if (actor === owner) return defs.ownerLabel;
  const t = defs.tasks.find(x => x.worker === actor);
  return t && t.workerLabel ? t.workerLabel : 'worker ' + String(actor).slice(0, 8);
}
function diffDefinitions(prev, next) {
  if (!prev) return ['board created with ' + next.tasks.length + ' tasks'];
  const out = [];
  const pm = new Map(prev.tasks.map(t => [t.id, t])), nm = new Map(next.tasks.map(t => [t.id, t]));
  for (const t of next.tasks) {
    const p = pm.get(t.id);
    if (!p) { out.push('added ' + t.id + ' [' + t.status + ']: ' + t.task); continue; }
    if (p.status !== t.status) out.push(t.id + ' status ' + p.status + ' -> ' + t.status);
    if (p.task !== t.task) out.push(t.id + ' reworded: ' + t.task);
    if ((p.worker || '') !== (t.worker || '')) out.push(t.id + ' reassigned to ' + (t.workerLabel || t.worker || 'owner'));
    if ((p.evidence || '') !== (t.evidence || '')) out.push(t.id + ' evidence updated');
  }
  for (const p of prev.tasks) if (!nm.has(p.id)) out.push('removed ' + p.id + ': ' + p.task);
  const pc = JSON.stringify(columnsOf(prev)), nc = JSON.stringify(columnsOf(next));
  if (pc !== nc) out.push('layout ' + columnsOf(next).map((k, i) => letter(i) + '=' + k).join(' '));
  if ((prev.mode || 'team') !== (next.mode || 'team')) out.push('mode ' + (prev.mode || 'team') + ' -> ' + (next.mode || 'team'));
  return out;
}
function historyRows(state) {
  const rows = [['When (UTC)', 'Revision', 'Action', 'Task', 'By', 'Changes / note']];
  for (const e of (state.events || []).slice(-500).reverse()) {
    rows.push([String(e.at || '').replace('T', ' ').slice(0, 19), e.revision || '', e.action || '', e.task || '', e.by || '', [...(e.changes || []), e.note ? 'note: ' + e.note : ''].filter(Boolean).join('; ')]);
  }
  return rows;
}
function appendLog(root, defs, head, event) {
  const md = logPathFor(root, defs);
  if (!fs.existsSync(md)) fs.writeFileSync(md, '# ' + defs.title + ' - tasklist log\n\nAppend-only record of every publish of this project tasklist (a sub-session log across agent sessions). Newest at the bottom. Workbook: ' + path.basename(head.live || head.workbook) + '\n');
  const lines = ['', '## ' + event.at + ' | ' + event.action + (event.task ? ' ' + event.task : '') + ' | ' + (event.by || ''),
    '- revision ' + head.revision + ' | ' + head.completed + '/' + head.total + ' done | session ' + (defs.session || '')];
  for (const c of event.changes || []) lines.push('- ' + c);
  if (event.note) lines.push('- note: ' + event.note);
  fs.appendFileSync(md, lines.join('\n') + '\n');
  fs.appendFileSync(path.join(root, 'history.jsonl'), JSON.stringify({ ...event, revision: head.revision, completed: head.completed, total: head.total, workbook: head.workbook }) + '\n');
}
function rowsAndOps(defs, state, rev = '', root = null) {
  const hist = historyRows(state);
  const cols = columnsOf(defs);
  const L = k => letter(cols.indexOf(k));
  const last = letter(cols.length - 1);
  const n = defs.tasks.length + FIRST_ROW - 1;
  const solo = isSolo(defs);
  const headers = { ...HEADERS, worker: solo ? 'Owner' : HEADERS.worker };
  const rows = [
    [defs.title],
    ['Owner: ' + defs.ownerLabel + (solo ? ' | Solo agent' : ' | Completion-only workers') + ' | Revision ' + rev],
    [defs.subtitle || 'Change Status, Scope or Done with the dropdowns to redirect the agent, or copy rows / type IDs (T002) or row numbers into the agent chat to discuss. A ticked box means the outcome was met with evidence; blocked is not done.'],
    cols.map(k => headers[k]),
  ];
  for (const t of defs.tasks) { const v = cellValues(defs, state, t); rows.push(cols.map(k => v[k])); }
  const rules = [
    ['CONTROL', 'RULE'],
    ['Mode', solo ? 'Solo: one agent (' + defs.ownerLabel + ') plans, works and completes every task. No sub-agents, no worker command.' : 'Team: ' + defs.ownerLabel + ' orchestrates; sub-agents only complete tasks assigned to them.'],
    ['Single owner', defs.ownerLabel + ' alone creates, edits, assigns, completes out of band, reopens tasks and changes the layout (edits tasks.json, then publishes).'],
    solo ? ['Completion', 'The agent completes a task with board-engine complete Tnnn --note "evidence" after the outcome is verified.']
      : ['Worker action', 'Only: node complete-task.cjs <boardDir> Tnnn, for an IN PROGRESS task assigned to the worker identity. No cell, text, status, file or ops input.'],
    ['Discuss with agent', 'Copy rows from this sheet into the agent chat, or type IDs (T002), row numbers (rows 13-16) or a description. The agent cross-references the published version via CLI/MCP and flags rows copied from an older view.'],
    ['Operator edits', 'Status, Scope and Done are dropdowns you may change here. The agent reads every change as your redirect before its next step (intake), records it in the log and republishes. For anything else (new task, rewording, reassignment), ask in chat.'],
    ['Completion meaning', 'Check a task only after its acceptance outcome is met and evidence is published.'],
    ['Done box', 'Done is a ' + DONE_ON + ' / ' + DONE_OFF + ' dropdown. Ticking it yourself tells the agent you accept the task as done; clearing a ticked box disputes the completion. The next publish strikes (or un-strikes) the task text.'],
    ['Integrity', 'Single-writer lock, pinned owner, definition/state/workbook SHA-256 pins, immutable versions; HEAD.json moves only after validation.'],
    ['Visible update', 'One live tab: each publish closes this tab, swaps in the new version and reopens it. Versions stay on disk for recovery; they are not opened.'],
    ['Protection', 'On Tasks, Status, Scope and Done are yours; other cells belong to the owner and edits there are reported, not applied. Rules, History and Context are protected. Workflow validation, not a security boundary.'],
    ['Session', defs.session || ''],
    ['STATUS', 'MEANING'],
    ...STATUSES.map(s => [s, STATUS_META[s].meaning]),
  ];
  const ops = [];
  const add = op => ops.push({ sheet: 'Tasks', ...op });
  add({ op: 'format_range', range: 'A1:' + last + n, format: { fontFamily: 'Aptos', fontSize: 11, verticalAlign: 'center', wrapText: true, fontColor: '#172B4D' } });
  for (let r = 1; r <= 3; r++) add({ op: 'merge_cells', range: 'A' + r + ':' + last + r });
  add({ op: 'format_range', range: 'A1:' + last + '1', format: { bold: true, fontSize: 20, fillColor: '#13233A', fontColor: '#FFFFFF' } });
  add({ op: 'format_range', range: 'A2:' + last + '3', format: { fillColor: '#E8EEF6', fontColor: '#304B6B' } });
  add({ op: 'format_range', range: 'A4:' + last + '4', format: { bold: true, fillColor: '#244568', fontColor: '#FFFFFF' } });
  cols.forEach((k, i) => add({ op: 'set_col_width', column: letter(i), widthPx: WIDTHS[k] }));
  add({ op: 'set_row_height', row: 1, heightPoints: 34 });
  add({ op: 'set_row_height', row: 2, count: 2, heightPoints: 23 });
  add({ op: 'set_row_height', row: 4, heightPoints: 27 });
  add({ op: 'set_row_height', row: FIRST_ROW, count: defs.tasks.length, heightPoints: 48 });
  const checkbox = defs.layout && defs.layout.doneControl === 'checkbox';
  add({ op: 'set_data_validation', range: L('done') + FIRST_ROW + ':' + L('done') + n, validation: checkbox ? { kind: 'checkbox' } : { kind: 'list', values: [DONE_ON, DONE_OFF] } });
  add({ op: 'set_data_validation', range: L('status') + FIRST_ROW + ':' + L('status') + n, validation: { kind: 'list', values: statusChoices(defs) } });
  const scopes = scopeChoices(defs);
  if (scopes.length) add({ op: 'set_data_validation', range: L('scope') + FIRST_ROW + ':' + L('scope') + n, validation: { kind: 'list', values: scopes } });
  add({ op: 'format_range', range: L('done') + FIRST_ROW + ':' + L('done') + n, format: { horizontalAlign: 'center' } });
  add({ op: 'set_freeze', rows: 4, columns: Math.max(cols.indexOf('id'), cols.indexOf('done')) + 1 });
  add({ op: 'set_filter', range: 'A4:' + last + n });
  defs.tasks.forEach((t, i) => {
    const r = i + FIRST_ROW, done = Boolean(state.done[t.id]);
    add({ op: 'format_range', range: 'A' + r + ':' + last + r, format: { fillColor: done ? '#EDF5EF' : i % 2 ? '#F3F6FA' : '#FFFFFF' } });
    if (done) add({ op: 'format_range', range: L('task') + r + ':' + L('task') + r, format: { strikethrough: true, fontColor: '#607D69' } });
    const cancelled = !done && t.status === 'CANCELLED';
    if (cancelled) add({ op: 'format_range', range: 'A' + r + ':' + last + r, format: { fillColor: '#F3F4F6', fontColor: '#9CA3AF', italic: true } });
    const color = done ? STATUS_META.DONE.color : (STATUS_META[t.status] || STATUS_META.TODO).color;
    add({ op: 'format_range', range: L('status') + r, format: { bold: true, fontColor: color } });
  });
  add({ op: 'set_page_setup', orientation: 'landscape', fitToWidth: 1, fitToHeight: 0, printTitles: '1:4', margins: 'narrow', printArea: 'A1:' + last + n });
  // Tasks stays unprotected so the operator can use the Status / Scope / Done dropdowns; intake reports any other edit.
  const ctx = [['ID', 'Task', 'Context / spec', 'Acceptance', 'Depends on', 'Working notes (latest)']];
  for (const t of defs.tasks) ctx.push([t.id, t.task, t.context || '', t.acceptance || '', (t.deps || []).join(', '), root ? notesFor(root, t.id, 3).map(x => String(x.at).slice(0, 16).replace('T', ' ') + ' ' + x.text).join('\n') : '']);
  const rn = rules.length;
  ops.push(
    { op: 'format_range', sheet: 'Rules', range: 'A1:B' + rn, format: { fontFamily: 'Aptos', fontSize: 11, wrapText: true, verticalAlign: 'center' } },
    { op: 'set_col_width', sheet: 'Rules', column: 'A', widthPx: 190 },
    { op: 'set_col_width', sheet: 'Rules', column: 'B', widthPx: 1050 },
    { op: 'set_row_height', sheet: 'Rules', row: 1, count: rn, heightPoints: 42 },
    { op: 'format_range', sheet: 'Rules', range: 'A1:B1', format: { bold: true, fillColor: '#13233A', fontColor: '#FFFFFF' } },
    { op: 'format_range', sheet: 'Rules', range: 'A' + (rn - STATUSES.length) + ':B' + (rn - STATUSES.length), format: { bold: true, fillColor: '#244568', fontColor: '#FFFFFF' } },
    ...STATUSES.map((s, i) => ({ op: 'format_range', sheet: 'Rules', range: 'A' + (rn - STATUSES.length + 1 + i), format: { bold: true, fontColor: STATUS_META[s].color } })),
    { op: 'protect_sheet', sheet: 'Rules', protected: true },
    { op: 'format_range', sheet: 'History', range: 'A1:F' + hist.length, format: { fontFamily: 'Aptos', fontSize: 10, wrapText: true, verticalAlign: 'top' } },
    { op: 'format_range', sheet: 'History', range: 'A1:F1', format: { bold: true, fillColor: '#13233A', fontColor: '#FFFFFF' } },
    { op: 'set_col_width', sheet: 'History', column: 'A', widthPx: 150 }, { op: 'set_col_width', sheet: 'History', column: 'B', widthPx: 250 },
    { op: 'set_col_width', sheet: 'History', column: 'C', widthPx: 110 }, { op: 'set_col_width', sheet: 'History', column: 'D', widthPx: 60 },
    { op: 'set_col_width', sheet: 'History', column: 'E', widthPx: 150 }, { op: 'set_col_width', sheet: 'History', column: 'F', widthPx: 700 },
    { op: 'set_freeze', sheet: 'History', rows: 1, columns: 0 },
    { op: 'protect_sheet', sheet: 'History', protected: true },
    { op: 'format_range', sheet: 'Context', range: 'A1:F' + ctx.length, format: { fontFamily: 'Aptos', fontSize: 10, wrapText: true, verticalAlign: 'top' } },
    { op: 'format_range', sheet: 'Context', range: 'A1:F1', format: { bold: true, fillColor: '#13233A', fontColor: '#FFFFFF' } },
    { op: 'set_col_width', sheet: 'Context', column: 'A', widthPx: 60 }, { op: 'set_col_width', sheet: 'Context', column: 'B', widthPx: 300 },
    { op: 'set_col_width', sheet: 'Context', column: 'C', widthPx: 560 }, { op: 'set_col_width', sheet: 'Context', column: 'D', widthPx: 360 },
    { op: 'set_col_width', sheet: 'Context', column: 'E', widthPx: 110 }, { op: 'set_col_width', sheet: 'Context', column: 'F', widthPx: 420 },
    { op: 'set_freeze', sheet: 'Context', rows: 1, columns: 1 },
    { op: 'protect_sheet', sheet: 'Context', protected: true },
  );
  return { data: { sheets: [{ name: 'Tasks', rows }, { name: 'Context', rows: ctx }, { name: 'Rules', rows: rules }, { name: 'History', rows: hist }] }, ops };
}
function workbookName(defs) {
  if (defs.workbookName) return defs.workbookName.replace(/[\\/:*?"<>|]/g, '-');
  return (defs.title.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'TASKLIST') + '.xlsx';
}

// ---------- publish ----------
function publish(boardDir, mode, id, actor, { open = true, note = null, operatorSignals = null } = {}) {
  const root = path.resolve(boardDir);
  if (!actor) throw new Error('No actor identity: set CODEX_THREAD_ID (Codex) or TASKBOARD_ACTOR (other agents). Never borrow another agent identity.');
  const lock = path.join(root, '.writer.lock');
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { throw new Error('Another writer holds ' + lock + '. No changes made. Do not delete a stale lock automatically; the owner investigates.'); }
  try {
    const raw = fs.readFileSync(path.join(root, 'tasks.json'), 'utf8');
    const defs = validateDefinitions(JSON.parse(raw));
    const hp = path.join(root, 'HEAD.json');
    const previous = fs.existsSync(hp) ? read(hp) : null;
    let owner = previous ? previous.ownerId : defs.ownerId;
    if (mode === 'adopt') {
      if (!previous) throw new Error('Board not initialized');
      if (defs.ownerId !== actor) throw new Error('adopt: set tasks.json ownerId to your own identity first');
      if (actor === owner) throw new Error('adopt: you already own this board');
      if (note === null || note.trim().length < 8) throw new Error('adopt needs --note quoting the operator instruction or handoff that authorizes the new owner');
      owner = actor;
    }
    if (mode === 'init') {
      if (previous) throw new Error('Board already initialized');
      if (actor !== owner) throw new Error('Only the owner named in tasks.json can initialize the board');
    } else if (!previous) throw new Error('Board not initialized');
    if (defs.ownerId !== owner) throw new Error('tasks.json ownerId differs from the pinned owner; ownership cannot change on an existing board');
    if (['reconcile', 'reopen', 'operator-intake'].includes(mode) && actor !== owner) throw new Error('Owner-only operation');
    if (note !== null && actor !== owner) throw new Error('Only the owner can attach a note');
    if (note !== null && (typeof note !== 'string' || note.length > 500)) throw new Error('Completion note must be text up to 500 characters');
    if (mode === 'complete' && previous.definitionsSha256 !== hash(raw)) throw new Error('Definition integrity mismatch; the owner must reconcile before completions');
    if (previous && hash(fs.readFileSync(previous.workbook)) !== previous.workbookSha256) throw new Error('Published workbook changed outside the taskboard; the owner must investigate');
    if (previous && hash(fs.readFileSync(path.join(root, previous.state))) !== previous.stateSha256) throw new Error('State integrity mismatch; the owner must investigate');
    const prevDefs = previous ? read(path.join(root, previous.state.replace(/state\.json$/, 'definitions.json'))) : null;
    const state = previous ? read(path.join(root, previous.state)) : { done: Object.fromEntries(defs.tasks.map(t => [t.id, Boolean(t.done) || t.status === 'DONE'])), notes: {}, events: [] };
    state.notes = state.notes || {};
    // Operator edits in the live sheet (Status / Scope / Done dropdowns, or any other cell) must be read before anything else publishes.
    if (previous && !['init', 'operator-intake'].includes(mode)) {
      const pend = operatorEdits(root, previous, prevDefs, state);
      if (pend.signals.length) throw new Error('The operator changed the live sheet (' + pend.signals.map(s => s.summary).join('; ') + '). ' + (actor === owner ? 'Run intake first: node board-engine.cjs "' + root + '" intake, then intake --apply.' : 'Wait for the owner to run intake; nothing was changed.'));
    }
    const at = new Date().toISOString();
    const rev = at.replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    const by = actorLabel(defs, actor, owner);
    const changes = ['init', 'reconcile', 'adopt'].includes(mode) ? diffDefinitions(prevDefs, defs) : [];
    if (mode === 'complete') {
      validateCompletion(defs, state, actor, id, owner);
      if (state.done[id] && note === null) return { status: 'already_complete', task: id, workbook: previous.workbook, live: previous.live };
      state.done[id] = true;
      if (note !== null) state.notes[id] = note;
      state.events.push({ task: id, actor, by, at, revision: rev, action: 'complete', changes: [id + ' checked and struck: ' + defs.tasks.find(t => t.id === id).task], ...(note !== null ? { note } : {}) });
    } else if (mode === 'reopen') {
      if (!defs.tasks.some(t => t.id === id)) throw new Error('Unknown task ID ' + id);
      state.done[id] = false;
      delete state.notes[id];
      state.events.push({ task: id, actor, by, at, revision: rev, action: 'reopen', changes: [id + ' unchecked'], ...(note !== null ? { note } : {}) });
    } else if (mode === 'reconcile' || mode === 'adopt') {
      for (const t of defs.tasks) {
        if (!(t.id in state.done)) state.done[t.id] = Boolean(t.done) || t.status === 'DONE';
        else if ((t.done || t.status === 'DONE') && !state.done[t.id]) state.done[t.id] = true;
      }
      for (const k of Object.keys(state.done)) if (!defs.tasks.some(t => t.id === k)) { delete state.done[k]; delete state.notes[k]; }
      if (mode === 'adopt') changes.unshift('owner ' + String(previous.ownerId || '').slice(0, 8) + ' -> ' + String(actor).slice(0, 8) + ' (' + defs.ownerLabel + ')');
      state.events.push({ actor, by, at, revision: rev, action: mode === 'adopt' ? 'adopt' : 'update', changes, definitionsSha256: hash(raw), ...(note !== null ? { note } : {}) });
    } else if (mode === 'init') {
      state.events.push({ actor, by, at, revision: rev, action: 'init', changes, mode: defs.mode || 'team', definitionsSha256: hash(raw) });
    } else if (mode === 'operator-intake') {
      for (const s of operatorSignals || []) if (s.applied && s.type === 'done' && defs.tasks.some(t => t.id === s.id)) { state.done[s.id] = s.to; if (!s.to) delete state.notes[s.id]; }
      for (const t of defs.tasks) if (!(t.id in state.done)) state.done[t.id] = Boolean(t.done) || t.status === 'DONE';
      for (const k of Object.keys(state.done)) if (!defs.tasks.some(t => t.id === k)) { delete state.done[k]; delete state.notes[k]; }
      const applied = (operatorSignals || []).filter(s => s.applied).map(s => s.summary);
      const reported = (operatorSignals || []).filter(s => !s.applied).map(s => 'reported, not applied: ' + s.summary);
      state.events.push({ actor: 'operator', by: 'Operator (GenOffice)', appliedBy: by, at, revision: rev, action: 'operator-edit', changes: [...applied, ...reported], definitionsSha256: hash(raw), ...(note !== null ? { note } : {}) });
    } else throw new Error('Unknown operation ' + mode);

    const dir = path.join(root, 'versions', rev);
    fs.mkdirSync(dir, { recursive: true });
    const { data, ops } = rowsAndOps(defs, state, rev, root);
    const dataPath = path.join(dir, 'table.json'), opsPath = path.join(dir, 'format.json'), book = path.join(dir, versionBookName(defs, rev));
    write(dataPath, data); write(opsPath, ops); write(path.join(dir, 'state.json'), state); write(path.join(dir, 'definitions.json'), defs);
    gen(['create', '--type', 'xlsx', '--from', dataPath, '--out', book]);
    gen(['sheet', 'apply', book, '--ops', opsPath]);
    const check = gen(['sheet', 'check', book]);
    const bad = (check.detail?.issues ?? []).filter(x => ['formula_error', 'missing_sheet_ref', 'number_overflow'].includes(x.code));
    if (bad.length) throw new Error('Workbook validation failed: ' + JSON.stringify(bad));
    write(path.join(dir, 'check.json'), check);
    if (hash(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')) !== hash(raw)) throw new Error('tasks.json changed during publish; HEAD not moved');
    const live = livePathFor(root, defs);
    const head = {
      revision: rev, mode: defs.mode || 'team', ownerId: owner, definitionsSha256: hash(raw),
      state: path.relative(root, path.join(dir, 'state.json')), stateSha256: hash(fs.readFileSync(path.join(dir, 'state.json'))),
      workbook: book, workbookSha256: hash(fs.readFileSync(book)), live,
      completed: Object.values(state.done).filter(Boolean).length, total: defs.tasks.length,
      cancelled: defs.tasks.filter(t => !state.done[t.id] && t.status === 'CANCELLED').length,
    };
    const next = path.join(root, 'HEAD.' + rev + '.tmp');
    write(next, head);
    fs.renameSync(next, hp);
    let logError = null;
    try { appendLog(root, defs, head, state.events[state.events.length - 1]); } catch (e) { logError = e.message; }
    let view;
    try { view = refreshLive(book, live, { open, rev, root, expectedLiveSha: previous ? previous.workbookSha256 : null, preserveDrift: mode === 'operator-intake', save: mode === 'operator-intake' }); } catch (e) { view = { live, liveUpdated: false, liveStale: true, reason: e.message }; }
    let autosave;
    if (mode === 'init') { try { autosave = ensureAutosave(defs); } catch (e) { autosave = { autosave: 'not changed', error: e.message }; } }
    return { status: 'ok', operation: mode, ...head, log: logPathFor(root, defs), ...(logError ? { logError } : {}), view, ...(autosave ? { autosave } : {}) };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

// ---------- read-only views ----------
function loadCurrent(boardDir) {
  const root = path.resolve(boardDir);
  const head = read(path.join(root, 'HEAD.json'));
  const state = read(path.join(root, head.state));
  const defs = read(path.join(root, head.state.replace(/state\.json$/, 'definitions.json')));
  const liveRaw = fs.readFileSync(path.join(root, 'tasks.json'), 'utf8');
  return { root, head, state, defs, definitionsCurrent: hash(liveRaw) === head.definitionsSha256 };
}
function status(boardDir) {
  const { head, state, defs, definitionsCurrent } = loadCurrent(boardDir);
  const liveSha = head.live && fs.existsSync(head.live) ? hash(fs.readFileSync(head.live)) : null;
  return {
    ...head, definitionsCurrent,
    workbookIntact: hash(fs.readFileSync(head.workbook)) === head.workbookSha256,
    liveMatchesHead: liveSha === head.workbookSha256, liveOpenInGui: head.live ? isOpenInGui(head.live) : false,
    readyToDispatch: defs.tasks.filter(t => !state.done[t.id] && ['READY', 'TODO'].includes(t.status) && (t.deps || []).every(d => state.done[d])).map(t => t.id),
    tasks: defs.tasks.map((t, i) => ({ id: t.id, row: i + FIRST_ROW, status: state.done[t.id] ? 'DONE' : t.status, done: Boolean(state.done[t.id]), worker: t.worker || null, deps: t.deps || [] })),
  };
}
const DONE_TRUE = /^(true|1|yes|x|\u2611|\u2713|\u2714)$/i;
const DONE_FALSE = /^(false|0|no|\u2610)$/i;
// Parse a row copied from GenOffice (tab-separated; whole-sheet copies pad to 26 columns and ~1000 rows).
// With the pasted header row the columns map exactly; without it, fields are recognized by shape.
function headerMap(text) {
  const line = String(text).split(/\r?\n/).find(l => /(^|\t)ID\t/.test(l) && /\tDone(\t|$)/.test(l) && /\tStatus(\t|$)/.test(l));
  if (!line) return null;
  const f = line.split('\t').map(s => s.trim());
  return { id: f.indexOf('ID'), done: f.indexOf('Done'), status: f.indexOf('Status') };
}
function parsePastedLine(line, map = null) {
  const fields = line.split('\t').map(s => s.trim());
  while (fields.length && fields[fields.length - 1] === '') fields.pop();
  if (fields.length < 2) return null;
  if (map) {
    const d = fields[map.done];
    return { fields, status: fields[map.status] || null, done: d === undefined || d === '' ? null : DONE_TRUE.test(d), byHeader: true };
  }
  const status = fields.find(f => STATUS.test(f) && !ID.test(f) && f.length > 2 && !DONE_TRUE.test(f) && !DONE_FALSE.test(f)) || null;
  const doneField = fields.find(f => DONE_TRUE.test(f) || DONE_FALSE.test(f));
  return { fields, status, done: doneField === undefined ? null : DONE_TRUE.test(doneField) };
}
// Bare numbers like "13-16", "rows 13 to 16", "row 7", "13, 14": GenOffice grid row numbers are what the operator sees.
function numbersIn(text) {
  const out = new Set();
  const t = String(text).replace(/\bT\d{3,4}\b/gi, ' ');
  for (const m of t.matchAll(/\b(\d{1,4})\s*(?:-|\u2013|\u2014|to|thru|through)\s*(\d{1,4})\b/gi)) {
    const a = Number(m[1]), b = Number(m[2]);
    if (Math.abs(b - a) <= 200) for (let r = Math.min(a, b); r <= Math.max(a, b); r++) out.add(r);
  }
  for (const m of t.matchAll(/\brows?\s+((?:\d{1,4}\s*(?:,|and|&)?\s*)+)/gi)) for (const n of m[1].match(/\d{1,4}/g)) out.add(Number(n));
  if (!out.size && /^\s*\d{1,4}(\s*,\s*\d{1,4})*\s*$/.test(t.split(/\r?\n/)[0] || '')) for (const n of t.match(/\d{1,4}/g)) out.add(Number(n));
  return [...out].sort((a, b) => a - b);
}
function tokens(s) { return (String(s).toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => !['the', 'and', 'for', 'with', 'task', 'this', 'that', 'from', 'row', 'rows'].includes(w)); }
function lookup(boardDir, query, { verify = true, limit = 5 } = {}) {
  const { head, state, defs, definitionsCurrent } = loadCurrent(boardDir);
  const cols = columnsOf(defs);
  const text = String(query || '');
  const ids = [...new Set((text.match(ID_ANY) || []).map(s => s.toUpperCase()))];
  let picked = ids.map(id => defs.tasks.find(t => t.id === id)).filter(Boolean);
  const unknownIds = ids.filter(id => !defs.tasks.some(t => t.id === id));
  let how = 'id', rowInterpretation;
  if (!ids.length) {
    const nums = numbersIn(text);
    if (nums.length) {
      const asRows = nums.map(r => defs.tasks[r - FIRST_ROW]).filter(Boolean);
      const asIds = nums.map(n => defs.tasks.find(t => t.id === 'T' + String(n).padStart(3, '0'))).filter(Boolean);
      picked = asRows.length ? asRows : asIds;
      how = asRows.length ? 'row-number' : 'id-number';
      const same = asRows.map(t => t.id).join() === asIds.map(t => t.id).join();
      rowInterpretation = {
        numbers: nums,
        asGridRows: asRows.map(t => t.id), asTaskIds: asIds.map(t => t.id),
        ambiguous: !same && asRows.length > 0 && asIds.length > 0,
        say: asRows.length ? 'rows ' + nums.join(', ') + ' = ' + asRows.map(t => t.id).join(', ') : undefined,
      };
    }
  }
  if (!picked.length) {
    how = 'text';
    const q = new Set(tokens(text));
    picked = defs.tasks.map(t => {
      const words = tokens([t.task, t.scope, t.evidence, t.workerLabel].join(' '));
      const hits = words.filter(w => q.has(w)).length;
      return { t, score: q.size ? hits / Math.sqrt(words.length + 1) : 0 };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.t);
  }
  const lines = text.split(/\r?\n/);
  const map = headerMap(text);
  const pastedRevision = (text.match(/Revision (\d{4}-\d{2}-\d{2}T[\w-]+)/) || [])[1] || null;
  const matches = picked.map(t => {
    const i = defs.tasks.indexOf(t), row = i + FIRST_ROW, v = cellValues(defs, state, t);
    const m = {
      id: t.id, row, cells: 'Tasks!A' + row + ':' + letter(cols.length - 1) + row, task: t.task, scope: v.scope, status: v.status, done: v.doneFlag,
      worker: t.worker || null, workerLabel: v.worker, evidence: v.evidence, context: t.context || '', acceptance: t.acceptance || '', deps: t.deps || [],
      notes: notesFor(path.resolve(boardDir), t.id, 5), history: state.events.filter(e => e.task === t.id),
    };
    const pastedLine = lines.find(l => new RegExp('\\b' + t.id + '\\b', 'i').test(l) && l.includes('\t'));
    if (pastedLine) {
      const p = parsePastedLine(pastedLine, map);
      if (p) {
        const differs = [];
        if (p.status && p.status !== m.status) differs.push('status pasted ' + p.status + ', current ' + m.status);
        if (p.done !== null && p.done !== m.done) differs.push('done pasted ' + p.done + ', current ' + m.done);
        m.pasted = { status: p.status, done: p.done, staleOrForeign: differs.length > 0, differences: differs };
      }
    }
    return m;
  });
  if (verify && matches.length) {
    const rows = matches.map(m => m.row), lo = Math.min(...rows), hi = Math.max(...rows);
    const r = gen(['sheet', 'read', head.workbook, '--sheet', 'Tasks', '--range', 'A' + lo + ':' + letter(cols.length - 1) + hi]);
    const values = r.detail?.rows || [];
    const ci = k => cols.indexOf(k);
    for (const m of matches) {
      const v = values[m.row - lo] || [];
      const wv = v[ci('done')];
      const wdone = wv === true || wv === 1 || (typeof wv === 'string' && DONE_TRUE.test(wv.trim()));
      m.workbook = { id: v[ci('id')], done: wdone, status: v[ci('status')] };
      m.workbookMatches = v[ci('id')] === m.id && wdone === m.done && v[ci('status')] === m.status;
    }
  }
  const pastedRows = matches.filter(m => m.pasted);
  const pasted = pastedRows.length || pastedRevision ? {
    rows: pastedRows.length, headerMapped: Boolean(map), revision: pastedRevision,
    viewIsCurrent: pastedRevision ? pastedRevision === head.revision : null,
    differing: pastedRows.filter(m => m.pasted.staleOrForeign).map(m => m.id),
  } : undefined;
  return { revision: head.revision, mode: head.mode || 'team', workbook: head.workbook, live: head.live, columns: cols.map((k, i) => letter(i) + '=' + k).join(' '), pasted,
    definitionsCurrent, matchedBy: how, rowInterpretation, unknownIds, matches,
    note: definitionsCurrent ? undefined : 'tasks.json has unpublished edits; the workbook shows the last published version' };
}
function rowsFromRange(range) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(String(range || '').replace(/^.*!/, ''));
  if (!m) return [];
  const a = Number(m[2]), b = Number(m[4] || m[2]);
  const out = [];
  for (let r = Math.min(a, b); r <= Math.max(a, b); r++) out.push(r);
  return out;
}
// Create a new session board: <project>/GenOffice_XLSX_Tasklist/Genofficetasklist<MMDDYY><Tree>/tasks.json (owner = this agent).
// Never overwrites; each session gets the next unused tree name for that date.
function scaffold(projectRoot, actor, { solo = false, title = null, tree = null, date = new Date() } = {}) {
  if (!actor) throw new Error('No actor identity: set CODEX_THREAD_ID (Codex) or TASKBOARD_ACTOR (other agents).');
  const proj = path.resolve(projectRoot);
  if (!fs.existsSync(proj) || !fs.statSync(proj).isDirectory()) throw new Error('Project root not found: ' + proj);
  const folder = path.join(proj, BOARD_FOLDER);
  fs.mkdirSync(folder, { recursive: true });
  const session = sessionNameFor(folder, date, tree);
  const board = path.join(folder, session);
  fs.mkdirSync(board);
  const name = path.basename(proj).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toUpperCase() || 'PROJECT';
  const defs = {
    title: title || name + ' | ' + session, mode: solo ? 'solo' : 'team', ownerId: actor, ownerLabel: solo ? 'Agent' : 'Orchestrator',
    session, sessionOwner: actor, workbookName: session + '.xlsx',
    layout: { columns: COLUMN_KEYS },
    tasks: [{ id: 'T001', task: 'Replace with the first acceptance outcome', scope: '', status: 'TODO', evidence: '' }],
  };
  write(path.join(board, 'tasks.json'), defs);
  if (!fs.existsSync(path.join(folder, '.gitignore'))) fs.writeFileSync(path.join(folder, '.gitignore'), '*/versions/\n*/operator-edits/\n*/.writer.lock\n*/HEAD.*.tmp\n');
  return { session, board, tasks: path.join(board, 'tasks.json'), live: path.join(folder, defs.workbookName), log: path.join(folder, session + '.md'), next: 'edit tasks.json, then: node board-engine.cjs "' + board + '" init' };
}
function selection(boardDir, opts = {}) {
  const { head, defs } = loadCurrent(boardDir);
  const file = head.live && isOpenInGui(head.live) ? head.live : head.workbook;
  const s = gen(['selection', file]);
  if (s.detail?.sheet && s.detail.sheet !== 'Tasks') return { revision: head.revision, selection: s.detail, matches: [], note: 'Selection is on sheet ' + s.detail.sheet + ', not Tasks' };
  const ids = rowsFromRange(s.detail?.range).map(r => defs.tasks[r - FIRST_ROW]).filter(Boolean).map(t => t.id);
  const out = ids.length ? lookup(boardDir, ids.join(' '), opts) : { revision: head.revision, matches: [], note: 'No task rows in the selection' };
  return { ...out, selection: { file, sheet: s.detail?.sheet, range: s.detail?.range } };
}

// ---------- operator edits in the live sheet (Status / Scope / Done dropdowns and any other cell) ----------
// Read the live grid from the open editor (includes unsaved edits) or from the live file.
function liveGrid(head, defs) {
  const cols = columnsOf(defs);
  const range = 'A4:' + letter(cols.length - 1) + (defs.tasks.length + FIRST_ROW - 1 + 10);
  if (head.live && isOpenInGui(head.live)) {
    try {
      gen(['open', head.live, '--range', 'Tasks!' + range]);
      const s = gen(['selection', head.live]);
      if (s.detail && s.detail.sheet === 'Tasks' && Array.isArray(s.detail.values)) return { source: 'editor', rows: s.detail.values };
    } catch {}
  }
  if (head.live && fs.existsSync(head.live)) {
    if (hash(fs.readFileSync(head.live)) === head.workbookSha256) return { source: 'file-unchanged', rows: null };
    const r = gen(['sheet', 'read', head.live, '--sheet', 'Tasks', '--range', range]);
    return { source: 'file', rows: r.detail?.rows || [] };
  }
  return { source: 'none', rows: null };
}
const MEANING = {
  'TODO': 'Not now: back to the backlog.', 'READY': 'Clear to start: pick it up.', 'IN PROGRESS': 'Start or resume it now.',
  'IN REVIEW': 'The operator wants to review it before it counts as done.', 'VERIFYING': 'The operator wants the real end-to-end proof before done.',
  'WAITING': 'Pause: it depends on something external.', 'BLOCKED': 'The operator says it cannot proceed: find out why before continuing.',
  'DECISION NEEDED': 'Stop and ask: the operator wants a decision point before you act.', 'ON HOLD': 'Stop working it until the operator releases it.',
  'CANCELLED': 'Drop it: do not do this task.',
};
function meaningOf(s) {
  if (s.type === 'status') return MEANING[s.to] || 'Custom status from the operator: treat it as a redirect and confirm what it means.';
  if (s.type === 'done') return s.to ? 'The operator accepts it as done: stop work on it.' : 'The operator disputes the completion: reopen it and re-verify with evidence.';
  if (s.type === 'scope') return 'Redirect: the task now belongs to "' + s.to + '"; re-plan where and by whom it runs.';
  if (s.type === 'text') return 'The operator rewrote this cell: treat it as clarified intent; confirm in chat if unclear.';
  if (s.type === 'new-row') return 'The operator is asking for a new task.';
  if (s.type === 'row-removed') return 'The operator removed this task from view: confirm whether to cancel it (never delete it silently).';
  return '';
}
function operatorEdits(root, head, defs, state) {
  const g = liveGrid(head, defs);
  if (!g.rows) return { source: g.source, signals: [] };
  const cols = columnsOf(defs);
  const str = x => (x === null || x === undefined ? '' : String(x).trim());
  const header = (g.rows[0] || []).map(str);
  const headerText = { ...HEADERS, worker: isSolo(defs) ? 'Owner' : HEADERS.worker };
  const idx = {};
  for (const k of cols) { const h = header.indexOf(headerText[k]); idx[k] = h >= 0 ? h : cols.indexOf(k); }
  const byId = new Map(defs.tasks.map(t => [t.id, t]));
  const seen = new Set(), signals = [];
  for (const row of g.rows.slice(1)) {
    const cells = (row || []).map(str);
    if (!cells.some(Boolean)) continue;
    const id = (cells[idx.id] || '').toUpperCase();
    const t = byId.get(id);
    if (!t) { signals.push({ type: 'new-row', id: id || null, cells, summary: 'operator added a row: ' + cells.filter(Boolean).join(' | ').slice(0, 200) }); continue; }
    seen.add(id);
    const exp = cellValues(defs, state, t);
    const rawDone = row[idx.done];
    let liveDone = rawDone === true || rawDone === 1 || DONE_TRUE.test(str(rawDone));
    const ls = (cells[idx.status] || '').toUpperCase();
    if (ls === 'DONE' && !exp.doneFlag) liveDone = true;
    if (exp.doneFlag && ls && ls !== 'DONE') liveDone = false;
    if (liveDone !== exp.doneFlag) signals.push({ type: 'done', id, from: exp.doneFlag, to: liveDone, summary: id + (liveDone ? ' marked done by the operator' : ' un-done by the operator (completion disputed)') });
    if (ls && ls !== 'DONE' && ls !== exp.status) signals.push({ type: 'status', id, from: exp.status, to: ls, summary: id + ' status ' + exp.status + ' -> ' + ls + ' by the operator' });
    if ((cells[idx.scope] || '') !== exp.scope) signals.push({ type: 'scope', id, from: exp.scope, to: cells[idx.scope] || '', summary: id + ' scope "' + exp.scope + '" -> "' + (cells[idx.scope] || '') + '" by the operator' });
    for (const k of ['task', 'worker', 'evidence']) if ((cells[idx[k]] || '') !== str(exp[k])) signals.push({ type: 'text', id, field: k, from: str(exp[k]), to: cells[idx[k]] || '', summary: id + ' ' + k + ' edited by the operator: "' + (cells[idx[k]] || '').slice(0, 120) + '"' });
  }
  for (const t of defs.tasks) if (!seen.has(t.id)) signals.push({ type: 'row-removed', id: t.id, summary: t.id + ' row removed or its ID cleared by the operator' });
  for (const s of signals) s.meaning = meaningOf(s);
  return { source: g.source, signals };
}
// Owner reads (and with apply=true, adopts) the operator's edits. Operator authority wins on Status / Scope / Done;
// text edits and new rows are only adopted with applyText; removed rows are never deleted automatically.
function intake(boardDir, actor, { apply = false, applyText = false, note = null, open = true } = {}) {
  const { root, head, state, defs, definitionsCurrent } = loadCurrent(boardDir);
  if (actor !== head.ownerId) throw new Error('Owner-only: the orchestrator (or lone agent) reads the operator edits');
  const res = operatorEdits(root, head, defs, state);
  if (!res.signals.length) return { status: 'no-operator-edits', source: res.source, revision: head.revision };
  if (!apply) return { status: 'operator-edits', source: res.source, revision: head.revision, signals: res.signals,
    next: 'Each signal is the operator redirecting you. Say how you read them, then run intake --apply (add --apply-text to adopt text edits and new rows).' };
  const tp = path.join(root, 'tasks.json');
  const live = JSON.parse(fs.readFileSync(tp, 'utf8'));
  let nextNum = Math.max(0, ...live.tasks.map(t => Number(t.id.slice(1)))) + 1;
  for (const s of res.signals) {
    const t = s.id ? live.tasks.find(x => x.id === s.id) : null;
    if (s.type === 'status' && t) { t.status = s.to; delete t.done; s.applied = true; }
    else if (s.type === 'done' && t) { if (!s.to) { delete t.done; if (t.status === 'DONE') t.status = 'IN PROGRESS'; } s.applied = true; }
    else if (s.type === 'scope' && t) { t.scope = s.to; s.applied = true; }
    else if (applyText && s.type === 'text' && t && s.field !== 'worker') { t[s.field] = s.to; s.applied = true; }
    else if (applyText && s.type === 'new-row') {
      const txt = s.cells.filter(c => c && !ID.test(c.toUpperCase()) && !STATUS.test(c) && !DONE_TRUE.test(c) && !DONE_FALSE.test(c)).sort((a, b) => b.length - a.length)[0];
      if (txt) { const newId = 'T' + String(nextNum++).padStart(3, '0'); live.tasks.push({ id: newId, task: txt, scope: '', status: 'TODO', evidence: 'added by the operator in GenOffice' }); s.applied = true; s.newId = newId; s.summary += ' -> ' + newId; }
    } else s.applied = false;
  }
  validateDefinitions(live);
  const tmp = tp + '.' + crypto.randomBytes(3).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(live, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, tp);
  const out = publish(root, 'operator-intake', null, actor, { open, note: note !== null ? note : (definitionsCurrent ? null : 'owner edits pending in tasks.json were published in the same revision'), operatorSignals: res.signals });
  return { ...out, source: res.source, signals: res.signals };
}

// ---------- worker / solo view and context offload ----------
function mine(boardDir, actor) {
  const { root, head, state, defs } = loadCurrent(boardDir);
  const owner = actor === head.ownerId, solo = isSolo(defs);
  const list = defs.tasks.filter(t => owner || (!solo && t.worker === actor));
  const engine = path.join(__dirname, 'board-engine.cjs'), helper = path.join(__dirname, 'complete-task.cjs');
  return {
    board: root, revision: head.revision, live: head.live,
    you: owner ? (solo ? 'solo agent (owner)' : 'orchestrator (owner)') : list.length ? 'worker' : 'unknown identity: no tasks assigned to it',
    rules: owner ? ['Edit tasks.json with apply_patch, then reconcile.', 'Run intake before each step: operator dropdown edits are redirects.', 'Offload working context with note Tnnn "..."; reload it with lookup Tnnn.']
      : ['Do only the tasks listed here, in dependency order.', 'Publish your evidence in your own output first.', 'Complete with the completeCommand; you cannot add or edit tasks.', 'Blocked or unsure: stop and tell the orchestrator BLOCKED Tnnn (or COMPLETE Tnnn) plus evidence.'],
    tasks: list.map(t => ({
      id: t.id, task: t.task, status: state.done[t.id] ? 'DONE' : t.status, done: Boolean(state.done[t.id]), scope: t.scope || '',
      context: t.context || '', acceptance: t.acceptance || '', deps: t.deps || [], depsDone: (t.deps || []).every(d => state.done[d]), evidence: t.evidence || '', notes: notesFor(root, t.id, 5),
      canComplete: !state.done[t.id] && (owner || t.status === 'IN PROGRESS'),
      completeCommand: owner ? 'node "' + engine + '" "' + root + '" complete ' + t.id + ' --note "<evidence>"' : 'node "' + helper + '" "' + root + '" ' + t.id,
    })),
  };
}
function note(boardDir, actor, id, text) {
  const { root, head, defs } = loadCurrent(boardDir);
  if (actor !== head.ownerId) throw new Error('Owner-only: workers report findings to the orchestrator instead');
  if (!defs.tasks.some(t => t.id === id)) throw new Error('Unknown task ID ' + id);
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new Error('Note text required (up to 4000 characters)');
  const entry = { at: new Date().toISOString(), id, by: defs.ownerLabel, text: text.trim() };
  fs.appendFileSync(path.join(root, 'notes.jsonl'), JSON.stringify(entry) + '\n');
  fs.appendFileSync(logPathFor(root, defs), '\n- ' + entry.at + ' | note ' + id + ' | ' + entry.by + ': ' + entry.text.replace(/\s+/g, ' ').slice(0, 500) + '\n');
  fs.appendFileSync(path.join(root, 'history.jsonl'), JSON.stringify({ ...entry, action: 'note' }) + '\n');
  return { status: 'noted', ...entry, shownIn: 'lookup/mine now; Context sheet at the next publish' };
}


module.exports = { publish, status, lookup, selection, tidy, scaffold, intake, operatorEdits, mine, note, meaningOf, closeTab, openPaths, refreshLive, ensureAutosave, livePathFor, logPathFor, sessionNameFor, diffDefinitions, historyRows, parsePastedLine, numbersIn, rowsFromRange, validateDefinitions, validateCompletion, rowsAndOps, cellValues, resolveGenoffice, STATUSES, STATUS_META, COLUMN_KEYS, BOARD_FOLDER, TREES, DONE_ON, DONE_OFF };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const take = name => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v === undefined ? '' : v; };
  const flagOn = name => { const i = argv.indexOf(name); if (i < 0) return false; argv.splice(i, 1); return true; };
  const noOpen = flagOn('--no-open'), noVerify = flagOn('--no-verify'), solo = flagOn('--solo'), applyEdits = flagOn('--apply'), applyText = flagOn('--apply-text');
  const note = take('--note'), file = take('--file'), title = take('--title'), tree = take('--tree');
  const [dir, mode, ...rest] = argv;
  const actor = process.env.TASKBOARD_ACTOR || process.env.CODEX_THREAD_ID;
  try {
    if (!dir || !mode) throw new Error('Usage: node board-engine.cjs <projectRoot> scaffold [--solo] [--title ".."]  |  node board-engine.cjs <boardDir> init | reconcile [--note ".."] | adopt --note "<operator instruction>" | complete Tnnn [--note ".."] | reopen Tnnn | intake [--apply [--apply-text]] | mine | note Tnnn "<text>" | status | selection | tidy | lookup "<pasted rows | IDs | row numbers | words>" | lookup - | lookup --file <path>   [--no-open] [--no-verify]');
    let out;
    if (mode === 'scaffold') out = scaffold(dir, actor, { solo, title, tree });
    else if (mode === 'intake') out = intake(dir, actor, { apply: applyEdits || applyText, applyText, note, open: !noOpen });
    else if (mode === 'mine') out = mine(dir, actor);
    else if (mode === 'note') out = note(dir, actor, rest[0], rest.slice(1).join(' '));
    else if (mode === 'status') out = status(dir);
    else if (mode === 'pdf') { const c = loadCurrent(dir); const outPdf = c.head.live.replace(/\.xlsx$/i, '.pdf'); gen(['convert', c.head.workbook, '--to', 'pdf', '--out', outPdf, '--force']); out = { status: 'ok', pdf: outPdf, revision: c.head.revision }; }
    else if (mode === 'selection') out = selection(dir, { verify: !noVerify });
    else if (mode === 'tidy') out = tidy(dir);
    else if (mode === 'lookup') {
      const q = file ? fs.readFileSync(file, 'utf8') : rest[0] === '-' ? fs.readFileSync(0, 'utf8') : rest.join(' ');
      out = lookup(dir, q, { verify: !noVerify });
    } else out = publish(dir, mode, rest[0], actor, { open: !noOpen, note });
    console.log(JSON.stringify(out, null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
