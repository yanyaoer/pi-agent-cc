---
description: Start the orchestration loop. Dispatches developers into isolated worktrees, runs testers, and finally evaluator.
argument-hint: "[--parallel N] [--auto-approve]"
allowed-tools: Bash(node:*), Agent
---

Run the orchestrator via a single Bash call:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" orchestrate $ARGUMENTS
```

Operating rules:

- The companion emits streaming JSONL progress events to stdout. Relay each event to the user as it arrives; do not buffer or paraphrase.
- If the companion's final output signals `evaluate-required` (or exits with a directive to evaluate), invoke the `pi-agent:pi-evaluator` subagent via the `Agent` tool (`subagent_type: "pi-agent:pi-evaluator"`) and return its stdout verbatim.
- Do not inspect the repository, patch tasks, or second-guess task status. All orchestration decisions live inside the companion.
- Do not summarize or rewrite progress events. Pass them through verbatim.
