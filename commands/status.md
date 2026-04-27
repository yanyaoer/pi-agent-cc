---
description: Show current plan and task status.
argument-hint: "[taskId] [--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" status $ARGUMENTS`

If the user did not pass a task id:
- Render the command output as-is (the companion already emits a compact Markdown table, or raw JSON when `--json` is passed).
- Keep it concise. Do not add prose around the table.

If the user did pass a task id:
- Present the full command output verbatim.
- Do not summarize or condense it.
