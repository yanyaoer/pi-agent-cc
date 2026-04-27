---
description: Discuss and iterate on a task plan with the planner subagent.
argument-hint: "<free-form requirements or follow-up feedback>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `pi-agent:pi-planner` subagent via the `Agent` tool (`subagent_type: "pi-agent:pi-planner"`), forwarding the raw user request as the prompt.

`pi-agent:pi-planner` is a subagent, not a skill — do not call it as a skill. The command runs inline so the `Agent` tool stays in scope; forked general-purpose subagents do not expose it.

Raw user request:
$ARGUMENTS

Operating rules:

- If the user supplied no request text, use `AskUserQuestion` exactly once to ask for the product or feature requirements before routing to the subagent.
- The planner subagent is a thin forwarder. It runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" plan "<text>"` once and returns stdout unchanged.
- After the subagent returns, relay its stdout verbatim. The stdout already includes the plan rendering from the companion.
- Then, in one short line, ask the user whether to iterate (call `/pi:plan` again with refinements) or confirm (call `/pi:plan-confirm`).
- Do not paraphrase, summarize, or rewrite the plan output. Do not draft tasks yourself.
