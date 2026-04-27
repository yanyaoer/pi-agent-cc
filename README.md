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
- A git repo as the working directory (plan/tasks are kept under
  `$CLAUDE_PLUGIN_DATA/state/<workspace-id>/`)
- One provider logged in via `npx pi --login` (the `pi` CLI is bundled as a
  dependency, so no global install is required)

Install dependencies:
```bash
npm install
```

The plugin's `postinstall` hook runs `pi-companion init` automatically to
create the state directory. `node_modules/.bin/pi` is used by the companion;
you can override with `PI_BIN=/path/to/pi` if needed.

## Commands

| Command | What it does |
|---|---|
| `/pi:plan <text>` | Discuss and iterate on a task plan with the planner subagent. |
| `/pi:plan-confirm` | Freeze the current draft plan into task records. Required before `/pi:start`. |
| `/pi:start [--parallel N] [--no-review]` | Start the orchestration loop. Dispatches developers into isolated worktrees, runs testers, then the **adversarial reviewer** (default gate; pass `--no-review` to skip), then evaluator. |
| `/pi:status` | Show current plan and task status. |
| `/pi:resume <taskId>` | Manually resume a developer or tester session for a specific task. |
| `/pi:review <taskId>` | Run an adversarial reviewer pass on a task's worktree (git diff + ast-grep cross-refs). Emits a structured review-report JSON. |
| `/pi:evaluate` | Trigger a full evaluator pass (Layer-1 eval scripts + Layer-2 LLM review). |
| `/pi:report` | Print aggregated report (plan + test results + eval verdict). |
| `/pi:approve <taskId> <reason>` | Force-approve a task (skip evaluator gate). Coordinator override. |
| `/pi:cancel [taskId]` | Cancel a running task (or all running) by SIGTERM to the `pi` subprocess. |

## Use outside of Claude Code

`pi-agent-cc` is a plain Node CLI and can drive the full workflow from any
shell, no Claude Code session required.

```bash
# Expose the binary globally (one-off):
npm link                # from the repo root, creates `pi-agent-cc` and
                        # `pi-companion` on PATH

# Or run without linking:
node scripts/pi-companion.mjs status --json
```

Then the whole surface is available directly:

```bash
pi-agent-cc init
pi-agent-cc plan 'build a login page with SSO'
pi-agent-cc plan 'split HTML and CSS into two tasks'
pi-agent-cc plan-confirm
pi-agent-cc orchestrate --parallel 2
pi-agent-cc status
pi-agent-cc report
```

### Implicit `plan` — multi-turn discussion

Anything that doesn't look like a subcommand (contains spaces, CJK
characters, leading `--`, etc.) is forwarded to the planner
automatically:

```bash
pi-agent-cc '我想做一个 X，先帮我想想项目目标'
# planner replies in discussion mode, asks 1-3 targeted questions
#   → goal? audience? constraints?

pi-agent-cc '给程序员用的 CLI，离线也能跑，Go 语言'
# planner still has the prior session open via --resume,
# so the follow-up sees the full history. Once enough context is
# gathered, the planner switches to plan mode and emits task JSON.

pi-agent-cc plan-confirm        # freeze once you're happy
pi-agent-cc orchestrate
```

The planner distinguishes two modes per turn based on what it has to
work with: **discussion** (no JSON, asks about goal/audience/
constraints) and **plan** (JSON task list). Sessions are preserved
across turns, so you can iterate as many rounds as you need without
losing context.

Everything the slash commands do is just a forwarded `pi-agent-cc <sub>`
call, so running it externally is fully supported — you just lose the
Claude Code rendering layer.

### Shell completion

The binary can emit its own completion script for `fish`, `bash`, or `zsh`:

```bash
# fish
pi-agent-cc completion fish > ~/.config/fish/completions/pi-agent-cc.fish

# bash (requires bash-completion; path may differ on Linux)
pi-agent-cc completion bash | sudo tee /usr/local/etc/bash_completion.d/pi-agent-cc

# zsh
pi-agent-cc completion zsh > "${fpath[1]}/_pi-agent-cc"
autoload -U compinit && compinit
```

Or eval inline for a throwaway shell:

```bash
source <(pi-agent-cc completion bash)   # bash
pi-agent-cc completion fish | source    # fish
```

Completion covers: all subcommands, per-subcommand flags, `--role
developer|tester`, and **live task-id lookup** for `--task`, `status`,
`approve`, `cancel`, `resume` — driven by the current plan's
`status --json` output (requires `jq` on PATH for the dynamic suggestions).

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

