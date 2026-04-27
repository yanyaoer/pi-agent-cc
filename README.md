# pi-agent-cc

Claude Code plugin that orchestrates a four-role multi-agent workflow
(planner -> developer -> tester -> evaluator) on top of
[pi-mono](https://github.com/badlogic/pi-mono)'s `pi` CLI.

The plugin ships slash commands, subagents, prompts, JSON schemas, and a
companion CLI (`scripts/pi-companion.mjs`) that owns all state and process
supervision. Claude Code itself stays on the orchestration/UI layer and
forwards the heavy lifting to `pi` subprocesses running each role with a
role-specific system prompt.

## Install

```
/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc
```

Prereqs:
- Node.js >= 20
- `pi` CLI on PATH (run `pi --help` to check), logged in to at least one
  provider via `pi --login`
- A git repo as the working directory (plan/tasks are kept under
  `$CLAUDE_PLUGIN_DATA/state/<workspace-id>/`)

## Commands

| Command | What it does |
|---|---|
| `/pi:plan <text>` | Discuss and iterate on a task plan with the planner subagent. |
| `/pi:plan-confirm` | Freeze the current draft plan into task records. Required before `/pi:start`. |
| `/pi:start [--parallel N]` | Start the orchestration loop. Dispatches developers into isolated worktrees, runs testers, then evaluator. |
| `/pi:status` | Show current plan and task status. |
| `/pi:resume <taskId>` | Manually resume a developer or tester session for a specific task. |
| `/pi:evaluate` | Trigger a full evaluator pass (Layer-1 eval scripts + Layer-2 LLM review). |
| `/pi:report` | Print aggregated report (plan + test results + eval verdict). |
| `/pi:approve <taskId> <reason>` | Force-approve a task (skip evaluator gate). Coordinator override. |
| `/pi:cancel [taskId]` | Cancel a running task (or all running) by SIGTERM to the `pi` subprocess. |

The companion CLI is usable directly too:

```
node scripts/pi-companion.mjs init
node scripts/pi-companion.mjs status --json
node scripts/pi-companion.mjs plan "build a login page"
```

## 5-minute quickstart

```bash
# 1. Install plugin (in Claude Code)
/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc

# 2. Open a demo project in Claude Code
mkdir -p /tmp/pi-agent-demo && cd /tmp/pi-agent-demo
git init -b main && echo "# demo" > README.md && git add -A && git commit -m init
# (open this directory in Claude Code)

# 3. Draft a plan, iterate, confirm
/pi:plan make a login.html with email + password inputs, a submit button, and basic CSS
/pi:plan split HTML and CSS into two independent tasks
/pi:plan-confirm

# 4. Run the loop in parallel
/pi:start --parallel 2

# 5. Observe + wrap up
/pi:status
/pi:report
```

## Architecture

```
+-------------------------------------------------------+
|  Claude Code session                                  |
|                                                       |
|  /pi:* slash command                                  |
|       |                                               |
|       v                                               |
|  subagent (pi-planner / developer / tester / eval)    |
|       |  (thin forwarder, Bash tool only)             |
|       v                                               |
|  $ node scripts/pi-companion.mjs <sub> [flags]        |
|       |                                               |
|       +-- lib/state.mjs     (JSON persistence)        |
|       +-- lib/workspace.mjs (state dir resolution)    |
|       +-- lib/worktree.mjs  (git worktree per task)   |
|       +-- lib/pi-runner.mjs (spawns `pi` subprocess)  |
|       +-- lib/schema.mjs    (draft-07 subset, 0 deps) |
|       +-- lib/handoff.mjs   (role -> role prompts)    |
|       +-- lib/evals.mjs     (Layer-1 eval fork pool)  |
|       +-- lib/handlers/*    (one per subcommand)      |
+-------------------------------------------------------+
                    |
                    v
             pi subprocess (pi-mono)
             with role system prompt
                    |
                    v
             model provider API
```

State layout (under `$CLAUDE_PLUGIN_DATA/state/<workspace-id>/`):

```
state.json        # plan status + global metadata
plan.json         # frozen plan (after /pi:plan-confirm)
tasks/<id>.json   # per-task record (status, worktree, history)
reports/<id>-*.md # test reports
reports/eval.json # evaluator verdict
sessions/<role>-<id>.jsonl  # pi session transcripts
```

## Known limitations / roadmap

This is Phase 1: single-machine, single-repo orchestration with the four
canonical roles, local git worktrees, and sequential-or-parallel task
dispatch.

Planned for later phases (see `.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`):
- Phase 2: richer orchestration policies (DAG-aware scheduling, retry/backoff,
  cost budgets, per-task model pinning)
- Phase 3: distributed execution (remote workers, shared state over object
  storage, resumable sessions across machines)
- Pluggable role library (custom subagents beyond the default four)
- First-class CI runner for Layer-1 evals
- Web UI for plan review / diff inspection

Current constraints to be aware of:
- Git worktrees are created under the workspace root; a clean repo is
  required before `/pi:start`
- JSON schema validator is a hand-rolled draft-07 subset — `$ref`, `oneOf`,
  `anyOf` are not implemented yet
- Only SessionStart hook is wired; no UserPromptSubmit / PostToolUse hooks
- `pi` CLI must be globally available; no bundled binary

## Debugging and troubleshooting

- Inspect state: `node scripts/pi-companion.mjs status --json`
- Enable verbose errors: `PI_COMPANION_DEBUG=1 node scripts/pi-companion.mjs <sub>`
- Override state location: `CLAUDE_PLUGIN_DATA=/tmp/my-state node scripts/pi-companion.mjs init`
- Session transcripts live under `<state-dir>/sessions/` — tail them to
  watch a role think in real time
- If a worktree gets stuck: `git -C <workspace> worktree list`, then
  `git worktree remove --force <path>`
- If `/pi:start` exits immediately with "plan not confirmed": run
  `/pi:plan-confirm` first
- If `pi` fails to start: check `pi --help` works standalone, and that at
  least one provider key is configured (`pi --login` or equivalent env var)

## Design doc

Full design: `.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`.

## License

MIT
