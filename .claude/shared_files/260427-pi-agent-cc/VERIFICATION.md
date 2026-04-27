# pi-agent-cc 验证记录 · 2026-04-27

## 静态冒烟

- 所有 `.mjs` 静态 `import`: OK
  - `scripts/pi-companion.mjs`（已接入 P2 的 9 个 handler）
  - `scripts/session-lifecycle-hook.mjs`（加载即触发 `status --banner`，设计如此）
  - `scripts/lib/*.mjs`（state / workspace / render / pi-runner / worktree / evals / handoff / prompts / schema / task-graph）
  - `scripts/lib/handlers/*.mjs`（10 个文件全部 OK）
- `schemas/*.json` 合法: OK（3 个 draft-07 schema）
- `hooks/hooks.json` 合法: OK
- `.claude-plugin/plugin.json` 合法: OK
- `package.json` 合法: OK
- `session-lifecycle-hook SessionStart` exit=0: OK
  - 输出为 `status --banner`，空库下只有简短 "No tasks yet" 提示，符合设计

## CLI 烟测

用 `CLAUDE_PLUGIN_DATA=/tmp/pi-agent-cc-p4-test` 隔离跑：

- `pi-companion init`: OK
  - state 目录创建于 `/tmp/pi-agent-cc-p4-test/state/pi-agent-cc-26e5447f1b43d0dc`
  - state.json 初始化为 `{ planStatus: "none", workspace: ... }`
  - exit=0
- `pi-companion status --json`: OK
  - 返回 `planStatus=none`, `totalTasks=0`, `statusCounts` 齐备 7 个状态桶
  - exit=0

## 依赖检查

- `rg "^import .* from '[^./]" scripts/` 结果：**无外部 npm 包**，全部 `node:*` 内置
- `package.json` 的 `dependencies` 保持空（零依赖）
- P2 的手写 `schema.mjs`（draft-07 子集）避免了 ajv 依赖
- 无需 `npm install`

## 权限预设

- 新增 `.claude/settings.json`（项目级，入库），包含常用 bash 白名单：
  - `Bash(node scripts/pi-companion.mjs:*)`
  - `Bash(node scripts/session-lifecycle-hook.mjs:*)`
  - `Bash(git worktree:*|branch:*|merge:*|checkout:*|diff:*|status:*|log:*)`
  - `Bash(pi:*)`
- 保留用户 `.claude/settings.local.json` 不动（仅 additionalDirectories + git worktree）

## 端到端

- `which pi` -> `pi not found`（本机未安装 pi CLI）
- 测试环境：**没有 pi CLI / 也没有模型 provider key**
- 已跑通：companion 层的 init / status / schema / hook 全部静态 + 基础 CLI 冒烟
- 未覆盖（留给用户在配好 pi 的环境跑）：
  - `/pi:plan` → `/pi:plan-confirm` → `/pi:start` 完整闭环
  - 实际 developer/tester/evaluator 角色的 pi 子进程行为
  - worktree 合并冲突路径
  - Layer-1 evals fork 池的真实负载

## 代码改动 / 清理

- `scripts/pi-companion.mjs`: 把 9 个 `notImplementedBy('P2')` stub 换成对 `scripts/lib/handlers/*.mjs` 默认导出的直接引用；删掉未用到的 `import path from 'node:path'`
- `scripts/lib/handlers/develop.mjs`: 删掉未用到的 `import path from 'node:path'`
- P2 的 handler 签名统一为 `async (argv: string[]) => void`，与 P1 的 dispatch 契约天然对齐，**无需参数适配**
- 不改 P1/P2/P3 的核心逻辑

## 已知问题

- pi CLI 未装在验证机，真正的多 agent 执行路径（plan→dev→test→eval）没有在 P4 内跑通 —— 需要在有 pi + API key 的环境里补一次。
- `session-lifecycle-hook.mjs` 在 node 静态 import 时会立刻 spawn 子进程（脚本末尾直接 `spawn(...)`）。对作为命令行工具使用无影响，但提醒：未来若被其它 lib 静态 import 会有副作用。
- 空仓库下 `status --banner` 仍打印 "No tasks yet" 块，`hooks.json` 里的 SessionStart 每次会追加这段。视觉上可接受，但如果将来想"仅在非空时提示"可以在 render 里加早退。

## 下一步建议

1. 在装了 pi CLI + 配好 provider 的机器上装插件，跑一遍 README 的 5 分钟 quickstart
2. 观察 `<state-dir>/sessions/*.jsonl` 是否按预期落地
3. 如果 evaluator 报出 schema 校验失败，优先查 `scripts/lib/schema.mjs` 对应约束字段
4. 后续如需 `$ref` / `oneOf` / `anyOf`，再考虑引入 ajv（保持零依赖优先）
