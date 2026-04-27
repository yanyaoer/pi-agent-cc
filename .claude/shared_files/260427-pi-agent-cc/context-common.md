# Context · 公共背景

## 项目背景

在 `/Users/yanyao/Projects/side/pi-agent-cc`（当前为空目录）搭建一个 **Claude Code 插件**。形态：根目录即插件（用户选定）。目标：把 Coordinator（主 Claude Code 对话）+ Planner / Developer / Tester / Evaluator 五个角色编排起来，支持"plan 讨论 → 并行派发 → FAIL 时 resume 修 bug → evaluator 双层验收"的完整回路。

**权威方案**：`/Users/yanyao/Projects/side/pi-agent-cc/.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`（已由用户批准，子任务均以此为准，有歧义以 plan 文件为准）。

## 项目目录结构（目标）

```
pi-agent-cc/
├── .claude-plugin/plugin.json        # plugin manifest
├── agents/                            # 4 个 CC 薄转发 subagent
├── commands/                          # 9 个 slash 命令
├── hooks/hooks.json                   # SessionStart 横幅
├── skills/pi-runtime/SKILL.md         # 内部契约
├── prompts/                           # 4 个角色 system prompt
├── schemas/                           # 3 个 JSON Schema
├── scripts/
│   ├── pi-companion.mjs               # 主 CLI 入口
│   ├── session-lifecycle-hook.mjs
│   └── lib/
│       ├── state.mjs
│       ├── workspace.mjs
│       ├── pi-runner.mjs
│       ├── worktree.mjs
│       ├── task-graph.mjs
│       ├── handoff.mjs
│       ├── evals.mjs
│       ├── render.mjs
│       └── prompts.mjs
├── package.json                       # type=module, bin: pi-companion
├── CLAUDE.md, README.md
├── .gitignore
└── .claude/settings.json              # allow Bash(node:*) + Bash(git:*)
```

## 关键技术决策

1. **session 捕获**：companion 自己生成 `.jsonl` 绝对路径通过 `pi --session <path>` 传入（pi main.ts L149 支持以 `.jsonl` 结尾的字符串直接当作路径）。`--resume <path>` 完美续接。
2. **pi 子进程隔离**：每次调用独立 `pi` 进程 = 独立 context window（这是"隔离上下文协作"的落地方式），不用 SDK 嵌入。
3. **并行 + git worktree**：每个 dev 任务独立 worktree (`.worktrees/<taskId>`) + 分支 `pi/<taskId>`；tester 在同 worktree 内；PASS 后 orchestrator 串行化 merge。
4. **薄转发 subagent**：4 个 subagent 都照抄 `codex-rescue.md` 模板，只做一次 Bash → `pi-companion.mjs <sub>`。
5. **结构化输出**：plan / test-report / eval-report 都有 JSON Schema，末条消息必须为严格 JSON。
6. **evaluator 双层**：Layer 1 是 `evals/*.mjs` node 脚本（量化指标）；Layer 2 是 LLM 评审（ACCEPT / REWORK / REJECT）。
7. **状态目录**：`${CLAUDE_PLUGIN_DATA}/state/{slug}-{hash}/`，slug+hash 逻辑从 codex-plugin-cc 原样复制。

## 核心回路（必须所有子任务保持一致）

```
/pi:plan <text>         → companion plan      → planner subagent (pi --session <planner.jsonl> --resume 可选)
                          写 plan.json (draft)
/pi:plan-confirm        → companion plan-confirm → 冻结 + 生成 tasks/*.json
/pi:start --parallel N  → companion orchestrate
  for each ready task (拓扑 + 并行度 N):
    git worktree add .worktrees/<id> -b pi/<id>
    pi --session dev-<id>.jsonl --mode json -p --append-system-prompt developer.md --tools 写 <body>
    pi --session test-<id>.jsonl --mode json -p --append-system-prompt tester.md --tools 读 <handoff-pkg>
    if FAIL:
      pi --resume dev-<id>.jsonl -p "修 bug: <issues>"
      pi --resume test-<id>.jsonl -p "复验: <issueIds>"
    loop until PASS or attempts >= maxAttempts
    PASS: git merge --no-ff pi/<id>
  全部 PASS → evaluate
/pi:evaluate            → companion evaluate  → Layer1 evals/*.mjs + Layer2 LLM 评审
/pi:report              → 汇总
```

## 关键复用点

