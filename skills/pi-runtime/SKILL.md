---
name: pi-runtime
description: Internal contract for calling the pi-companion runtime from Claude Code subagents. Not user-invocable.
user-invocable: false
---

# pi-runtime skill

Use this skill only inside the `pi-agent:pi-planner`, `pi-agent:pi-developer`, `pi-agent:pi-tester`, and `pi-agent:pi-evaluator` subagents. It documents the expected Bash invocation contract so the forwarders stay in lockstep with the companion CLI.

## Entry point

`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" <subcommand> [flags...]`

`${CLAUDE_PLUGIN_ROOT}` is the absolute path to this plugin's root (since the repo root *is* the plugin). State lives under `${CLAUDE_PLUGIN_DATA}/state/{slug}-{hash}/`.

## Subcommands

| Subcommand | Flags | Expected caller |
|---|---|---|
| `init` | — | SessionStart hook |
| `plan <text>` | — | `pi-agent:pi-planner` |
| `plan-confirm` | — | `/pi:plan-confirm` (bash-result) |
| `develop --task <id> [--resume]` | — | `pi-agent:pi-developer` |
| `test --task <id> [--resume]` | — | `pi-agent:pi-tester` |
| `evaluate` | — | `pi-agent:pi-evaluator` |
| `orchestrate` | `[--parallel N] [--auto-approve]` | `/pi:start` |
| `status` | `[taskId] [--json] [--banner]` | `/pi:status`, SessionStart hook |
| `resume <taskId>` | `[--role developer\|tester]` | `/pi:resume` (routes to subagent) |
| `report` | `[--json]` | `/pi:report` (bash-result) |
| `approve <taskId> <reason>` | — | `/pi:approve` (bash-result) |
| `cancel` | `[taskId]` | `/pi:cancel` (bash-result) |

## Stdout conventions

- `init` / `plan-confirm` / `approve` / `cancel`: single JSON summary line.
- `plan` / `develop` / `test` / `evaluate`: JSON result as the last stdout line; human-readable lines may precede it.
- `orchestrate`: streaming JSONL progress events (one event per line).
- `status` / `report`: Markdown by default; raw JSON when `--json` is passed.
- `status --banner`: emits a compact single-line banner only when jobs are running or pending; silent otherwise.

## Forwarder rules (shared by all four subagents)

- Use exactly one `Bash` call per invocation. Never chain multiple companion subcommands in a single subagent run.
- Preserve the user's text verbatim; strip only routing flags (`--resume`) that belong to the CC side.
- Do not inspect the repository, read files, reason about the task, or summarize output.
- Return the companion stdout exactly as-is.
- If the Bash call fails, return nothing.

## Execution safety

- Bash `allowed-tools` is pinned to `Bash(node:*)`; do not widen it.
- `--resume` is handled by the companion via its `.jsonl` session files under `state/sessions/`. Never manipulate those files from CC side.
- Worktrees under `.worktrees/<taskId>` and branches `pi/<taskId>` are owned by the companion. Subagents must not call `git worktree` / `git branch` directly.
