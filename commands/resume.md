---
description: Manually resume a developer or tester session for a specific task.
argument-hint: "<taskId> [--role developer|tester]"
allowed-tools: Bash(node:*), Agent
---

Parse the task id and optional `--role` from `$ARGUMENTS`.

Raw user request:
$ARGUMENTS

Routing rules:

- If `--role tester` is present: invoke the `pi-agent:pi-tester` subagent via the `Agent` tool (`subagent_type: "pi-agent:pi-tester"`), passing `<taskId> --resume` as its prompt.
- Otherwise (no role, or `--role developer`): invoke the `pi-agent:pi-developer` subagent via the `Agent` tool (`subagent_type: "pi-agent:pi-developer"`), passing `<taskId> --resume` as its prompt.
- The subagent is a thin forwarder; it will run the companion once and return stdout unchanged.
- Return the subagent's stdout verbatim. Do not paraphrase or add commentary.
- If no task id was supplied, ask the user which task to resume before routing.
