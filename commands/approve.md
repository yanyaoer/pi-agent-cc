---
description: Force-approve a task (skip evaluator gate). Coordinator override.
argument-hint: "<taskId> <reason>"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" approve $ARGUMENTS`
