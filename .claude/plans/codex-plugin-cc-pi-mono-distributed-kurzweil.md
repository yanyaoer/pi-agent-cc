# pi-agent-cc · 多 Agent 协作 Claude Code 插件

## Context

在 `/Users/yanyao/Projects/side/pi-agent-cc`（当前空仓库）搭建一个 Claude Code plugin：
- **参考** `codex-plugin-cc`（plugin 外壳 + node companion CLI + 状态持久化）
- **底座** 使用 `pi-mono`（`pi` CLI 支持 `--session <path>` / `--resume` / `--mode json` / `-p` / `--append-system-prompt` / `--tools`，经 `packages/coding-agent/src/main.ts` L149/L239 验证）
- **形态**：Coordinator（主 Claude Code 对话）+ Planner + Developer + Tester + Evaluator，用 `pi` 子进程提供隔离上下文
- **核心回路**：plan 讨论 → 并行派发 dev（每任务一个 git worktree）→ tester 独立 Agent 验收 → FAIL 时 resume 修 bug（保留上下文）→ 全部 PASS 后 evaluator 跑 eval 用例验收

用户明确选择：**根目录即插件** · **并行 + git worktree 隔离** · **MVP 含 evaluator（带 eval 用例执行）** · **Planner 自然语言迭代**。

## 目录结构（根目录即插件）

```
pi-agent-cc/
├── .claude-plugin/plugin.json        # manifest
├── agents/                            # CC 薄转发 subagent
│   ├── pi-planner.md
│   ├── pi-developer.md
│   ├── pi-tester.md
│   └── pi-evaluator.md
├── commands/                          # slash 命令
│   ├── plan.md
│   ├── plan-confirm.md
│   ├── start.md
│   ├── status.md
│   ├── resume.md
│   ├── evaluate.md
│   ├── report.md
│   ├── approve.md
│   └── cancel.md
├── hooks/hooks.json                   # SessionStart 状态横幅
├── skills/pi-runtime/SKILL.md         # 内部契约
├── prompts/                           # 角色 system prompt
│   ├── planner.md
│   ├── developer.md
│   ├── tester.md
│   └── evaluator.md
├── schemas/                           # JSON Schema（校验结构化输出）
│   ├── plan.schema.json
│   ├── test-report.schema.json
│   └── eval-report.schema.json
├── scripts/
│   ├── pi-companion.mjs               # 主 CLI 入口
│   ├── session-lifecycle-hook.mjs
│   └── lib/
│       ├── state.mjs                  # 任务/session 持久化
│       ├── workspace.mjs              # slug+hash 隔离（复制 codex）
│       ├── pi-runner.mjs              # spawn pi --mode json 并解析 JSONL
│       ├── worktree.mjs               # git worktree add/remove/merge
│       ├── task-graph.mjs             # 依赖解析 + 可并行任务选择
│       ├── handoff.mjs                # dev ↔ tester 上下文桥
│       ├── evals.mjs                  # eval 用例执行器
│       ├── render.mjs                 # 状态表格/JSON
│       └── prompts.mjs                # 角色提示词加载
├── package.json                       # {"type":"module","bin":{"pi-companion":"./scripts/pi-companion.mjs"}}
├── CLAUDE.md
└── README.md
```

## Slash 命令

| 命令 | 作用 | allowed-tools | 路由 |
|---|---|---|---|
| `/pi:plan <自由文本>` | 自然语言与 planner 迭代；每次调用都 `pi --resume <planner-session>` | `Bash(node:*), Agent` | `pi-planner` subagent → `pi-companion.mjs plan <text>` |
| `/pi:plan-confirm` | 冻结 plan → 建 `tasks/*.json` | `Bash(node:*)` | `pi-companion.mjs plan-confirm` |
| `/pi:start [--parallel N] [--auto-approve]` | 启动编排主循环：派发 dev（worktree）→ tester → evaluator | `Bash(node:*), Agent` | `pi-companion.mjs orchestrate` |
| `/pi:status [taskId] [--json]` | 任务表（`!` bash 直出，零 LLM） | `Bash(node:*)` | `pi-companion.mjs status` |
| `/pi:resume <taskId> [--role developer\|tester]` | 手动续跑 | `Bash(node:*), Agent` | `pi-companion.mjs resume` |
| `/pi:evaluate` | 触发整体 eval 用例跑一次 | `Bash(node:*), Agent` | `pi-evaluator` subagent → `pi-companion.mjs evaluate` |
| `/pi:report [--json]` | plan + test + eval 汇总 | `Bash(node:*)` | `pi-companion.mjs report` |
| `/pi:approve <taskId> <reason>` | 强制通过某任务 | `Bash(node:*)` | `pi-companion.mjs approve` |
| `/pi:cancel [taskId]` | 终止运行中子进程 | `Bash(node:*)` | `pi-companion.mjs cancel` |

