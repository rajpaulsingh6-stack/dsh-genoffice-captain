---
name: genoffice-xlsx-tasklist-orchestration
description: Harness-agnostic multi-agent orchestration through a GenOffice (Genspark Office) task list. The operator marks the orchestrating agent with ⭐ in its task/session title (e.g. ⭐ASTRA_6_CAPTAIN) or by calling it "Captain" in text. The Captain keeps the tasks in a GenOffice_XLSX_Tasklist workbook (Genofficetasklist<MMDDYY><Tree>.xlsx in the project's GenOffice_XLSX_Tasklist folder) and reaches sub-agents through its own harness's inter-session messaging (Codex Desktop, Codex CLI, Claude Code CLI, Claude Desktop, Cursor, OpenCode, the DeepSeek harness, Hermes Agent). Workers in any harness just read their tasks from the spreadsheet, do them and tick them; operator dropdown edits in the sheet are redirects the Captain reads first. A lone agent uses the same sheet to offload context. Use when the user names a Captain or ⭐ agent, asks to orchestrate, dispatch, supervise or coordinate sub-agents or other sessions around a task list, or asks a worker to pick up its tasks from the GenOffice task list. Requires the GenOffice_XLSX_Tasklist skill.
metadata:
  version: 1.0.0
  requires: GenOffice_XLSX_Tasklist >= 1.2 (installed next to this skill), Node 18+; optional OpenCodexOrchestration for CLI workers
  author: Rajpaul Singh with Claude
  credits: Built on ideas from sub-agents-skills by Shinsuke Kagawa (shinpr, MIT) and Orca orchestration by stablyai (MIT); see NOTICE.md
---

# GenOfficeXLSXTasklistOrchestration

The spreadsheet is the coordination surface; the harness is just how agents talk. One Captain owns the task list, any number of workers read it, the operator watches and redirects it in GenOffice. Nothing here depends on which harness an agent runs in: every participant needs only the board path, its identity and two node commands.

Read first: the GenOffice_XLSX_Tasklist SKILL.md (the engine, dropdown intake, one live tab, session names) and references/harness-messaging.md for the section matching your harness. Engine path below: <tl> = the GenOffice_XLSX_Tasklist skill folder next to this one (GenOffice_XLSX_Tasklist in Codex, genoffice-xlsx-tasklist when installed with npx skills).

## Credits

This skill adapts two open-source designs to a spreadsheet-centred, harness-agnostic setting:

- sub-agents-skills by Shinsuke Kagawa (shinpr), MIT License - https://github.com/shinpr/sub-agents-skills (installed on this fleet as OpenCodexOrchestration). Borrowed: agent definitions with a run-agent backend and permission level, the broker discipline (one run from start to a terminal state, silence is not failure, match the tool timeout to the run), and the JSON status handling (success / partial / error). Its run_subagent.py stays the way to launch CLI workers; this skill does not copy its code.
- Orca orchestration by stablyai, MIT License - https://github.com/stablyai/orca (guide served by Orca 1.4.190 via orca skills get orchestration). Borrowed: the Run / Task / Dispatch model, a worker reports completion exactly once with an explicit outcome, ask/reply for blocking questions, escalation, decision gates, rolling waits with a checkpoint instead of a failure on timeout, releasing settled workers, dependency waves no deeper than 3-4 steps, circuit breaking after 3 failures, and the rule that a full handoff is not a supervised dispatch. Orca's runtime and commands are not used here.
- GenOffice by Genspark (genspark-ai/genoffice, Apache-2.0): the CLI and MCP the task list runs on.

## Who is the Captain

- The agent whose task or session title carries ⭐ (for example ⭐ASTRA_6_CAPTAIN), or whom the operator calls "Captain" in text, is the orchestrator. Say so in your first reply: "I am the Captain for <session>."
- Exactly one Captain per session board. The Captain is the board owner: ownerId = its own session identity (its CODEX_THREAD_ID in Codex), ownerLabel = its ⭐ name.
- Every other agent is a worker, even if it has this skill loaded. If two agents claim Captain, or the Captain is unclear, stop and ask the operator.
- A worker that is later told it is the Captain takes over with adopt --note "<operator's words>" on the existing board, or scaffolds a new session.

## The model (Orca terms, spreadsheet storage)

| Orca | Here |
|---|---|
| Run (namespace + coordinator inbox) | One session board: GenOffice_XLSX_Tasklist/Genofficetasklist<MMDDYY><Tree>/ plus its .xlsx and .md |
| Task | A row Tnnn with task, scope, context, acceptance, deps |
| Dispatch (one attempt, one worker) | tasks.json worker = the worker's identity, status IN PROGRESS, published |
| worker_done (exactly once, explicit outcome) | Worker runs complete-task.cjs (ticks + strikes), then sends [TASKLIST DONE Tnnn]; failures send [TASKLIST BLOCKED Tnnn] |
| ask / reply | [TASKLIST QUESTION Tnnn] over the harness's messaging; the Captain answers in the same channel |
| decision gate | Status DECISION NEEDED; the operator answers in chat or with the Status dropdown |
| escalation | Status BLOCKED with the reason in evidence or a note |
| task-list --ready | status -> readyToDispatch (READY/TODO with every dep done) |
| worker-release | End or free the worker session once its task settled (harness-native) |

Messages are notifications; the board is the state. Never treat a chat message as a completed task until the board says so.

## Captain loop

1. Board: scaffold a session in the project root, fill tasks.json (context, acceptance, deps per task), init. The operator sees Genofficetasklist<MMDDYY><Tree>.xlsx in one live tab (show-on-monitor.ps1 -Monitor 2 if asked).
2. Intake first, every cycle: node <tl>/scripts/board-engine.cjs <board> intake, then --apply. Operator dropdown edits (ON HOLD, CANCELLED, DECISION NEEDED, Scope moved, Done ticked or cleared) override your plan. Say how you read each one.
3. Plan a wave: status -> readyToDispatch. Keep dependency chains 3-4 deep at most; parallelize independent tasks.
4. Assign: for each task in the wave set worker (the worker's identity) and workerLabel, status IN PROGRESS; reconcile --note "dispatch wave N".
5. Dispatch through your harness's inter-session messaging (references/harness-messaging.md). Generate each message with:
       node <this skill>/scripts/worker-brief.cjs <board> T007 --captain "⭐NAME"
   The brief carries the board path, the worker identity, the task spec, context, acceptance, deps, the two commands and the reply format. Paste it verbatim.
6. Wait with the harness's wait or poll, in rolling windows (10-15 minutes for real work). A timeout or silence is a checkpoint, not a failure: check the board and the worker's session, keep waiting while it is alive. Answer [TASKLIST QUESTION] messages promptly.
7. On [TASKLIST DONE Tnnn]: verify the evidence yourself (real end-to-end proof, not a partial check), then confirm the board shows Tnnn ticked (status or lookup). If the worker could not run the helper, complete it yourself with complete Tnnn --note "<evidence, verified by Captain>". If the evidence does not hold, reopen Tnnn and message the worker why.
8. On [TASKLIST BLOCKED Tnnn] or a refused command: record it (status BLOCKED + note), decide: retry with a fresh worker, re-scope, or ask the operator (DECISION NEEDED). After 3 failed attempts on one task, stop retrying: BLOCKED, and tell the operator.
9. Release: once a worker's task settled and it has no immediate follow-up, end or free its session per harness. Reuse the same worker only for an immediate follow-up task.
10. Repeat from step 2 until nothing is ready. Report to the operator: session, revision, done/total, BLOCKED / DECISION NEEDED / ON HOLD items, and which operator edits changed the plan.

Every reply to the operator that touches the list names task IDs, the change and the new revision (the reply contract in GenOffice_XLSX_Tasklist).

## Worker protocol (any harness)

1. Your brief names the board and your identity. If your environment's CODEX_THREAD_ID is not exactly that identity, prefix commands with TASKBOARD_ACTOR=<identity> (PowerShell: $env:TASKBOARD_ACTOR='<identity>').
2. node <tl>/scripts/board-engine.cjs <board> mine - do only the tasks listed there, in dependency order, using their context and acceptance.
3. Do the work; put the evidence in your reply (commands, outputs, paths, hashes).
4. node <tl>/scripts/complete-task.cjs <board> Tnnn - exactly once per task. If it refuses (for example "operator changed the live sheet"), stop and report the message.
5. Reply to the Captain, first line exactly one of: [TASKLIST DONE Tnnn] <evidence summary>  |  [TASKLIST BLOCKED Tnnn] <reason>  |  [TASKLIST QUESTION Tnnn] <question>
6. Then stop. Do not add, edit, reassign or re-order tasks, do not touch tasks.json, HEAD.json, versions or the workbook, and do not start other work unless the operator tells you directly (a direct operator instruction always wins).

A worker that cannot run node at all (for example a chat-only surface) reads its row through the genoffice MCP (sheet_read on the live .xlsx) and replies [TASKLIST DONE Tnnn] with evidence; the Captain completes it.

## Full handoff is not orchestration

"Hand off", "give this to another agent / session", "handover" means ownership transfer: the new owner runs adopt (or scaffolds its own session) and becomes the Captain for that work. Do not dispatch, wait on or supervise a handoff unless the operator explicitly asks you to supervise, monitor, wait for results or coordinate.

## Solo

No sub-agents: skip messaging entirely. Use GenOffice_XLSX_Tasklist in solo mode and offload into the sheet: context, acceptance and deps per task, note Tnnn "..." for running findings, lookup / mine to reload after compaction. The operator's dropdown edits still redirect you: intake before each step.

## Before saying done

- intake reports no-operator-edits; status shows no IN PROGRESS task without a live worker.
- Every task marked DONE has verified evidence in its row (evidence or Done note) and a [TASKLIST DONE] message behind it.
- Worker sessions released or explicitly kept (say which and why).
- Report session name, live .xlsx and .md paths, revision, done/total and open items.

## Limits

- Identities are workflow validation, not security; agents sharing one OS account can bypass file checks.
- Inter-session tool names differ per harness and change between releases: confirm yours before relying on it (references/harness-messaging.md). If your harness exposes none, launch workers with OpenCodexOrchestration (templates/agents/tasklist-worker.md) or ask the operator to relay the brief.
