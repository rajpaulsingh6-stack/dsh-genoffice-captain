# Operator interaction model (measured)

Source: the complete ⭐ASTRA_6_CAPTAIN Codex session on OBITO (task 01a0d77b-56a0-75b3-8980-00a511be0b93, two rollout files), 2026-09-25 03:33 to 2026-09-27 03:59 EDT. Operator messages recovered: 74. Astra final replies: 275 (includes goal auto-continuations). Classified by hand after an automatic first pass on 2026-09-27.

## What the operator sends (74 messages)

| Kind | Count | Share | Examples |
|---|---|---|---|
| Directive / requirement | 15 | 20% | "All 5x STRATA install(s) and the DGX Spark install should have vision (mmproj)" |
| Authority or gate change | 10 | 14% | "FULL permission to delete ALL OrcaRouter 3.8 27b model weights", "DISABLE JEV-GATE FOR ENTIRE SESSION" |
| Operator state report | 9 | 12% | "Rebooting Kakashi, brb", "I disabled the cloud JEV API key" |
| Context attachment / thread / skill reference | 7 | 9% | attached .md/.pdf plans, @thread references, [$skill] invocations |
| Approval / go | 6 | 8% | "GREENLIGHT", "CONTINUE", "Confirmed — launch the golden build on KAKASHI" |
| Taskboard reference | 5 | 7% | "13-16 on task list should be at spec level", pasted rows, "SWAP COLUMNN B AND E" |
| Question to the agent | 5 | 7% | "should I flip around the Kakashi ethernet ports?" |
| Status / report request | 5 | 7% | "List blocked and pending issues", "Bullet point remaining issues" |
| Correction | 4 | 5% | "BUDDY HOW MANY TIMES DO I HAVE TO TELL YOU ...", "you omitted - BULMA - BRUNSON ..." |
| Pasted terminal output | 3 | 4% | elevated PowerShell transcripts |
| Hold / stop | 2 | 3% | "YOU and your peers should not resume any work until I sent it to you" |
| Resource link / candidate | 2 | 3% | Hugging Face model URLs |
| Inline answers to the agent's own list | 1 | 1% | the agent's "Needs Item" list pasted back with answers in CAPS |

Shape: 24 of 74 messages (32%) are 40 characters or fewer; 11 are all caps (emphasis or a hard instruction, not anger to be managed); 6 carry attachments, 6 reference other Codex tasks, 1 used response annotations.

## What the orchestrator sent back (275 replies)

Median 896 characters, 90th percentile 2,398. 73 replies (27%) asked the operator for a decision; 27 used tables; 103 mentioned something blocked or on hold; only 4 cited task IDs, even after the board existed.

## The taskboard episodes and what they taught

1. Board created (msg 57): the operator wanted the orchestrator alone to create and maintain tasks, sub-agents limited to ticking a box that strikes the task, visible on monitor 2. Delivered as a 33-task board; one sub-agent completion proved the path.
2. "13-16 on task list should be at spec level" (msg 59): Astra asked whether that meant rows 13-16 or IDs T013-T016. The operator answered by pasting the rows (msg 60): rows 13-16 were T009-T012. Lesson: the operator reads GenOffice grid row numbers; resolve numbers as rows, state the mapping in one line, and only ask when the rows-vs-IDs readings differ and the next step changes the list. Encoded: lookup rowInterpretation.
3. Pasted rows (msgs 60 and 71): tab-separated, trailing empty cells, the operator's own statuses (PENDING, WAITING), no Done column when a range was copied. A whole-sheet copy (measured later from a real paste) is ~1000 rows x 26 columns with the header row and the "Revision" line. Encoded: header-mapped parsing, pasted revision vs HEAD (viewIsCurrent), stale-row flags.
4. "SWAP COLUMNN B AND E" (msg 70): the board was re-laid-out (B = Status, E = Done) but the reply never confirmed it, and the next reply merged msgs 70 and 71. Lesson: acknowledge every queued operator message separately, name the change and the revision; layout must persist in every later publish. Encoded: layout.columns, reply contract.
5. Rows T014-T018 pasted with "GREENLIGHT" (msg 71): an approval scoped to exactly the pasted rows. Lesson: apply approvals to the rows they came with, name those IDs, record the approval text as a note; nothing else inherits it.
6. Version tabs piling up: every publish opened a new tab; 7 snapshot tabs were open at once and GenOffice sat at ~4.2 GB working set. Operator: "does not create a new one in a new tab each time, WASTING RAM". Encoded: one live tab refreshed in place, displayed-revision check, tidy.

## Protocol derived from it

- Every taskboard-related message: lookup first (paste, IDs, rows, words or selection), then act.
- Answer with IDs + change + revision; say when their view is an older revision.
- Rows are grid rows unless the operator types T-numbers; state the mapping.
- Approvals, holds and permissions apply to exactly the scope they were given with; record them in the log via --note.
- Corrections and CAPS instructions override the agent's plan immediately; restate the corrected fact in the reply so it is not repeated a third time ("HOW MANY TIMES...").
- A status request gets a grouped list (BLOCKED, DECISION NEEDED, WAITING, ON HOLD first), not a narrative.
- Operator state reports ("I installed...", "Rebooting...") are facts to fold into the list: update evidence or status, reconcile.
- Never mark DONE on a partial check; use VERIFYING until the real end-to-end proof passes.
