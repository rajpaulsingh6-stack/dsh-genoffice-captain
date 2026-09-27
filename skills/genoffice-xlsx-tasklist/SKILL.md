---
name: genoffice-xlsx-tasklist
description: Session task list kept as a real GenOffice (Genspark Office) .xlsx, named Genofficetasklist<MMDDYY><Tree> (one word from California's ten most voluminous trees, so same-day sessions stay apart anonymously) with a matching .md log, in <project root>/GenOffice_XLSX_Tasklist/. Status, Scope and Done are operator dropdowns (Done = ☑/☐); any operator change is read as a redirect before the agent's next step. Completion ticks the box and strikes the task. Works for an orchestrator with sub-agents (workers only tick their own assigned task) or one agent alone (solo), which can offload per-task context, acceptance criteria and notes into the workbook and reload them after compaction. The operator can also paste rows, type IDs, row numbers or words, or select cells; the agent cross-references them via the genoffice CLI or MCP. Every change republishes into ONE live GenOffice tab (closed through UI Automation without keystrokes, swapped, reopened, revision-verified), autosave on by default. Use for a spreadsheet task list, taskboard, checklist, tracker or session log in GenOffice, checkboxes or cross-out, or when the user pastes rows from such a list. Builds on the genoffice skill; GenOfficeXLSXTasklistOrchestration adds multi-agent coordination.
metadata:
  version: 1.2.0
  requires: genoffice skill + GenOffice app with CLI >= 0.9, Node 18+
  origin: Distilled 2026-09-27 from the ⭐ASTRA_6_CAPTAIN MASTER-ROSHI taskboard on OBITO (Codex task 01a0d77b-56a0-75b3-8980-00a511be0b93) and Paul's interactions with it
  author: Rajpaul Singh with Claude
---

# GenOffice_XLSX_Tasklist

A task list the operator watches in GenOffice, owned by one agent, that is also the session's log and the agent's external memory. Read the genoffice skill first if it is not loaded; this skill drives the same CLI and follows its rules (always --json, never --force onto a file open in GenOffice, check and look before saying done). Read references/operator-interaction-model.md once per project: it is the measured record of how the operator talks to an orchestrator and the rules derived from it. For sub-agents and inter-session messaging use the GenOfficeXLSXTasklistOrchestration skill on top of this one.

Files next to this SKILL.md:

| File | Purpose |
|---|---|
| scripts/board-engine.cjs | Engine: scaffold, init, reconcile, intake, adopt, complete, reopen, mine, note, status, lookup, selection, tidy, pdf. Finds the GenOffice CLI itself. |
| scripts/complete-task.cjs | Worker entry point (team mode): a board folder and one task ID, nothing else. |
| scripts/close-tab-uia.ps1 | Windows: closes exactly one GenOffice tab by clicking its own Close button through UI Automation (no keystrokes) and hands focus back. |
| scripts/focus-restore.ps1 | Windows: returns keyboard focus to the window the user was using. |
| scripts/show-on-monitor.ps1 | Windows: put the GenOffice window on monitor N (1 = primary, then left to right) and maximize it. |
| scripts/test-board.cjs | Unit checks; --e2e full CLI cycle; --live also proves the single-tab refresh in the running app. |
| templates/tasks.example.json, templates/tasks.solo.example.json | Team and solo definitions. |
| references/operator-interaction-model.md | Quantified operator/orchestrator interaction record and protocol. |

## Where it lives

    <project root>/GenOffice_XLSX_Tasklist/
      Genofficetasklist092726Ponderosa.xlsx   the workbook the operator sees (the single live tab)
      Genofficetasklist092726Ponderosa.md     append-only session log: every publish, operator edit and note
      Genofficetasklist092726Ponderosa.pdf    optional export (pdf command)
      Genofficetasklist092726Ponderosa/       engine files: tasks.json, HEAD.json, history.jsonl, notes.jsonl, versions/, operator-edits/
      Genofficetasklist092726Douglas.xlsx     the next session that day, and so on

Session name = Genofficetasklist + MMDDYY + the first tree word not yet used in that folder on that date, in this order: Ponderosa (Ponderosa Pine), Douglas (Douglas-fir), Redwood (Coast Redwood), Incense (California Incense-cedar), Live (Coast Live Oak), Jeffrey (Jeffrey Pine), White (White Fir), Black (California Black Oak), Lodgepole (Lodgepole Pine), Madrone (Pacific Madrone). One distinguishing word per tree, because Pine, Fir and Oak repeat. After ten sessions in a day the list repeats with a number (Ponderosa2). --tree picks one explicitly. The names say nothing about who ran the session.

Project root = the git top level of the working folder, else the folder the user named as the project. Keep it on local disk of the host running GenOffice (lock file + atomic rename). The scaffolded .gitignore keeps versions/ and operator-edits/ out of git.

## Modes

- team (default): the owner (orchestrator, the Captain) creates, edits, assigns, reopens and re-lays-out tasks. A worker (sub-agent) may only run complete-task.cjs for a task assigned to its identity with status IN PROGRESS. Identity = CODEX_THREAD_ID, or TASKBOARD_ACTOR for agents without one. Never set another agent's identity.
- solo: one agent, no sub-agents. "mode": "solo", no worker fields; the agent completes its own tasks with complete Tnnn --note "<evidence>" and uses the list as external memory (below).

## Start a session

    node <skill>/scripts/board-engine.cjs <project root> scaffold [--solo] [--title "..."] [--tree Redwood]
    # edit <project root>/GenOffice_XLSX_Tasklist/<session>/tasks.json with apply_patch
    node <skill>/scripts/board-engine.cjs <project root>/GenOffice_XLSX_Tasklist/<session> init
    powershell -File <skill>/scripts/show-on-monitor.ps1 -Monitor 2        # if the operator asked for a monitor (-List first)

init publishes the first version, opens the single live tab and turns GenOffice autosave on by default (Home > Auto-save; settings backed up first; the running app picks it up at its next start or one flip of the toggle; "autosave": false opts out). Report what init returned under autosave.

Task fields: id (T001...), task (acceptance outcome in one sentence), scope (host/area), status, worker/workerLabel (team), evidence, and for high-fidelity work: context (spec, paths, commands, gotchas; up to 20000 characters), acceptance (how done is proven), deps (task IDs that must be done first). Board fields: title, subtitle, mode, ownerId, ownerLabel (the Captain's name, e.g. ⭐ASTRA_6_CAPTAIN), session, workbookName, scopes (extra choices for the Scope dropdown), layout.columns (order of id, done, task, scope, status, worker, evidence; Paul's layout B = Status, E = Done is ["id","status","task","scope","done","worker","evidence"]), layout.doneControl ("dropdown" ☑/☐ by default, or "checkbox"), autosave.

## Status legend (eleven states)

| Status | Meaning |
|---|---|
| TODO | Not started yet. |
| READY | Specified and unblocked; can start now. |
| IN PROGRESS | Being worked. The only status a worker can complete from. |
| IN REVIEW | Work finished; waiting for review or operator approval. |
| VERIFYING | Running the real end-to-end proof; not done until it passes. |
| WAITING | Waiting on an external party, host, download or reply; not a fault. |
| BLOCKED | Cannot proceed: failure, missing access or a gate. Blocked is not done. |
| DECISION NEEDED | Needs an operator choice before work can continue. |
| ON HOLD | Paused by the operator; do not work it until released. |
| DONE | Outcome met, evidence published: box ticked, task struck through. |
| CANCELLED | Dropped by the owner; greyed, not struck, kept for the record. |

Custom UPPERCASE statuses (e.g. SPEC READY) are accepted and offered in the dropdown. Only a ticked box means done: never mark DONE on a partial check (that is what VERIFYING is for).

## Operator edits are redirects

On the Tasks sheet the Status, Scope and Done columns are dropdowns the operator may change (B, D and E in either layout); the other cells belong to the owner, and edits there are reported, not applied. Rules, History and Context are protected.

Before every step that touches the list, the owner runs:

    node <skill>/scripts/board-engine.cjs <board> intake            # read and interpret
    node <skill>/scripts/board-engine.cjs <board> intake --apply    # adopt Status / Scope / Done changes, log them, republish
    #                                                  --apply-text also adopts rewritten cells and new rows

intake reads the open editor when the live tab is open (unsaved edits included) and the file otherwise. Each signal comes with a meaning: ON HOLD = stop working it; CANCELLED = drop it; BLOCKED = the operator says it cannot proceed, find out why; DECISION NEEDED = stop and ask; IN REVIEW = operator wants to review first; VERIFYING = operator wants the end-to-end proof; READY / IN PROGRESS = start or resume; Done ticked = operator accepts it, stop work; Done cleared = completion disputed, reopen and re-verify; Scope changed = redirect to that host/area; removed row = confirm cancellation, never delete. Say in the reply how you read each signal, then act on it. Any other publish (including a worker's completion) is refused until intake has run, so an operator redirect can never be silently overwritten.

## Talking about tasks with the operator

| Operator input | What to run | What to say back |
|---|---|---|
| Pasted rows (a whole-sheet copy is ~1000 tab-separated rows with the header and "Revision ..." line) | lookup --file <attachment path> (Codex saves long pastes as a file), or lookup - | The IDs understood, whether their view is current (pasted.viewIsCurrent), any row whose pasted status/done differs |
| Task IDs: "T014", "T009-T012" | lookup "T014" | Status, owner/worker, context, notes, history |
| Row numbers: "13-16 on task list" | lookup "13-16" | "rows 13-16 = T009-T012"; ask only if rowInterpretation.ambiguous and the next step changes the list |
| A description | lookup "laya decider" | Best match by ID, runners-up if close |
| "this one", "these" | selection | The selected IDs, then answer |
| Layout: "SWAP COLUMN B AND E" | edit layout.columns, reconcile | "Columns now A=id B=status ... (revision R)" |
| Rows + "GREENLIGHT" | lookup the rows | Apply the approval to exactly those IDs, name them, record it with --note |
| Scope or requirement change | edit tasks.json, reconcile --note "<operator words>" | Which tasks changed and how, new revision |
| "list blocked and pending" | status | IDs grouped by status, blocked first; readyToDispatch |

Reply contract, every time the list is touched: task IDs, what changed, the new revision, and that the live tab shows it (view.displayedRevisionVerified). Several queued operator messages: acknowledge each separately and in order. Never silently reinterpret numbers; never let an approval spill past the rows it came with.

Same cross-reference through MCP where genoffice is registered (Codex on OBITO): selection on HEAD.live, sheet_read on HEAD.workbook (the published version, not whatever tab is open), open to point at a row. GenOffice's in-app MCP server (Settings > Integrations, 127.0.0.1:3093) additionally offers open_documents (list / read / close) if the operator enabled it.

## Solo agent: offload context, keep fidelity

Put the detail in the list instead of in your context window: task context, acceptance and deps in tasks.json; running findings with

    node <skill>/scripts/board-engine.cjs <board> note T004 "schema validated on 20/20 samples; edge case: empty arrays"

note is cheap (no republish): it lands in notes.jsonl and the .md log immediately and in the Context sheet at the next publish. After a compaction or in a new session, reload exactly what matters with lookup T004 (context, acceptance, deps, last notes, history) or mine (everything you own), and read the session .md before touching the list.

## Changing the list (owner)

Edit tasks.json with apply_patch, then:

    node <skill>/scripts/board-engine.cjs <board> reconcile [--note "operator instruction or reason"]
    node <skill>/scripts/board-engine.cjs <board> complete T007 [--note "evidence"]
    node <skill>/scripts/board-engine.cjs <board> reopen T007
    node <skill>/scripts/board-engine.cjs <board> status | mine | tidy | pdf

A new agent session taking over an existing session board: set ownerId/ownerLabel to yourself and run adopt --note "<the operator instruction or handoff>". A new piece of work gets a new session (scaffold again: next tree).

## Worker (team mode)

    node <skill>/scripts/board-engine.cjs <board> mine          # your tasks: spec, context, acceptance, deps, notes, completeCommand
    node <skill>/scripts/complete-task.cjs <board> T007         # after your evidence is published

JSON result: ok or already_complete. Rejections exit 1 with the reason: unknown ID, not assigned to you, not IN PROGRESS, solo board, operator edits pending, definitions changed since last publish, tampered workbook or state, lock held.

## One live tab (no tab per version)

Each publish writes versions/<revision>/<session>@<time>-<id>.xlsx (never opened), then: if the live workbook is open, it clicks that tab's own Close button through Windows UI Automation (no keystrokes, answers any unsaved-changes prompt "Don't Save" because intake has already read the edits, hands keyboard focus back to the window the operator was using), proves from GenOffice's registry (userData/open-documents.json) that exactly that tab closed, waits for the file to settle, swaps in the new version, reopens it at Tasks!A1:G14 and reads the tab back until it shows "Revision <HEAD revision>", retrying once. If the close cannot be proven it opens nothing new and reports view.liveStale: tell the operator, do not retry blindly. macOS keystroke closing only runs with GXT_ALLOW_KEYS=1 (it steals focus); Linux reports liveStale. tidy closes stale snapshot tabs of this board, one verified close at a time. HEAD.json is authoritative, never whichever tab happens to be open.

## Tracking over time

The session .md gets one section per publish (time, action, who, revision, done/total, changes such as "added T005 [IN PROGRESS]", "T001 checked and struck", "T002 status BLOCKED -> ON HOLD by the operator", "layout A=id B=status ...", notes) plus one line per note. The workbook's History sheet shows the same newest-first; the Context sheet shows context, acceptance, deps and the latest notes per task.

## Before saying done

- node <skill>/scripts/test-board.cjs --e2e once per host (--live on a host with GenOffice open when tab behavior matters).
- intake: no-operator-edits. status: workbookIntact, liveMatchesHead, liveOpenInGui true.
- Look at it: genoffice render <HEAD.workbook> --out <board>/preview --json.
- Report: session name, live .xlsx and .md paths, revision, done/total, anything BLOCKED, DECISION NEEDED or ON HOLD, how operator edits were read, autosave result, view.liveStale if it happened.

## Limits

- Workflow validation, not security: agents sharing one OS account can bypass file checks; the Tasks sheet is editable by design.
- intake reads unsaved edits only while the live tab is open; otherwise it sees what autosave (or the operator's save) wrote.
- Versions are local recovery points, not an off-host backup. No watcher or scheduled job.