| 来源 | 文件 | 用途 |
|---|---|---|
| codex-plugin-cc | `plugins/codex/scripts/lib/state.mjs` L29-56 | workspace slug+hash（原样复制到 `lib/workspace.mjs`） |
| codex-plugin-cc | `plugins/codex/agents/codex-rescue.md` | 4 个薄转发 subagent 模板 |
| codex-plugin-cc | `plugins/codex/commands/status.md` | `!`\`node ...\` `` bash-result 命令模板 |
| codex-plugin-cc | `plugins/codex/hooks/hooks.json` | SessionStart hook 格式 |
| pi-mono | `packages/coding-agent/examples/extensions/subagent/index.ts` L238-400 | spawn pi + JSONL 解析 + 并发控制 + abort，JS 重写到 `lib/pi-runner.mjs` |
| pi-mono | `packages/coding-agent/examples/extensions/subagent/agents/{scout,planner,reviewer,worker}.md` | `prompts/*.md` 格式参考 |
| pi-mono | `packages/coding-agent/examples/extensions/handoff.ts` L19-39 | 跨角色上下文压缩提示词 |
| pi-mono CLI | `packages/coding-agent/src/main.ts` L149/L239/L496 | `--session <path>` / `--resume` / `--mode json` / `-p` / `--append-system-prompt` / `--tools` 调用契约 |

## 构建/运行命令

```bash
# 初始化（P0 完成后）
cd /Users/yanyao/Projects/side/pi-agent-cc
npm install    # 如果有依赖

# 本地 CLI 冒烟
node scripts/pi-companion.mjs init
node scripts/pi-companion.mjs status --json

# Claude Code 挂载插件
# 在 CC 里：/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc
```

## Git 提交规范

- commit message 用英文
- 未经用户批准不 `git push`
- 每个子任务分支：`research/260427-pi-agent-cc/p<N>`
- 合并策略：按 P0 → (P1, P2, P3 并行) → P4 顺序合回 main（或当前默认分支）

## 相关 Postmortem

未发现 `.claude/postmortem/` 目录，无历史报告需要引用。

## 重要约束（所有子任务共同遵守）

1. **不得修改 plan 文件**（`.claude/plans/codex-plugin-cc-pi-mono-distributed-kurzweil.md`）—— 它是权威来源
2. **不得跨越依赖边界**：P1/P2/P3 不得修改对方的目录（除了公共 lib 接口必须先在 context 中约定）
3. **薄转发 subagent** 严格按 codex-rescue.md 模板，不做业务逻辑
4. **session 文件命名约定**：`{role}-{taskId}.jsonl` 放在 `state/sessions/`，全绝对路径
5. **所有代码 ES Module**（`.mjs`），Node 20+，无 TypeScript 编译步骤
6. **最少依赖**：能用 Node 标准库就用，必要时才加 npm 包
7. **先对齐 API 再开工**：P1 的 lib 模块接口签名必须在 P1 的 context 文件里先定义（见 context-p1）；P2/P3 依赖这些签名

## 跨任务共享约定（API 契约）

以下契约由 context-p1 权威定义，其他任务遵循：

- `state.mjs` 导出：`loadState()`, `saveState()`, `loadTask(id)`, `saveTask(task)`, `listTasks()`, `appendHistory(id, entry)`, `getStateDir()`
- `workspace.mjs` 导出：`resolveWorkspaceRoot()`, `getWorkspaceSlug()`, `getStateDir()`
- `pi-runner.mjs` 导出：`runPi({systemPromptPath, tools, sessionPath, resume, prompt, cwd, model, onEvent, signal})` → 返回 `{exitCode, lastMessage, events, sessionPath}`
- `worktree.mjs` 导出：`createWorktree(taskId, baseBranch)`, `removeWorktree(taskId, {force})`, `mergeWorktree(taskId, targetBranch)`, `listWorktrees()`
- `handoff.mjs` 导出：`buildTesterContext(taskId)`, `buildResumePrompt(role, taskId, issues)`
- `evals.mjs` 导出：`runEvals(evalFiles, ctx)` → `{results, totalPassed, totalFailed}`
- `task-graph.mjs` 导出：`getReadyTasks(tasks)`, `isTaskReady(task, tasks)`
- `prompts.mjs` 导出：`loadPrompt(name)` → 返回 prompt 文件绝对路径

## 验证方法

完成后端到端验证：
1. `node scripts/pi-companion.mjs init` 应创建 state 目录
2. 在 Claude Code 里 `/plugin install-local <this-repo>` 后 `/pi:` 应能出现补全
3. 演示流程（plan → confirm → start → status → report）在 demo 仓库中跑通
