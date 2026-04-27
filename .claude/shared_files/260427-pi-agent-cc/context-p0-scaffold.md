# P0 · 项目脚手架 + plugin manifest + git 初始化

## 任务目标

为 pi-agent-cc 建立最小可运行的骨架，让后续子任务（P1/P2/P3）可以在独立 worktree 中并行开工。

**为什么是基础前置**：P1/P2/P3 都需要 git 仓库（worktree）、`package.json`、`.claude-plugin/plugin.json` 已就位才能工作。

## 依赖任务

无（必须第一个完成）。

## 实现步骤

### 1. git init + 初始 commit

```bash
cd /Users/yanyao/Projects/side/pi-agent-cc
git init -b main
# git config（用户已有全局配置即可）
```

### 2. 创建 `.gitignore`

```gitignore
node_modules/
npm-debug.log
.DS_Store
.worktrees/
state/
*.log
```

### 3. 创建 `package.json`

```json
{
  "name": "pi-agent-cc",
  "version": "0.1.0",
  "description": "Claude Code plugin: multi-agent handoff orchestrator built on pi-mono.",
  "type": "module",
  "bin": {
    "pi-companion": "./scripts/pi-companion.mjs"
  },
  "scripts": {
    "test:cli": "node scripts/pi-companion.mjs init && node scripts/pi-companion.mjs status --json"
  },
  "engines": {
    "node": ">=20"
  },
  "author": "",
  "license": "MIT"
}
```

**原则**：尽量零依赖（用 Node 标准库）。如果 P1/P2 确实需要，再在 P4 阶段补充 devDependencies。

### 4. 创建 `.claude-plugin/plugin.json`

```json
{
  "name": "pi-agent",
  "version": "0.1.0",
  "description": "Multi-agent handoff, task decomposition, and QA loop built on pi-mono.",
  "author": { "name": "pi-agent-cc" }
}
```

保持极简（与 codex-plugin-cc 的 plugin.json 一致，只要 name/version/description/author）。

### 5. 创建目标目录的占位文件

创建以下空目录（用 `.gitkeep` 占位），让 P1/P2/P3 能直接 `git checkout` 后就看到结构：

```
agents/.gitkeep
commands/.gitkeep
hooks/.gitkeep
skills/.gitkeep
prompts/.gitkeep
schemas/.gitkeep
scripts/.gitkeep
scripts/lib/.gitkeep
```

### 6. 创建 `CLAUDE.md`（项目级提示）

```markdown
# pi-agent-cc

Claude Code plugin orchestrating Planner / Developer / Tester / Evaluator subagents on top of pi-mono's `pi` CLI.

Core workflow:
1. `/pi:plan <text>` — iterative planning with planner subagent
2. `/pi:plan-confirm` — freeze plan into tasks
3. `/pi:start --parallel N` — dispatch devs in isolated worktrees → testers verify → evaluator gates
4. `/pi:status` / `/pi:report` — observe progress

See `.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md` for the authoritative design.

## Conventions

- ES modules (`.mjs`), Node 20+, no TypeScript build step
- All paths in state files are absolute
- Session files named `{role}-{taskId}.jsonl` under the per-workspace state dir
- Worktree branches: `pi/<taskId>`
```

### 7. 最小 `README.md`

```markdown
# pi-agent-cc

Claude Code plugin for multi-agent task orchestration, built on [pi-mono](https://github.com/badlogic/pi-mono).

## Install

```
/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc
```

## Commands

- `/pi:plan <text>` — Discuss & iterate a plan
- `/pi:plan-confirm` — Freeze plan
- `/pi:start [--parallel N]` — Run dev/test/eval loop
- `/pi:status` — See progress
- `/pi:report` — Final report

Full design: see `.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`.
```

### 8. 初始 commit

```bash
git add .
git commit -m "Initial scaffold: plugin manifest, package.json, directory skeleton"
```

## 涉及文件清单

- `/Users/yanyao/Projects/side/pi-agent-cc/.gitignore`
- `/Users/yanyao/Projects/side/pi-agent-cc/package.json`
- `/Users/yanyao/Projects/side/pi-agent-cc/.claude-plugin/plugin.json`
- `/Users/yanyao/Projects/side/pi-agent-cc/CLAUDE.md`
- `/Users/yanyao/Projects/side/pi-agent-cc/README.md`
- `/Users/yanyao/Projects/side/pi-agent-cc/{agents,commands,hooks,skills,prompts,schemas,scripts,scripts/lib}/.gitkeep`

## 验证方法

```bash
cd /Users/yanyao/Projects/side/pi-agent-cc
git log --oneline          # 应有 1 条 initial commit
ls -la                      # 应看到所有目录
cat .claude-plugin/plugin.json | jq .
cat package.json | jq .
node -e "import('./package.json', { with: { type: 'json' } }).then(m => console.log(m.default.name))"
```

## 完成标准

- [ ] git 仓库初始化，`main` 分支，有一个 initial commit
- [ ] `.claude-plugin/plugin.json` 存在且 JSON 合法
- [ ] `package.json` 存在且 JSON 合法，`"type": "module"`
- [ ] 所有目标目录（agents/commands/hooks/skills/prompts/schemas/scripts/scripts/lib）已创建
- [ ] `.gitignore` 包含 `node_modules/`、`.worktrees/`、`state/`
- [ ] CLAUDE.md、README.md 就位（保持极简）

## 禁止事项

- **不得**在这一阶段写任何业务逻辑（如 pi-companion.mjs、state.mjs 等）—— 那是 P1 的工作
- **不得**创建 subagent/commands/schemas 等内容 —— 那是 P3/P2 的工作
- **不得** `git push`
