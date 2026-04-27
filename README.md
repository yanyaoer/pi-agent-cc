# pi-agent-cc

Claude Code plugin for multi-agent task orchestration, built on [pi-mono](https://github.com/badlogic/pi-mono).

## Install

```
/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc
```

Requires: pi CLI (`pi --help`), Node 20+.

## Commands

- `/pi:plan <text>` — Discuss & iterate a plan
- `/pi:plan-confirm` — Freeze plan
- `/pi:start [--parallel N]` — Run dev/test/eval loop
- `/pi:status` — See progress
- `/pi:resume <taskId>` — Resume a dev/tester session
- `/pi:evaluate` — Trigger full evaluator pass
- `/pi:report` — Final report
- `/pi:approve <taskId> <reason>` — Force-approve a task
- `/pi:cancel [taskId]` — Cancel running task(s)

## Design

Full design in `.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`.
