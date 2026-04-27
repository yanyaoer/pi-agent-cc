---
description: Cancel a running task (or all running) by SIGTERM to the pi subprocess.
argument-hint: "[taskId]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" cancel $ARGUMENTS`
