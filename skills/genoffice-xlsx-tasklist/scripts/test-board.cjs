'use strict';
// Unit checks (no GenOffice needed).
//   --e2e  : full publish/complete/lookup/tamper cycle through the GenOffice CLI, no GUI tabs.
//   --live : also proves the single-tab refresh in the running GenOffice app (opens, refreshes and finally closes one tab).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const E = require(path.join(__dirname, 'board-engine.cjs'));

const team = { title: 'Fixture board', ownerId: 'owner-1', ownerLabel: 'Owner', tasks: [
  { id: 'T001', task: 'Released task', status: 'IN PROGRESS', worker: 'worker-a', workerLabel: 'Worker A' },
  { id: 'T002', task: 'Blocked teardown of lane', status: 'BLOCKED', worker: 'worker-a' },
  { id: 'T003', task: 'Owner task for Laya decider coverage', status: 'TODO' },
  { id: 'T004', task: 'Spec only translator schema', status: 'SPEC READY' } ] };
E.validateDefinitions(team);
assert.throws(() => E.validateDefinitions({ ...team, tasks: [...team.tasks, { id: 'T001', task: 'dup', status: 'TODO' }] }), /Duplicate/);
assert.throws(() => E.validateDefinitions({ ...team, tasks: [{ id: '../x', task: 'x', status: 'TODO' }] }), /Bad task id/);
assert.throws(() => E.validateDefinitions({ ...team, tasks: [{ id: 'T009', task: 'x', status: 'maybe' }] }), /UPPERCASE/);
assert.throws(() => E.validateDefinitions({ ...team, layout: { columns: ['id', 'done'] } }), /permutation/);
assert.throws(() => E.validateDefinitions({ ...team, mode: 'solo' }), /solo boards have no workers/);
const st = { done: { T001: false, T002: false, T003: false, T004: false }, notes: {} };
assert.throws(() => E.validateCompletion(team, st, 'worker-b', 'T001', 'owner-1'), /not assigned/);
assert.throws(() => E.validateCompletion(team, st, 'worker-a', 'T002', 'owner-1'), /not released/);
assert.equal(E.validateCompletion(team, st, 'owner-1', 'T003', 'owner-1').id, 'T003');
const solo = { title: 'Solo', ownerId: 'agent-1', ownerLabel: 'Agent', mode: 'solo', tasks: [{ id: 'T001', task: 'Do it', status: 'TODO' }] };
assert.throws(() => E.validateCompletion(solo, { done: {} }, 'someone', 'T001', 'agent-1'), /Solo board/);
// Paul's layout: B = Status, E = Done (swap persists through every publish)
const swapped = { ...team, layout: { columns: ['id', 'status', 'task', 'scope', 'done', 'worker', 'evidence'] } };
st.done.T001 = true;
const b = E.rowsAndOps(swapped, st, 'rev-x');
assert.deepEqual(b.data.sheets[0].rows[3].slice(0, 5), ['ID', 'Status', 'Task / acceptance outcome', 'Host / scope', 'Done']);
assert.equal(b.data.sheets[0].rows[4][4], E.DONE_ON);
// Session names: Genofficetasklist<MMDDYY><Tree>, next unused tree in the project folder for that date
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gxt-names-'));
  const d = new Date(2026, 8, 27);
  assert.equal(E.sessionNameFor(tmp, d), 'Genofficetasklist092726Ponderosa');
  fs.writeFileSync(path.join(tmp, 'Genofficetasklist092726Ponderosa.xlsx'), '');
  fs.mkdirSync(path.join(tmp, 'Genofficetasklist092726Douglas'));
  assert.equal(E.sessionNameFor(tmp, d), 'Genofficetasklist092726Redwood');
  assert.equal(E.sessionNameFor(tmp, d, 'madrone'), 'Genofficetasklist092726Madrone');
  assert.equal(E.TREES.length, 10);
}
assert.ok(b.ops.some(o => o.op === 'set_data_validation' && o.range === 'E5:E8'));
assert.ok(b.ops.some(o => o.range === 'C5:C5' && o.format && o.format.strikethrough));
assert.ok(String(b.data.sheets[0].rows[1][0]).includes('Revision rev-x'));
// Pasted GenOffice rows (tab separated, trailing empty cells, custom statuses), either layout
assert.deepEqual((({ status, done }) => ({ status, done }))(E.parsePastedLine('T009\tFALSE\tResolve Laya\tlocalJEV\tDECISION NEEDED\tCaptain / unassigned\t512 tokens\t\t\t')), { status: 'DECISION NEEDED', done: false });
assert.deepEqual((({ status, done }) => ({ status, done }))(E.parsePastedLine('T014\tBLOCKED\tTeardown authorized model services\tKAKASHI')), { status: 'BLOCKED', done: null });
assert.deepEqual((({ status, done }) => ({ status, done }))(E.parsePastedLine('T001\tDONE\tRecord roster\tAll six\t1\tCaptain')), { status: 'DONE', done: true });
assert.deepEqual(E.numbersIn('13-16 on task list should be at spec level'), [13, 14, 15, 16]);
assert.deepEqual(E.numbersIn('rows 7 and 9'), [7, 9]);
assert.deepEqual(E.numbersIn('T013 please'), []);
assert.ok(E.diffDefinitions(team, swapped).some(c => c.startsWith('layout A=id B=status')));
assert.deepEqual(b.data.sheets.map(s => s.name), ['Tasks', 'Context', 'Rules', 'History']);
// B, D, E (Status, Scope, Done in either layout) are operator dropdowns; Tasks stays editable, the other sheets are protected
const bs = E.rowsAndOps({ ...swapped, scopes: ['KAKASHI', 'OBITO'] }, st, 'r');
const dv = r => bs.ops.find(o => o.op === 'set_data_validation' && o.range === r);
assert.deepEqual(dv('E5:E8').validation, { kind: 'list', values: [E.DONE_ON, E.DONE_OFF] });
assert.ok(E.STATUSES.every(s => dv('B5:B8').validation.values.includes(s)) && dv('B5:B8').validation.values.includes('SPEC READY'));
assert.deepEqual(dv('D5:D8').validation.values, ['KAKASHI', 'OBITO']);
assert.ok(!bs.ops.some(o => o.op === 'protect_sheet' && (o.sheet === 'Tasks' || o.sheet === undefined)));
assert.deepEqual(bs.ops.filter(o => o.op === 'protect_sheet').map(o => o.sheet).sort(), ['Context', 'History', 'Rules']);
assert.equal(E.rowsAndOps({ ...swapped, layout: { ...swapped.layout, doneControl: 'checkbox' } }, st, 'r').ops.find(o => o.op === 'set_data_validation' && o.range === 'E5:E8').validation.kind, 'checkbox');
assert.throws(() => E.validateDefinitions({ ...team, tasks: [{ id: 'T001', task: 'x', status: 'TODO', deps: ['T009'] }] }), /unknown task T009/);
assert.ok(/redirect/i.test(E.meaningOf({ type: 'scope', to: 'KAKASHI' })) && /Stop working/.test(E.meaningOf({ type: 'status', to: 'ON HOLD' })));
// Eleven progress states; CANCELLED greyed (not struck); legend on the Rules sheet
assert.equal(E.STATUSES.length, 11);
for (const s of ['READY', 'IN REVIEW', 'VERIFYING', 'WAITING', 'ON HOLD', 'CANCELLED']) assert.ok(E.STATUSES.includes(s), s);
const withCancel = { ...team, tasks: [...team.tasks, { id: 'T006', task: 'Dropped idea', status: 'CANCELLED' }] };
const bc = E.rowsAndOps(withCancel, { done: {}, notes: {}, events: [] }, 'r');
assert.ok(bc.ops.some(o => o.range === 'A9:G9' && o.format && o.format.italic && o.format.fontColor === '#9CA3AF'));
assert.ok(!bc.ops.some(o => o.range === 'C9:C9' && o.format && o.format.strikethrough));
const legend = bc.data.sheets[2].rows.map(r => r[0]);
assert.ok(E.STATUSES.every(s => legend.includes(s)));
// A real whole-sheet copy from GenOffice (26 padded columns, header row, revision line, TRUE/FALSE checkboxes)
const realPaste = fs.readFileSync(path.join(__dirname, 'fixtures', 'genoffice-whole-sheet-paste.txt'), 'utf8');
assert.deepEqual(E.parsePastedLine(realPaste.split('\n')[5], { id: 0, done: 4, status: 1 }).done, false);
assert.equal(E.parsePastedLine(realPaste.split('\n')[4]).status, 'DONE');
{ // GenOffice autosave default, against a throwaway userData folder
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'gxt-userdata-'));
  fs.writeFileSync(path.join(ud, 'app-settings.json'), JSON.stringify({ onboardingSeen: true }));
  const saved = process.env.GENOFFICE_USER_DATA; process.env.GENOFFICE_USER_DATA = ud;
  try {
    assert.equal(E.ensureAutosave(team).autosave, 'turned on');
    const s = JSON.parse(fs.readFileSync(path.join(ud, 'app-settings.json'), 'utf8'));
    assert.equal(s.autoSaveDefault, true); assert.equal(s.onboardingSeen, true);
    assert.equal(E.ensureAutosave(team).autosave, 'already on');
    assert.equal(E.ensureAutosave({ ...team, autosave: false }).autosave, 'left as is (opted out)');
  } finally { if (saved === undefined) delete process.env.GENOFFICE_USER_DATA; else process.env.GENOFFICE_USER_DATA = saved; }
}
console.log('PASS unit: validation, solo, layout swap, revision stamp, pasted rows, row numbers, change diff, History sheet, autosave default');

