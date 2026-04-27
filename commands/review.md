---
description: Run an adversarial reviewer pass on a task's worktree. Challenges the implementation rather than just verifying behaviour. Default gate between tester PASS and merge.
argument-hint: "<taskId> [--resume]"
allowed-tools: Bash(node:*), Agent, AskUserQuestion
---

Invoke the `pi-agent:pi-reviewer` subagent via the `Agent` tool (`subagent_type: "pi-agent:pi-reviewer"`), forwarding the raw user request as the prompt.

Raw user request:
$ARGUMENTS

Operating rules:

- If $ARGUMENTS is empty or does not contain a task id (`t001`, etc.), ask once via `AskUserQuestion` for the task id before routing to the subagent.
- The subagent is a thin forwarder; it will run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" review --task <id> [--resume]` once and return stdout unchanged.
- Return the subagent's stdout verbatim. Do not paraphrase or summarise the JSON verdict.
- This command is review-only — do not fix issues, apply patches, or suggest you are about to make changes.
- The review is adversarial by design: it focuses on whether the approach is correct, what assumptions it depends on, and where the design fails under stress. It is not just a stricter tester pass.