## Subagent（全部薄转发，复用 `codex-rescue.md` 模板）

| name | model | tools | 说明 |
|---|---|---|---|
| `pi-planner` | sonnet | `Bash` | 单一职责：`node scripts/pi-companion.mjs plan <text>`，回原文 stdout |
| `pi-developer` | sonnet | `Bash` | `pi-companion.mjs develop --task <id> [--resume]` |
| `pi-tester` | sonnet | `Bash` | `pi-companion.mjs test --task <id> [--resume]` |
| `pi-evaluator` | opus | `Bash` | `pi-companion.mjs evaluate` |

## Companion CLI 子命令（`scripts/pi-companion.mjs`）

所有子命令都写入 `${CLAUDE_PLUGIN_DATA}/state/{slug}-{hash}/`（slug+hash 逻辑直接从 `codex-plugin-cc/scripts/lib/state.mjs` L29-56 复制）。

| 子命令 | 职责 |
|---|---|
| `init` | 首次 bootstrap：建 state 目录、记录 repo 根 |
| `plan <text>` | 以 `prompts/planner.md` 为 system prompt 启动 pi（`--mode json -p --session <planner-session.jsonl> --append-system-prompt ... --resume` 若已有），解析末条消息为 `plan.schema.json`，写 `plan.json`（状态 `draft`），返回 markdown+JSON |
| `plan-confirm` | 校验 schema、生成 `tasks/t*.json`、`status=ready` |
| `orchestrate [--parallel N]` | 主循环（下节详述） |
| `develop --task <id> [--resume]` | 无 `--resume`：`git worktree add .worktrees/<taskId> -b pi/<taskId>` + `pi --session sessions/dev-<taskId>.jsonl -p --append-system-prompt prompts/developer.md <task-body>`；有 `--resume`：`pi --resume sessions/dev-<taskId>.jsonl -p "Tester 报告:<issues> 请修复"` |
| `test --task <id> [--resume]` | 在对应 worktree 内跑 tester，只读工具集；解析末条消息为 `test-report.schema.json`；失败时保留 `issues[]` |
| `evaluate` | 读 `plan.json` + 所有 `reports/*.test.json` + 运行 `lib/evals.mjs`（执行 eval 用例文件 → 汇总指标）+ 用 evaluator prompt 产出 `eval-report.json` |
| `status` / `resume` / `report` / `approve` / `cancel` | 状态/续跑/汇报/人工批准/取消 |

### 关键技术决策

- **session 捕获**：不依赖 pi 自动命名。companion 自己生成 `sessions/dev-<taskId>.jsonl` 绝对路径，通过 `--session <path>` 传给 pi（`main.ts` L149 支持 `.jsonl` 后缀直接作为路径）。后续 `--resume <path>` 完美续接。
- **pi 子进程隔离**：照抄 `packages/coding-agent/examples/extensions/subagent/index.ts` L306-400 的 spawn + JSONL 流式解析；每次调用独立进程 = 独立 context window（这正是图中"独立上下文"的落地方式）。
- **不用 `@mariozechner/pi-coding-agent` 嵌入 SDK**：用 CLI 更贴合 codex-plugin-cc 模式、天然沙箱、失败不污染 companion。

## 任务状态模型

`state/` 布局：
```
state/{slug}-{hash}/
├── state.json                # 全局：plan 状态、配置、运行中 jobs
├── plan.json                 # 最新 plan（draft|frozen）
├── tasks/tNNN.json           # 单任务记录
├── sessions/                 # 按 {role}-{taskId}.jsonl 命名
├── worktrees/                # {taskId → worktree 绝对路径+分支名}
└── reports/
    ├── tNNN.test.json        # 每次 test 结果（带版本号）
    └── final.eval.json
```

`tasks/tNNN.json` 结构：
```jsonc
{
  "id": "t001",
  "title": "...", "description": "...",
  "acceptance": ["unit pass", "a11y lint green"],
  "evals": ["evals/login-smoke.mjs"],        // 可选：引用 eval 用例
  "deps": [],
  "status": "ready|developing|testing|evaluating|done|blocked|cancelled",
  "attempts": 0, "maxAttempts": 5,
  "worktree": { "path": "...", "branch": "pi/t001" },
  "sessions": { "developer": "...", "tester": "..." },
  "history": [ { "ts":"...","role":"...","event":"...","summary":"..." } ]
}
```

状态机：`ready → developing → testing → (PASS→evaluating|FAIL→developing[resume]) → done`。attempts≥max 翻为 `blocked`，落到 coordinator 决策。

## Handoff 协议（核心回路）

对每个 task（在其专属 worktree 内）：

