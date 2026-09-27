---
run-agent: codex
permission: safe-edit
---

# tasklist-worker

Worker for a GenOffice_XLSX_Tasklist board, launched by a Captain through OpenCodexOrchestration (sub-agents-skills by Shinsuke Kagawa) when its harness has no native inter-session messaging. Change run-agent to claude, cursor-agent, opencode, gemini or another supported backend as needed.

## Task

The prompt is a [TASKLIST DISPATCH] brief written by worker-brief.cjs. Follow its steps exactly: run mine, do only the listed task, publish evidence, run complete-task.cjs once, then stop. Never add, edit or reassign tasks and never touch tasks.json, HEAD.json, versions or the workbook.

## Output Format

First line exactly one of:
[TASKLIST DONE Tnnn] <evidence summary>
[TASKLIST BLOCKED Tnnn] <reason>
[TASKLIST QUESTION Tnnn] <question>
Then the evidence: commands run, outputs, paths, hashes.
