# P3 · Claude Code 集成层（subagents + commands + skill + hooks）

## 任务目标

写 Claude Code 能识别的所有 markdown/JSON 资源：让用户在 CC 里可以输入 `/pi:*` 并正确路由到 companion CLI。这一层**不含业务逻辑**，全是声明式配置。

## 依赖任务

- P0（需要 `.claude-plugin/plugin.json`、目录结构）
- **不依赖 P1/P2 的代码实现**，因为本任务只定义"调用契约"—— 参考 context-common.md 约定的 companion 子命令名即可

**重点**：P3 可与 P1/P2 完全并行，完成后验证调用路径即可（即使 pi-companion.mjs 还未实现，subagent 能跑 Bash 就算完成）。

## 关键复用源

- **`codex-plugin-cc/plugins/codex/agents/codex-rescue.md`** —— 4 个 subagent 的模板（薄转发，一次 Bash）
- **`codex-plugin-cc/plugins/codex/commands/rescue.md`** —— slash 命令路由到 subagent 的模板
- **`codex-plugin-cc/plugins/codex/commands/status.md`** —— bash-result 直出命令模板（`!`\`node ...\` ``）
- **`codex-plugin-cc/plugins/codex/hooks/hooks.json`** —— SessionStart hook 格式
- **`codex-plugin-cc/plugins/codex/skills/codex-cli-runtime/SKILL.md`** —— 内部 skill 格式（可选参考）

## 实现步骤

### 1. Subagents（4 个）—— `agents/*.md`

全部照抄 `codex-rescue.md` 结构：YAML frontmatter + 明确"薄转发"指令 + 一次 `Bash` 调用 `${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs <sub>`。

#### `agents/pi-planner.md`

```markdown
---
name: pi-planner
description: Use this subagent to draft or iterate on a task plan. Accepts free-form requirement text; returns a plan JSON (draft).
model: sonnet
tools: Bash
---

You are a thin forwarding wrapper around the pi-agent-cc planner runtime.

Your only job: forward the user's plan request to the companion script. Do not do anything else.

Forwarding rules:
- Use exactly one `Bash` call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" plan "$USER_TEXT"`.
- Preserve the user's text verbatim (pass as a single argument).
- Return stdout exactly as-is.
- Do not inspect files, reason about the plan, or add commentary.
```

#### `agents/pi-developer.md`

```markdown
---
name: pi-developer
description: Use this subagent to develop a single task in its isolated git worktree. Coordinator invokes this via /pi:start or /pi:resume.
model: sonnet
tools: Bash
---

You are a thin forwarding wrapper around the pi-agent-cc developer runtime.

Forwarding rules:
- Parse the task id from the user's input.
- Use exactly one `Bash` call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" develop --task <id> [--resume]`.
- If the user's request includes the word "resume" or references prior work, add `--resume`.
- Return stdout exactly as-is. Do not add commentary.
```

#### `agents/pi-tester.md`

```markdown
---
name: pi-tester
description: Use this subagent to verify a completed task via an independent read-only session. Typically triggered after pi-developer finishes.
model: sonnet
tools: Bash
---

You are a thin forwarding wrapper around the pi-agent-cc tester runtime.

Forwarding rules:
- Parse the task id from the user's input.
- Use exactly one `Bash` call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" test --task <id> [--resume]`.
- Use `--resume` when re-verifying a previously failed task.
- Return stdout exactly as-is.
```

#### `agents/pi-evaluator.md`

```markdown
---
name: pi-evaluator
description: Use this subagent to run final quality evaluation once all tasks have passed tester. Runs Layer-1 eval scripts + Layer-2 LLM review.
model: opus
tools: Bash
---

You are a thin forwarding wrapper around the pi-agent-cc evaluator runtime.

Forwarding rules:
- Use exactly one `Bash` call: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" evaluate`.
- Return stdout exactly as-is. Do not attempt to re-interpret or summarize the verdict.
```

### 2. Slash Commands（9 个）—— `commands/*.md`

#### `commands/plan.md`（路由到 subagent）

```markdown
---
description: Discuss and iterate on a task plan with the planner subagent.
argument-hint: "<free-form requirements or follow-up feedback>"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `pi-agent:pi-planner` subagent via the `Agent` tool, passing the raw user input as the prompt.

If the user provides no input, prompt them (via AskUserQuestion) for the requirements before routing.

Raw user request:
$ARGUMENTS

After the subagent returns, render the plan JSON as a markdown checklist for the user to review. Then ask whether they want to: iterate (call /pi:plan again with refinements), or confirm (call /pi:plan-confirm).
```

#### `commands/plan-confirm.md`（bash-result 直出）

```markdown
---
description: Freeze the current draft plan into task records. Required before /pi:start.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" plan-confirm`
```

#### `commands/start.md`

```markdown
---
description: Start the orchestration loop. Dispatches developers into isolated worktrees, runs testers, and finally evaluator.
argument-hint: "[--parallel N] [--auto-approve]"
allowed-tools: Bash(node:*), Agent
---

Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" orchestrate $ARGUMENTS`.

The companion emits streaming JSONL progress to stdout. Relay each event to the user as it arrives. If the companion signals `evaluate-required`, invoke the `pi-agent:pi-evaluator` subagent via Agent tool.

Do not paraphrase task output — pass it through verbatim.
```

#### `commands/status.md`（bash-result 直出）

```markdown
---
description: Show current plan and task status.
argument-hint: "[taskId] [--json]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" status $ARGUMENTS`
```

#### `commands/resume.md`

```markdown
---
description: Manually resume a developer or tester session for a specific task.
argument-hint: "<taskId> [--role developer|tester]"
allowed-tools: Bash(node:*), Agent
---

Parse the task id and optional role from $ARGUMENTS.

- If role is `developer` or not specified: invoke `pi-agent:pi-developer` subagent with `<taskId> --resume`.
- If role is `tester`: invoke `pi-agent:pi-tester` subagent with `<taskId> --resume`.
```

#### `commands/evaluate.md`

```markdown
---
description: Trigger a full evaluator pass (Layer-1 eval scripts + Layer-2 LLM review).
allowed-tools: Bash(node:*), Agent
---

Invoke the `pi-agent:pi-evaluator` subagent via Agent tool. Return its output verbatim.
```

#### `commands/report.md`（bash-result 直出）

```markdown
---
description: Print aggregated report (plan + test results + eval verdict).
argument-hint: "[--json]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" report $ARGUMENTS`
```

#### `commands/approve.md`

```markdown
---
description: Force-approve a task (skip evaluator gate). Coordinator override.
argument-hint: "<taskId> <reason>"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" approve $ARGUMENTS`
```

#### `commands/cancel.md`

```markdown
---
description: Cancel a running task (or all running) by SIGTERM to the pi subprocess.
argument-hint: "[taskId]"
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" cancel $ARGUMENTS`
```

### 3. 内部 Skill —— `skills/pi-runtime/SKILL.md`

不对用户暴露，记录 subagent 的调用契约，防止后续改错：

```markdown
---
name: pi-runtime
description: Internal contract for calling the pi-companion runtime from Claude Code subagents. Not user-invocable.
---

# pi-runtime skill

This skill documents the expected bash invocation contract that `pi-planner` / `pi-developer` / `pi-tester` / `pi-evaluator` subagents use.

## Entry point

`node "${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs" <subcommand> [flags...]`

## Subcommands

| Subcommand | Flags | Expected caller |
|---|---|---|
| `init` | — | SessionStart hook |
| `plan <text>` | — | pi-planner |
| `plan-confirm` | — | /pi:plan-confirm |
| `develop --task <id> [--resume]` | — | pi-developer |
| `test --task <id> [--resume]` | — | pi-tester |
| `evaluate` | — | pi-evaluator |
| `orchestrate` | `[--parallel N] [--auto-approve]` | /pi:start |
| `status` | `[taskId] [--json]` | /pi:status |
| `resume <taskId>` | `[--role developer\|tester]` | /pi:resume |
| `report` | `[--json]` | /pi:report |
| `approve <taskId> <reason>` | — | /pi:approve |
| `cancel` | `[taskId]` | /pi:cancel |

Stdout conventions:
- `init` / `plan-confirm` / `approve` / `cancel` emit a single JSON summary line.
- `plan` / `develop` / `test` / `evaluate` emit a JSON result line as the last stdout line.
- `orchestrate` emits streaming JSONL progress events.
- `status` / `report` emit markdown unless `--json` is passed.
```

### 4. Hooks —— `hooks/hooks.json` + `scripts/session-lifecycle-hook.mjs`

```json
{
  "description": "pi-agent-cc lifecycle hooks.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

`scripts/session-lifecycle-hook.mjs`：

```js
#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const event = process.argv[2];
if (event === 'SessionStart') {
  // 调 companion status --banner
  const child = spawn('node', [path.join(__dirname, 'pi-companion.mjs'), 'status', '--banner'], {
    stdio: 'inherit',
  });
  child.on('exit', () => process.exit(0));
}
```

（`status --banner` 由 P1 的 status handler 支持：仅有 task 在运行或挂起时才输出简短一行；否则静默。）

### 5. 权限预设（可选，建议放到 P4）

注意：`.claude/settings.json`（项目级允许列表）推荐由 P4 做，避免和 P0 的 gitignore 冲突。

## 涉及文件清单

- `agents/pi-planner.md`
- `agents/pi-developer.md`
- `agents/pi-tester.md`
- `agents/pi-evaluator.md`
- `commands/plan.md`
- `commands/plan-confirm.md`
- `commands/start.md`
- `commands/status.md`
- `commands/resume.md`
- `commands/evaluate.md`
- `commands/report.md`
- `commands/approve.md`
- `commands/cancel.md`
- `skills/pi-runtime/SKILL.md`
- `hooks/hooks.json`
- `scripts/session-lifecycle-hook.mjs`

## 验证方法

```bash
# 静态：所有 markdown YAML frontmatter 可解析
for f in agents/*.md commands/*.md skills/*/SKILL.md; do
  node -e "
    const fs = require('fs');
    const txt = fs.readFileSync('$f', 'utf8');
    const m = txt.match(/^---\n([\s\S]+?)\n---/);
    if (!m) { console.error('NO frontmatter: $f'); process.exit(1); }
    console.log('$f OK');
  "
done

# hooks.json 合法 JSON
cat hooks/hooks.json | jq .

# session hook 脚本可运行（即使 companion 还没实现，应优雅 fallback）
chmod +x scripts/session-lifecycle-hook.mjs
node scripts/session-lifecycle-hook.mjs SessionStart
```

安装到 CC 之后：
```
/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc
/help   # 应看到 /pi:* 命令
```

## 完成标准

- [ ] 4 个 subagent markdown，YAML frontmatter 完整（name/description/model/tools）
- [ ] 9 个 command markdown，frontmatter + allowed-tools 正确
- [ ] `skills/pi-runtime/SKILL.md` 存在
- [ ] `hooks/hooks.json` 合法 JSON
- [ ] `session-lifecycle-hook.mjs` 可执行，SessionStart 情况下静默（有任务时简短打印）
- [ ] 所有 subagent 都严格"薄转发"——没有内嵌业务逻辑

## 禁止事项

- **不得**在 subagent / command 里写业务逻辑 —— 任何逻辑都必须走 pi-companion.mjs
- **不得**把 Bash 的 allowed-tools 放开到 `Bash(*)` —— 保持 `Bash(node:*)` 精度
- **不得**实现 companion CLI —— 那是 P1/P2 的工作