1. **Dev 首跑**：`pi --session sessions/dev-t001.jsonl --mode json -p --append-system-prompt prompts/developer.md --tools "read,write,edit,bash,grep,find,ls" "<task body + acceptance>"`。退出 0 视为 dev_done，记录 `sessions.developer`。
2. **Tester 首跑**：`lib/handoff.mjs` 组装上下文包（task 描述 + dev 最终摘要 + `git -C <worktree> diff pi/t001 main` + 涉及文件清单）→ `pi --session sessions/test-t001.jsonl --mode json -p --append-system-prompt prompts/tester.md --tools "read,bash,grep,find,ls" "<包>"`。要求末条消息输出严格 JSON（`test-report.schema.json` 校验）。
3. **FAIL → dev resume**：`pi --resume sessions/dev-t001.jsonl -p "Tester 报 issues:<json>, 请修复并再汇总"`。复用开发上下文 = 图中"谁写的 bug 谁修 保留开发上下文"。
4. **Re-test → tester resume**：`pi --resume sessions/test-t001.jsonl -p "Dev 声称修复，issueIds=<...>，请复验"`。= 图中"谁提的 bug 谁验"。
5. 循环直到 PASS 或 `attempts≥maxAttempts`。PASS 后由 orchestrator 把 worktree merge 回主分支（`git merge --no-ff pi/t001`）、标记 `status=done`。

## Plan 讨论（自然语言迭代）

- 首次 `/pi:plan <需求>`：companion 新建 `sessions/planner.jsonl`，跑 planner，schema 校验 → 写 `plan.json` → 渲染给用户
- 之后 `/pi:plan <修改意见>`：companion 以 `--resume sessions/planner.jsonl` 再次调用，planner 保留上下文产出新版（`plan.json` 覆盖，`version++`）
- `/pi:plan-confirm`：schema 终校 → 生成 `tasks/*.json`、`state.planStatus=frozen` → `/pi:start` 解锁

## 并行 + git worktree 策略

- `task-graph.mjs` 按 `deps` 拓扑排序，同时可派 `--parallel N`（默认 4）个无依赖任务
- 每个 dev 进入独立 worktree（`.worktrees/<taskId>`），分支 `pi/<taskId>`，完全隔离文件写入
- tester 在同一 worktree 内执行（共享 dev 产物）
- PASS 后 orchestrator 串行化 merge（避免 merge 冲突并发），冲突时标 `blocked` 让 coordinator 处理
- 失败或取消：`git worktree remove --force .worktrees/<taskId>` + `git branch -D pi/<taskId>`

## Evaluator + Evals 用例

用户强调"需添加 evals 用例执行效果验证"，故分两层：

**Layer 1 — 量化 eval 用例执行**（`lib/evals.mjs`）
- 每个 task 可在 `tasks/tNNN.json.evals[]` 声明 `evals/*.mjs` 文件
- eval 用例是简单 Node 脚本：`export default async function(ctx){ return {name, passed, metrics} }`
- `evals.mjs` 并发执行所有引用的 eval，汇总为 `eval-run.json`：`{results:[{file,passed,metrics,output}], totalPassed, totalFailed}`

**Layer 2 — LLM 评审**（evaluator subagent）
- 输入：`plan.json` + 所有 `reports/*.test.json` + `eval-run.json` + `git diff --stat` since plan freeze
- system prompt `prompts/evaluator.md` 要求末条输出：
  ```json
  { "score": 0-100, "verdict": "ACCEPT|REWORK|REJECT",
    "dimensions": {"functional":N,"quality":N,"coverage":N},
    "issues": [{"taskId":"t00x","severity":"...","detail":"..."}],
    "recommendations": "..." }
  ```
- `ACCEPT` → 全局 `done`；`REWORK` → 按 `issues.taskId` 回派 dev resume（attempts++）；`REJECT` → `state=blocked` 等 coordinator
- `/pi:approve <taskId> <reason>` 可绕过 evaluator 判决

## 进度同步 UX