## Adversarial reviewer (default gate)

Every task goes through an adversarial reviewer **after tester PASS and
before merge**. The reviewer tries to break confidence in the change rather
than verify features.

**Context it receives** (pre-collected by the companion):
- `git diff <base>...HEAD` against the worktree's base branch
- Top-level symbols touched by the diff (extracted from hunk headers and,
  when `ast-grep` is available, via structural `ast-grep run --pattern`)
- Cross-references for those symbols via `ast-grep` + `ripgrep` (other call
  sites in the repo that reference what you just changed)

**Tools it has**: `read`, `grep`, `find`, `ls`, `bash` — no write/edit.
Through bash it can run `rg`, `ast-grep`, `git log -p`, and any
LSP-backed CLI already on `PATH` (`tsc --noEmit`, `pyright`,
`cargo check`, `go vet`, etc.) to follow the evidence.

**Output** is a structured JSON `review-report` with verdict
`approve | needs-attention` and concrete findings (file, line range,
severity, confidence, recommendation). A `needs-attention` verdict is
handed back to the developer as a follow-up prompt; the reviewer keeps its
own pi session so the re-review `--resume`s with full context.

Disable per-run via `/pi:start --no-review`, or globally via
`orchestration.review.enabled: false` in `pi-agent.config.json`, or via
`PI_AGENT_REVIEW_ENABLED=0`.

## Per-role LLM configuration

Each role (planner / developer / tester / **reviewer** / evaluator) can run
on a different model. Configuration is resolved in this order (highest wins):

1. Explicit `--model <id>` flag on the companion subcommand
2. Environment variable `PI_AGENT_<ROLE>_MODEL` (e.g. `PI_AGENT_EVALUATOR_MODEL`)
3. Workspace-level `pi-agent.config.json`
4. Built-in default (evaluator defaults to `claude-opus-4-7`; others delegate
   to pi's own default)

**Config file** (copy `pi-agent.config.example.json` to `pi-agent.config.json`
at your workspace root):

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "roles": {
    "planner":   { "model": "claude-sonnet-4-6" },
    "developer": { "model": "claude-sonnet-4-6" },
    "tester":    { "model": "claude-haiku-4-5" },
    "reviewer":  { "model": "claude-sonnet-4-6" },
    "evaluator": { "model": "claude-opus-4-7" }
  },
  "orchestration": {
    "review": { "enabled": true, "maxContextFiles": 25 }
  }
}
```

Each role entry may also set `tools` (csv or `"all"`) and
`appendSystemPrompt` (absolute path to an extra prompt file) for advanced
customisation.

### Gateways / OpenAI-compatible & Anthropic-compatible backends

Register any gateway (ZenMux, OpenRouter, Portkey, a self-hosted LiteLLM, …)
by adding a provider entry to `~/.pi/agent/models.json` and then referring
to it from `pi-agent.config.json` as `<provider>/<model-id>`.

Ready-made pairs live under [`examples/`](./examples/):

| Profile | Gateway | Wire | Models | Best for |
|---|---|---|---|---|
| [`examples/zenmux-responses/`](./examples/zenmux-responses/) | `https://zenmux.ai/api/v1` | `openai-responses` (Codex-style) | `openai/gpt-5.5-pro` | All five roles on a single strong reasoning model |
| [`examples/zenmux-anthropic/`](./examples/zenmux-anthropic/) | `https://zenmux.ai/api/anthropic` | `anthropic-messages` | `claude-haiku-4.5`, `claude-sonnet-4.6`, `claude-opus-4.7` | Haiku for tester, Sonnet for plan/dev, Opus for reviewer + evaluator |

Install either with:

```bash
cp examples/<profile>/models.json ~/.pi/agent/models.json
cp examples/<profile>/pi-agent.config.json ./pi-agent.config.json
export ZENMUX_API_KEY=sk-zm-...
node_modules/.bin/pi --list-models   # verify the gateway is visible
```

See [`examples/README.md`](./examples/README.md) for the per-role rationale
and how to add your own profile.

**Env overrides** (useful for CI or quick experiments):

```bash
PI_AGENT_DEFAULT_MODEL=claude-sonnet-4-6 \
PI_AGENT_PLANNER_MODEL=claude-opus-4-7 \
  /pi:plan "..."
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