if (process.argv.includes('--e2e') || process.argv.includes('--live')) {
  const live = process.argv.includes('--live');
  if (!live) process.env.GENOFFICE_TASKLIST_NO_AUTOSAVE = '1';
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'genoffice-tasklist-e2e-'));
  const sc = E.scaffold(project, 'owner-1', { title: 'Fixture board' });
  const board = sc.board;
  assert.equal(path.basename(path.dirname(board)), 'GenOffice_XLSX_Tasklist');
  assert.ok(/^Genofficetasklist\d{6}Ponderosa$/.test(sc.session), sc.session);
  assert.ok(/Genofficetasklist\d{6}Douglas$/.test(E.scaffold(project, 'owner-1').session), 'second session that day gets the next tree');
  fs.writeFileSync(path.join(board, 'tasks.json'), JSON.stringify({ ...swapped, workbookName: sc.session + '.xlsx', session: sc.session }, null, 2));
  const logFile = sc.log;
  const pub = (mode, id, actor, extra = {}) => E.publish(board, mode, id, actor, { open: live, ...extra });
  assert.throws(() => pub('init', null, 'worker-a'), /Only the owner/);
  const v1 = pub('init', null, 'owner-1');
  assert.equal(v1.completed, 0);
  assert.equal(v1.live, path.join(path.dirname(board), sc.session + '.xlsx'), 'Genofficetasklist<date><tree>.xlsx sits in GenOffice_XLSX_Tasklist');
  assert.equal(v1.log, logFile);
  assert.ok(fs.existsSync(logFile), 'Genofficetasklist<date><tree>.md sits beside it');
  assert.throws(() => pub('complete', 'T001', 'worker-b'), /not assigned/);
  const w = cp.spawnSync(process.execPath, [path.join(__dirname, 'complete-task.cjs'), board, 'T001'].concat(live ? [] : ['--no-open']), { env: { ...process.env, CODEX_THREAD_ID: 'worker-a' }, encoding: 'utf8' });
  assert.equal(w.status, 0, w.stderr);
  const v2 = JSON.parse(w.stdout);
  assert.equal(v2.completed, 1);
  assert.equal(pub('complete', 'T001', 'worker-a').status, 'already_complete');
  // Operator conversation: pasted rows (one stale), typed row numbers, typed words, IDs
  const L1 = E.lookup(board, 'T001\tIN PROGRESS\tReleased task\t\tFALSE\tWorker A\t\nT002\tBLOCKED\tBlocked teardown of lane');
  assert.equal(L1.matchedBy, 'id');
  assert.equal(L1.matches[0].pasted.staleOrForeign, true);
  assert.equal(L1.matches[1].pasted.staleOrForeign, false);
  assert.ok(L1.matches.every(m => m.workbookMatches), 'workbook row agrees with state');
  const L2 = E.lookup(board, '6-7 should be at spec level');
  assert.deepEqual(L2.rowInterpretation.asGridRows, ['T002', 'T003']);
  assert.deepEqual(L2.rowInterpretation.asTaskIds, []);
  const L3 = E.lookup(board, 'what is going on with the laya decider?', { verify: false });
  assert.equal(L3.matches[0].id, 'T003');
  // Whole-sheet paste: the old fixture's revision is not current; a fresh copy of the current header is current
  const Lold = E.lookup(board, realPaste, { verify: false });
  assert.equal(Lold.pasted.headerMapped, true);
  assert.equal(Lold.pasted.viewIsCurrent, false);
  const cur = E.status(board);
  const freshPaste = 'Fixture board\t\t\nOwner: Owner | Completion-only workers | Revision ' + cur.revision + '\t\t\nID\tStatus\tTask / acceptance outcome\tHost / scope\tDone\tAssigned worker\tEvidence / dependency\t\t\nT001\tDONE\tReleased task\t\tTRUE\tWorker A\t\t\t\nT002\tBLOCKED\tBlocked teardown of lane\t\tFALSE\tAssigned worker\t\t\t';
  const Lfresh = E.lookup(board, freshPaste, { verify: false });
  assert.equal(Lfresh.pasted.viewIsCurrent, true);
  assert.deepEqual(Lfresh.pasted.differing, []);
  // Owner note on completion, reopen, reconcile with a new task, tamper detection
  const v3 = pub('complete', 'T003', 'owner-1', { note: 'verified by owner' });
  assert.ok(E.lookup(board, 'T003').matches[0].evidence.includes('verified by owner'));
  const t = JSON.parse(fs.readFileSync(path.join(board, 'tasks.json'), 'utf8'));
  t.tasks.push({ id: 'T005', task: 'Added by owner', status: 'IN PROGRESS', worker: 'worker-a' });
  fs.writeFileSync(path.join(board, 'tasks.json'), JSON.stringify(t, null, 2));
  assert.throws(() => pub('complete', 'T005', 'worker-a'), /Definition integrity/);
  const v4 = pub('reconcile', null, 'owner-1');
  assert.equal(v4.total, 5);
  const v5 = pub('reopen', 'T001', 'owner-1');
  assert.equal(v5.completed, 1);
  // Tracking over time: log, jsonl and History sheet carry every publish
  const logText = fs.readFileSync(logFile, 'utf8');
  assert.equal((logText.match(/^## /gm) || []).length, 5, logText);
  assert.ok(/added T005 \[IN PROGRESS\]/.test(logText) && /T001 checked and struck/.test(logText) && /note: verified by owner/.test(logText));
  assert.equal(fs.readFileSync(path.join(board, 'history.jsonl'), 'utf8').trim().split('\n').length, 5);
  const hr = cp.spawnSync(E.resolveGenoffice().cmd, [...E.resolveGenoffice().pre, 'sheet', 'read', v5.workbook, '--sheet', 'History', '--range', 'A1:F8', '--json'], { env: { ...process.env, ...E.resolveGenoffice().env }, encoding: 'utf8' });
  const hrows = JSON.parse(hr.stdout).detail.rows;
  assert.equal(hrows[1][2], 'reopen'); assert.equal(hrows[5][2], 'init');
  // A later agent session adopts the board, recorded in the log
  const t2 = JSON.parse(fs.readFileSync(path.join(board, 'tasks.json'), 'utf8'));
  t2.ownerId = 'owner-2'; t2.ownerLabel = 'Next session';
  fs.writeFileSync(path.join(board, 'tasks.json'), JSON.stringify(t2, null, 2));
  assert.throws(() => pub('reconcile', null, 'owner-2'), /ownerId differs|Owner-only/);
  assert.throws(() => pub('adopt', null, 'owner-2'), /needs --note/);
  const v6 = pub('adopt', null, 'owner-2', { note: 'Operator: next session takes over the tasklist' });
  assert.equal(v6.ownerId, 'owner-2');
  assert.ok(/owner owner-1 -> owner-2/.test(fs.readFileSync(logFile, 'utf8')));
  assert.throws(() => pub('reconcile', null, 'owner-1'), /Owner-only|ownerId differs/);
  // Worker view and context offload
  const W = E.mine(board, 'worker-a');
  assert.equal(W.you, 'worker');
  assert.deepEqual(W.tasks.map(t => t.id), ['T001', 'T002', 'T005']);
  assert.ok(W.tasks.find(t => t.id === 'T005').completeCommand.includes('complete-task.cjs'));
  assert.throws(() => E.note(board, 'worker-a', 'T003', 'x'), /Owner-only/);
  E.note(board, 'owner-2', 'T003', 'Laya decider: 512-token limit confirmed; keep questions under 192 tokens');
  assert.ok(E.lookup(board, 'T003', { verify: false }).matches[0].notes[0].text.includes('512-token'));
  // The operator redirects in the sheet: T002 Status -> ON HOLD (B6), T004 Scope -> KAKASHI (D8).
  // Live: first prove the editor read raises no false alarm, then close the tab and save the edit to the file,
  // which is what GenOffice autosave does after a dropdown change.
  const g = E.resolveGenoffice();
  const run = args => cp.spawnSync(g.cmd, [...g.pre, ...args, '--json'], { env: { ...process.env, ...g.env }, encoding: 'utf8' });
  if (live) {
    const I0 = E.intake(board, 'owner-2', { open: true });
    assert.equal(I0.source, 'editor');
    assert.equal(I0.status, 'no-operator-edits', 'no false alarm from the open editor');
    assert.equal(E.closeTab(v6.live).closed, true);
  }
  const cells = path.join(board, 'operator-cells.json');
  fs.writeFileSync(cells, JSON.stringify([{ cell: 'B6', value: 'ON HOLD', sheet: 'Tasks' }, { cell: 'D8', value: 'KAKASHI', sheet: 'Tasks' }]));
  assert.equal(run(['sheet', 'apply', v6.live, '--cells', cells]).status, 0);
  assert.throws(() => pub('complete', 'T005', 'worker-a'), /operator changed the live sheet/);
  const I1 = E.intake(board, 'owner-2', { open: live });
  assert.equal(I1.status, 'operator-edits');
  assert.equal(I1.source, 'file');
  assert.ok(I1.signals.some(s => s.type === 'status' && s.id === 'T002' && s.to === 'ON HOLD'), JSON.stringify(I1.signals));
  assert.ok(I1.signals.some(s => s.type === 'scope' && s.id === 'T004' && s.to === 'KAKASHI'), JSON.stringify(I1.signals));
  const v7 = E.intake(board, 'owner-2', { apply: true, open: live });
  const t7 = JSON.parse(fs.readFileSync(path.join(board, 'tasks.json'), 'utf8'));
  assert.equal(t7.tasks.find(t => t.id === 'T002').status, 'ON HOLD');
  assert.equal(t7.tasks.find(t => t.id === 'T004').scope, 'KAKASHI');
  assert.ok(/operator-edit \| Operator \(GenOffice\)/.test(fs.readFileSync(logFile, 'utf8')));
  assert.equal(E.intake(board, 'owner-2', { open: live }).status, 'no-operator-edits');
  // Dependencies: T004 waits on T003 (done) -> ready to hand out
  const t8 = JSON.parse(fs.readFileSync(path.join(board, 'tasks.json'), 'utf8'));
  Object.assign(t8.tasks.find(t => t.id === 'T004'), { status: 'READY', deps: ['T003'], context: 'Spec lives in docs/translator.md', acceptance: 'Schema validated against 20 samples' });
  fs.writeFileSync(path.join(board, 'tasks.json'), JSON.stringify(t8, null, 2));
  const v8 = pub('reconcile', null, 'owner-2');
  assert.deepEqual(E.status(board).readyToDispatch, ['T004']);
  const ctxRows = JSON.parse(run(['sheet', 'read', v8.workbook, '--sheet', 'Context', '--range', 'A1:F6']).stdout).detail.rows;
  assert.ok(ctxRows.some(r => r[0] === 'T004' && r[4] === 'T003') && ctxRows.some(r => r[0] === 'T003' && String(r[5]).includes('512-token')));
  if (live) {
    const projKey = process.platform === 'win32' ? project.toLowerCase() : project;
    const mine = () => E.openPaths().filter(p => p.startsWith(projKey));
    for (const v of [v1, v2, v3, v4, v5, v6, v7, v8]) assert.equal(v.view.liveUpdated, true, JSON.stringify(v.view));
    for (const v of [v2, v3, v4, v5, v6, v7, v8]) assert.equal(v.view.displayedRevisionVerified, true, 'displayed revision ' + v.revision);
    for (const v of [v2, v3, v4, v5, v6, v7, v8]) assert.deepEqual(v.view.otherTabsClosed || [], [], 'no other tab closed');
    assert.ok(v7.view.operatorEditPreserved, 'the edited live file was kept in operator-edits/');
    assert.equal(mine().length, 1, 'exactly one GenOffice tab for this board after 8 publishes: ' + JSON.stringify(mine()));
    // tidy: open a stale snapshot tab by hand, then let tidy close it
    cp.spawnSync(E.resolveGenoffice().cmd, [...E.resolveGenoffice().pre, 'open', v2.workbook, '--json'], { env: { ...process.env, ...E.resolveGenoffice().env } });
    assert.equal(mine().length, 2);
    const td = E.tidy(board);
    assert.equal(td.closed.length, 1, JSON.stringify(td));
    assert.equal(mine().length, 1);
    // leave the operator's GenOffice as found: close the test live tab
    assert.equal(E.closeTab(v8.live).closed, true);
    assert.equal(mine().length, 0);
    console.log('PASS live: open-editor read raised no false alarm; operator edit (ON HOLD, KAKASHI) saved to the live file blocked publishing until intake adopted it; 8 publishes -> 1 tab, revision verified each time, UI Automation closes only, tidy closed a stale snapshot, test tab closed');
  }
  const s = E.status(board);
  assert.equal(s.workbookIntact, true);
  assert.equal(s.liveMatchesHead, true);
  fs.appendFileSync(v8.workbook, 'x');
  assert.throws(() => pub('complete', 'T005', 'worker-a'), /changed outside/);
  console.log('PASS e2e: ' + board);
}
