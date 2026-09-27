# NOTICE

GenOfficeXLSXTasklistOrchestration (Rajpaul Singh with Claude, 2026) adapts ideas from the following projects. It contains no code copied from them.

## sub-agents-skills

- Author: Shinsuke Kagawa (GitHub: shinpr)
- Repository: https://github.com/shinpr/sub-agents-skills (fleet copy: OpenCodexOrchestration, pinned at 84e1d4b3)
- License: MIT License, Copyright (c) 2026 Shinsuke Kagawa
- Used: agent-definition format (run-agent, model, permission), broker discipline for one sub-agent run, JSON status handling, Codex permission and timeout guidance. Workers can be launched with its scripts/run_subagent.py.

## Orca orchestration

- Author: stablyai (Orca, "the ADE for working with a fleet of parallel agents")
- Repository: https://github.com/stablyai/orca
- License: MIT License, Copyright (c) 2026 stablyai
- Used: Run / Task / Dispatch model, single worker_done with explicit outcome, ask/reply, escalation, decision gates, rolling waits, worker release, dependency waves, 3-failure circuit breaker, full handoff versus supervised dispatch. Source: the orchestration guide served by Orca 1.4.190 (orca skills get orchestration).

## GenOffice

- Author: Genspark (genspark-ai)
- Repository: https://github.com/genspark-ai/genoffice
- License: Apache License 2.0
- Used: the genoffice CLI and MCP through the GenOffice_XLSX_Tasklist skill.
