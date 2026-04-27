---
description: Trigger a full evaluator pass (Layer-1 eval scripts + Layer-2 LLM review).
allowed-tools: Bash(node:*), Agent
---

Invoke the `pi-agent:pi-evaluator` subagent via the `Agent` tool (`subagent_type: "pi-agent:pi-evaluator"`).

Operating rules:

- The subagent is a thin forwarder; it will run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" evaluate` once and return stdout unchanged.
- Return the subagent's stdout verbatim. Do not paraphrase, summarize, or re-interpret the verdict.