- **主查询**：`/pi:status` markdown 表格（`status.md` 用 codex 的 `!`\`node ...\` `` 风格，零 LLM 开销；参考 `codex-plugin-cc/plugins/codex/commands/status.md`）；`--json` 便于管道
- **编排流**：`/pi:start` 运行时，companion 在 stdout 按 JSONL 流式发送 `{ts,taskId,role,event,...}`，coordinator 转述给用户
- **session 登录横幅**：`hooks/hooks.json` SessionStart 调 `session-lifecycle-hook.mjs` 打印挂起/运行任务摘要

## 复用点清单

| 来自 | 文件 | 用途 |
|---|---|---|
| codex-plugin-cc | `plugins/codex/scripts/lib/state.mjs` L29-56 | workspace slug+hash 原样复制到 `lib/workspace.mjs` |
| codex-plugin-cc | `plugins/codex/agents/codex-rescue.md` | 四个薄转发 subagent 模板 |
| codex-plugin-cc | `plugins/codex/commands/status.md` | `!`\`node ...\` `` bash-result 命令模板 |
| codex-plugin-cc | `plugins/codex/hooks/hooks.json` | SessionStart hook 格式 |
| pi-mono | `packages/coding-agent/examples/extensions/subagent/index.ts` L238-400 | spawn pi + JSONL 解析 + 并发控制 + abort 传播，JS 重写到 `lib/pi-runner.mjs` |
| pi-mono | `packages/coding-agent/examples/extensions/subagent/agents/{scout,planner,reviewer,worker}.md` | `prompts/*.md` 结构参考 |
| pi-mono | `packages/coding-agent/examples/extensions/handoff.ts` L19-39 | 压缩历史 → 跨角色上下文包的提示词范式 |
| pi-mono | `packages/coding-agent/examples/extensions/plan-mode/index.ts` | plan 步骤解析 + `[DONE:n]` 追踪思路 |
| pi-mono CLI | `packages/coding-agent/src/main.ts` L149, L239, L496, `cli/args.ts` | `--session <path>` / `--resume` / `--mode json` / `-p` / `--append-system-prompt` / `--tools` 的调用契约 |

## 关键文件（优先级）

1. `scripts/pi-companion.mjs` — 主入口，子命令分发
2. `scripts/lib/pi-runner.mjs` — pi 子进程生命周期 + JSONL 解析（复杂度最高）
3. `scripts/lib/state.mjs` — 任务/session/report 持久化
4. `scripts/lib/worktree.mjs` — git worktree CRUD + merge 协调
5. `scripts/lib/handoff.mjs` — dev/tester 上下文桥
6. `scripts/lib/evals.mjs` — eval 用例执行器
7. `schemas/*.json` — plan/test-report/eval-report 校验
8. `prompts/{planner,developer,tester,evaluator}.md` — 角色 prompt（质量决定系统上限）
9. `agents/*.md` — 4 个薄转发 subagent
10. `commands/*.md` — 9 个 slash 命令

## 分阶段实施

**Phase 1（MVP，用户选定范围）**：全部命令/subagent 脚手架 + state 持久化 + 单任务 dev↔tester 循环 + 1 个 worktree + evaluator + evals 执行 + `/pi:status`

**Phase 2**：并行多 worktree（`task-graph.mjs` 拓扑调度 + merge 协调）+ 失败重试策略 + `/pi:approve` `/pi:cancel`

**Phase 3**：SessionStart 横幅、`/pi:resume` 手动续跑、Stop-hook review gate（可选）、成本/token 预算

**Phase 4**：RPC mode（允许外部系统驱动）、多 repo 协同、可视化 HTML 报告

## 验证方案（端到端）

1. 准备一个小 demo 仓库（比如生成静态 html 的 `add-login-page` 需求）
2. `cd pi-agent-cc && npm link`（让 `pi-companion` 暴露到 PATH）
3. 在 Claude Code 里装插件：`/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc`
4. 在 demo repo 里：
   - `/pi:plan 做一个带 SSO 的 login 页面，要有 email+password 和 Google SSO 两条路径`
   - 观察 plan 是否合理；用 `/pi:plan` 补一次修改意见；`/pi:plan-confirm`
   - `/pi:start --parallel 2` → 观察多 worktree 同时进行、tester 发 bug、dev resume 修复
   - `/pi:status` 查看表格；任务全 PASS 后自动触发 evaluator
   - `/pi:evaluate` 手动再跑一次；`/pi:report` 看最终验收报告
5. 单元验证：
   - `node scripts/pi-companion.mjs init` → 检查 state 目录
   - 直接用 CLI 测试每个子命令（无需 Claude Code）
   - schemas 校验测试：故意投喂坏 JSON 验证拒绝路径

## 风险与遗留项

1. **Worktree merge 冲突**：两个无依赖 task 意外改到同一文件 → 暂行策略：冲突时整任务 `blocked`，让 coordinator 解；Phase 2 可考虑 plan 里声明 `touchedPaths` 做预检
2. **pi session 文件格式稳定性**：假设 pi 接受任意 `.jsonl` 路径作为 `--session`。上线前需运行最小脚本验证实际行为
3. **Eval 用例安全**：eval 脚本在当前 node 进程里执行，需要隔离（沙箱 / 子进程 / 超时）
4. **Planner 产出格式**：LLM 不严格跟 schema 时要重试（2 次上限）+ 人工兜底提示
5. **权限**：`.claude/settings.json` 需要给 `Bash(node:*)`、`Bash(git:*)`、以及 state 目录的 Write 权限，避免每次都弹框
