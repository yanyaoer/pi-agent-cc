---
description: Print aggregated report (plan + test results + eval verdict).
argument-hint: "[--json]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" report $ARGUMENTS`
