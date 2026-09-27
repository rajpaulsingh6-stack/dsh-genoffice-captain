'use strict';
// Completion-only worker interface for GenOffice_XLSX_Tasklist.
// Accepts exactly a board directory and one existing task ID. No workbook, cell, text, status or ops input.
const path = require('node:path');
const { publish } = require(path.join(__dirname, 'board-engine.cjs'));
try {
  const args = process.argv.slice(2).filter(a => a !== '--no-open');
  if (args.length !== 2) throw new Error('Usage: node complete-task.cjs <boardDir> Tnnn');
  const actor = process.env.TASKBOARD_ACTOR || process.env.CODEX_THREAD_ID;
  if (!actor) throw new Error('Missing CODEX_THREAD_ID/TASKBOARD_ACTOR: send the owner "COMPLETE Tnnn" plus evidence instead. Never impersonate another task.');
  console.log(JSON.stringify(publish(args[0], 'complete', args[1], actor, { open: !process.argv.includes('--no-open') }), null, 2));
} catch (e) { console.error(e.message); process.exitCode = 1; }
