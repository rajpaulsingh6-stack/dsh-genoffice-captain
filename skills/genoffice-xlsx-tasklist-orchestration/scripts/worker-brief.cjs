'use strict';
// Print the dispatch brief a Captain sends to one worker session (any harness).
// Usage: node worker-brief.cjs <board> Tnnn [--captain "⭐NAME"] [--worker <identity>] [--label <display name>] [--json]
const fs = require('node:fs');
const path = require('node:path');
function findTasklistSkill() {
  if (process.env.GXT_ENGINE && fs.existsSync(process.env.GXT_ENGINE)) return path.dirname(process.env.GXT_ENGINE);
  for (const n of ['GenOffice_XLSX_Tasklist', 'genoffice-xlsx-tasklist']) {
    const p = path.resolve(__dirname, '..', '..', n, 'scripts');
    if (fs.existsSync(path.join(p, 'board-engine.cjs'))) return p;
  }
  throw new Error('GenOffice_XLSX_Tasklist skill not found next to this skill; set GXT_ENGINE to its scripts/board-engine.cjs');
}
const argv = process.argv.slice(2);
const take = n => { const i = argv.indexOf(n); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const asJson = argv.includes('--json'); if (asJson) argv.splice(argv.indexOf('--json'), 1);
const captain = take('--captain'), workerArg = take('--worker'), labelArg = take('--label');
const [board, id] = argv;
try {
  if (!board || !id) throw new Error('Usage: node worker-brief.cjs <board> Tnnn [--captain "⭐NAME"] [--worker <identity>] [--label <name>] [--json]');
  const scripts = findTasklistSkill();
  const E = require(path.join(scripts, 'board-engine.cjs'));
  const L = E.lookup(board, id, { verify: false });
  const t = L.matches.find(m => m.id === id.toUpperCase());
  if (!t) throw new Error('Unknown task ' + id);
  const worker = workerArg || t.worker;
  if (!worker) throw new Error(id + ' has no worker assigned: set worker in tasks.json and reconcile first (or pass --worker)');
  if (t.worker && workerArg && t.worker !== workerArg) throw new Error(id + ' is assigned to ' + t.worker + ', not ' + workerArg);
  if (t.status !== 'IN PROGRESS') throw new Error(id + ' is ' + t.status + '; set it IN PROGRESS and reconcile before dispatching');
  const engine = path.join(scripts, 'board-engine.cjs'), helper = path.join(scripts, 'complete-task.cjs');
  const q = s => '"' + s + '"';
  const lines = [
    '[TASKLIST DISPATCH] ' + t.id + (captain ? ' from ' + captain : ''),
    'Board: ' + path.resolve(board) + ' (revision ' + L.revision + ')',
    'You are worker ' + (labelArg || t.workerLabel || worker) + ', identity ' + worker + '. If your CODEX_THREAD_ID is not exactly this, set TASKBOARD_ACTOR=' + worker + ' for the commands below.',
    '',
    'Task ' + t.id + ': ' + t.task,
    t.scope ? 'Scope: ' + t.scope : null,
    t.acceptance ? 'Acceptance: ' + t.acceptance : null,
    t.context ? 'Context: ' + t.context : null,
    t.deps && t.deps.length ? 'Depends on (done first): ' + t.deps.join(', ') : null,
    t.notes && t.notes.length ? 'Captain notes: ' + t.notes.map(n => n.text).join(' / ') : null,
    '',
    'Steps:',
    '1. node ' + q(engine) + ' ' + q(path.resolve(board)) + ' mine    (do only the tasks listed for you)',
    '2. Do the work. Put the evidence in your reply: commands, outputs, paths, hashes.',
    '3. node ' + q(helper) + ' ' + q(path.resolve(board)) + ' ' + t.id + '    (exactly once; if it refuses, stop and report its message)',
    '4. Reply here, first line exactly one of:',
    '   [TASKLIST DONE ' + t.id + '] <evidence summary>',
    '   [TASKLIST BLOCKED ' + t.id + '] <reason>',
    '   [TASKLIST QUESTION ' + t.id + '] <question>',
    '5. Then stop. Do not add, edit or reassign tasks and do not touch tasks.json, HEAD.json, versions or the workbook. A direct instruction from the operator always wins.',
  ].filter(x => x !== null);
  const message = lines.join('\n');
  console.log(asJson ? JSON.stringify({ task: t.id, worker, revision: L.revision, message }, null, 2) : message);
} catch (e) { console.error(e.message); process.exitCode = 1; }
