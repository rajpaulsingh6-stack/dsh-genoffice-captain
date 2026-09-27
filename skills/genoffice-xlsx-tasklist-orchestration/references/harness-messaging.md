# Harness messaging adapters

The protocol is identical everywhere: the Captain sends the worker-brief.cjs text, waits, and reads replies that start with [TASKLIST DONE|BLOCKED|QUESTION Tnnn]; state lives only in the GenOffice task list. What changes per harness is how a message gets to another session. Tool names change between releases: list your tools first and use what your harness actually exposes. "Verified" below means confirmed in this fleet on 2026-09-27.

| Harness | Captain reaches workers with | Worker identity | Notes |
|---|---|---|---|
| Codex Desktop (verified) | list_threads / read_thread to find worker tasks, send_message_to_thread to dispatch, wait_threads to wait (rolling timeoutMs, compact snapshots), fork_thread to spawn a worker from the current context | the worker task's thread ID = its CODEX_THREAD_ID | create_thread only when the operator asked for new tasks; otherwise dispatch to tasks the operator created or named with @. The Codex app's own multi-agent tools, where present, are the native way to run subtasks. |
| Codex CLI | its native sub-agent / session tools where exposed; otherwise OpenCodexOrchestration run_subagent.py with an agent definition (run-agent: codex) | CODEX_THREAD_ID of the nested run, or TASKBOARD_ACTOR from the brief | Keep the tool timeout at least the run timeout; a quiet run is still running (sub-agents-skills). |
| Claude Code CLI | its Task / sub-agent tool for in-session workers; its inter-session messaging for separate sessions; run_subagent.py with run-agent: claude as the fallback | TASKBOARD_ACTOR=<identity from the brief> | Skill installs under ~/.claude/skills and is invoked as /GenOfficeXLSXTasklistOrchestration. |
| Claude Desktop | its conversation/project messaging, or the operator relays the brief; shell work through a terminal MCP | TASKBOARD_ACTOR | Register the genoffice MCP (genoffice mcp) so workers can read the sheet without a shell. |
| Cursor | its agent chats / background agents; cursor-agent via run_subagent.py (run-agent: cursor-agent) | TASKBOARD_ACTOR | npx skills add ... -a cursor installs the skill for Cursor. |
| OpenCode | its sub-agents (task tool / @agent) and session messaging; opencode run via run_subagent.py (run-agent: opencode) | TASKBOARD_ACTOR | |
| DeepSeek harness | its inter-session messaging; otherwise run_subagent.py with the backend it wraps | TASKBOARD_ACTOR | Confirm the send / wait tool names in the harness before the first wave. |
| Hermes Agent | its delegation / ACP session messaging; the worker runs the two commands with its terminal tool | TASKBOARD_ACTOR | The fleet's Hermes tool-search fans can call the genoffice MCP tools when no shell is available. |

Message formats (plain text, first line is machine-readable):

    Captain -> worker:  the worker-brief.cjs output, starting "[TASKLIST DISPATCH] Tnnn"
    Worker -> Captain:  [TASKLIST DONE Tnnn] <evidence summary>
                        [TASKLIST BLOCKED Tnnn] <reason>
                        [TASKLIST QUESTION Tnnn] <question>
    Captain -> worker:  [TASKLIST ANSWER Tnnn] <answer>   |   [TASKLIST RELEASE] <you may stop>

Rolling waits: 10-15 minute windows for real work; on timeout check the board (status, lookup Tnnn) and the worker's session, then keep waiting while it is alive. Never kill or restart a worker for being quiet.
