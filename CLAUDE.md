# pi-agent-cc

Claude Code plugin orchestrating Planner / Developer / Tester / Evaluator subagents on top of pi-mono's `pi` CLI.

## Core workflow

1. `/pi:plan <text>` — iterative planning with planner subagent (natural-language iteration, state kept via pi's `--resume`)
2. `/pi:plan-confirm` — freeze plan into task records
3. `/pi:start [--parallel N]` — dispatch developers in isolated git worktrees → testers verify → evaluator gates
4. `/pi:status` / `/pi:report` — observe progress and final deliverable

Authoritative design doc: `.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`

## Conventions

- ES modules (`.mjs`), Node 20+, no TypeScript build step
- All paths in state files are absolute
- Session files named `{role}-{taskId}.jsonl` under the per-workspace state dir
- Worktree branches: `pi/<taskId>`
- Thin-forwarder subagents (one `Bash` call → `scripts/pi-companion.mjs <sub>`)
