# P1 · Companion CLI 主入口 + 核心 lib

## 任务目标

实现 pi-agent-cc 的**业务核心层**：子命令分发器 + 状态持久化 + pi 子进程包装 + git worktree 管理。这层的 API 契约决定了 P2/P3 是否能顺利对接。

## 依赖任务

- P0（需要 git 仓库、package.json、目录结构）

## 关键复用源

- **`codex-plugin-cc/plugins/codex/scripts/lib/state.mjs`** L29-56（workspace slug+hash 算法，原样复制到 `lib/workspace.mjs`）
- **`pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts`** L238-400（spawn pi + JSONL 解析 + 并发控制 + abort 传播 → 重写为纯 JS 的 `lib/pi-runner.mjs`）
- **`pi-mono/packages/coding-agent/src/main.ts`** L149, L239, L496（pi CLI 支持的 flags：`--session <path>`、`--resume <path>`、`--mode json`、`-p`、`--append-system-prompt <path>`、`--tools <csv>`）

## 实现步骤

### 1. `scripts/lib/workspace.mjs`（优先）

从 `codex-plugin-cc/plugins/codex/scripts/lib/state.mjs` L29-56 复制 workspace 解析/slug+hash 逻辑到这里。导出：

```js
export function resolveWorkspaceRoot(startCwd = process.cwd()) { /* 查找 package.json/.git 向上 */ }
export function getWorkspaceSlug(workspaceRoot) { /* basename + sha256 前 8 位 */ }
export function getStateDir(workspaceRoot) {
  // $CLAUDE_PLUGIN_DATA || $XDG_DATA_HOME || ~/.claude
  // 子路径 state/{slug}-{hash}/
}
```

### 2. `scripts/lib/state.mjs`

封装所有状态文件读写。**所有路径都是绝对路径**。

```js
// state 目录布局（见 plan 文件）：
// state/{slug}-{hash}/
//   state.json, plan.json
//   tasks/tNNN.json
//   sessions/{role}-{taskId}.jsonl  (pi 写入)
//   worktrees/index.json            (taskId → path+branch)
//   reports/{tNNN.test.json, final.eval.json}

export async function loadState() { /* 读 state.json，缺失返回默认 */ }
export async function saveState(state) { /* 原子写 */ }
export async function loadPlan() { /* 读 plan.json，可能返回 null */ }
export async function savePlan(plan) { }
export async function loadTask(taskId) { }
export async function saveTask(task) { }
export async function listTasks() { /* 扫 tasks/ 返回数组 */ }
export async function appendHistory(taskId, event) { /* {ts, role, event, summary} */ }
export async function saveReport(taskId, kind /* 'test'|'eval' */, body) { }
export async function loadReports(taskId) { }
export async function recordWorktree(taskId, { path, branch }) { }
export async function clearWorktree(taskId) { }
```

**state.json 默认结构**：
```json
{
  "version": 1,
  "planStatus": "none|draft|frozen|running|done|blocked",
  "config": { "maxAttempts": 5, "defaultParallel": 4 },
  "jobs": [],
  "createdAt": "...", "updatedAt": "..."
}
```

**task 结构**：见 plan 文件 "任务状态模型" 章节。

### 3. `scripts/lib/pi-runner.mjs`

**最关键的模块**。包装 `pi` CLI 子进程。

参考 `pi-mono/packages/coding-agent/examples/extensions/subagent/index.ts` L238-400：

```js
import { spawn } from "node:child_process";

export async function runPi({
  systemPromptPath,   // 绝对路径，映射 --append-system-prompt
  tools,              // string[] 或 'all'；映射 --tools "read,write,..."
  sessionPath,        // 绝对 .jsonl；映射 --session（新建）或 --resume（续）
  resume = false,     // 是否用 --resume
  prompt,             // 字符串或 stdin
  cwd,                // 子进程 cwd（并行时是 worktree 路径）
  model,              // 可选
  appendSystemPromptExtra,  // 可选二次 append
  onEvent,            // (event) => void，逐条 JSONL 推给调用方
  signal,             // AbortSignal
}) {
  const args = ['--mode', 'json', '-p'];
  if (resume) args.push('--resume', sessionPath);
  else args.push('--session', sessionPath);
  if (systemPromptPath) args.push('--append-system-prompt', systemPromptPath);
  if (appendSystemPromptExtra) args.push('--append-system-prompt', appendSystemPromptExtra);
  if (Array.isArray(tools)) args.push('--tools', tools.join(','));
  if (model) args.push('--model', model);
  args.push(prompt);

  const child = spawn('pi', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  // line-by-line JSONL 解析 child.stdout
  // 聚合 events；记录 lastMessage（末条 text block）
  // 监听 signal → child.kill('SIGTERM')
  // 返回 { exitCode, lastMessage, events, sessionPath }
}
```

**边缘情况**：
- 末条消息 JSON 解析失败 → `lastMessage.parsedJson = null, lastMessage.text = rawText`，调用方自己决定怎么办
- child exit != 0 → 仍返回，exitCode 让调用方判断
- signal abort → 调用 child.kill，然后 throw AbortError

### 4. `scripts/lib/worktree.mjs`

```js
export async function createWorktree(taskId, baseBranch = 'main') {
  // const stateDir = getStateDir(workspace)
  // const worktreePath = path.join(workspace, '.worktrees', taskId)
  // git -C <workspace> worktree add <worktreePath> -b pi/<taskId> <baseBranch>
  // recordWorktree(taskId, { path, branch })
  // 返回 { path, branch }
}

export async function removeWorktree(taskId, { force = false } = {}) {
  // git worktree remove [--force] <path>
  // git branch -D pi/<taskId>
  // clearWorktree(taskId)
}

export async function mergeWorktree(taskId, { targetBranch = 'main', message } = {}) {
  // git -C <workspace> checkout <targetBranch>
  // git -C <workspace> merge --no-ff pi/<taskId> -m <message>
  // 冲突时返回 { ok: false, conflict: true, files: [...] }，不抛
}

export function listWorktrees() { /* 解析 git worktree list --porcelain */ }
```

### 5. `scripts/lib/render.mjs`

```js
export function renderStatusTable(tasks, opts = {}) { /* markdown 表 */ }
export function renderStatusJson(tasks) { /* JSON */ }
export function renderFinalReport({plan, tasks, reports, evalReport}) { /* 汇总 markdown */ }
```

### 6. `scripts/pi-companion.mjs`（主入口）

```js
#!/usr/bin/env node
// 解析 argv[2] 子命令；分发到各处理器
import { resolveWorkspaceRoot, getStateDir } from './lib/workspace.mjs';
import { loadState, saveState, ... } from './lib/state.mjs';
// ... import 其他 lib

const HANDLERS = {
  init:          handleInit,
  status:        handleStatus,
  // 下列由 P2/P3 最终接入，本阶段先写骨架返回 "not-implemented"
  plan:          async (args) => { throw new Error('P2 implements'); },
  'plan-confirm': async (args) => { throw new Error('P2 implements'); },
  develop:       async (args) => { throw new Error('P2 implements'); },
  test:          async (args) => { throw new Error('P2 implements'); },
  evaluate:      async (args) => { throw new Error('P2 implements'); },
  orchestrate:   async (args) => { throw new Error('P2 implements'); },
  resume:        async (args) => { throw new Error('P2 implements'); },
  report:        async (args) => { throw new Error('P2 implements'); },
  approve:       async (args) => { throw new Error('P2 implements'); },
  cancel:        async (args) => { throw new Error('P2 implements'); },
};

const [, , subcommand, ...rest] = process.argv;
if (!HANDLERS[subcommand]) { console.error(`unknown subcommand: ${subcommand}`); process.exit(2); }
try { await HANDLERS[subcommand](rest); } catch (e) { console.error(e.message); process.exit(1); }
```

**MVP 本阶段的处理器**：
- `init` — 创建 state 目录 + 初始 state.json
- `status [taskId] [--json]` — 用 render.mjs 输出

其他子命令**留桩**，由 P2 实现（因为 P2 负责 plan/develop/test/evaluate/orchestrate 的业务逻辑）。

**重要**：P1 完成 pi-companion.mjs 的骨架 + init + status。其他 handler 留空 throw。P2 阶段再填补这些 handler。

### 7. 加 shebang + 可执行位

```bash
chmod +x scripts/pi-companion.mjs
```

## 涉及文件清单

- `scripts/pi-companion.mjs`
- `scripts/lib/workspace.mjs`
- `scripts/lib/state.mjs`
- `scripts/lib/pi-runner.mjs`
- `scripts/lib/worktree.mjs`
- `scripts/lib/render.mjs`

## 验证方法

```bash
cd <p1-worktree>
chmod +x scripts/pi-companion.mjs
node scripts/pi-companion.mjs init
ls "${CLAUDE_PLUGIN_DATA:-$HOME/.claude}/state/"*-*/
# 应看到 state.json

node scripts/pi-companion.mjs status --json
# 应输出 { "tasks": [], "planStatus": "none" } 或类似

# pi-runner 最小测试（手写一次 smoke）：
node -e "
import('./scripts/lib/pi-runner.mjs').then(async m => {
  console.log(typeof m.runPi);
});"
# 只校验 import 不报错即可（真正的 pi 调用延迟到 P4 端到端验证）

# worktree 最小测试：
node -e "
import('./scripts/lib/worktree.mjs').then(async m => {
  const wt = await m.createWorktree('t999');
  console.log(wt);
  await m.removeWorktree('t999', { force: true });
});"
```

## 完成标准

- [ ] `scripts/pi-companion.mjs` 可执行，`init`/`status` 工作
- [ ] 5 个 lib 文件按 context-common.md 的契约导出
- [ ] `pi-runner.mjs` 能正确构造 pi CLI 参数（用 dry-run 日志验证）
- [ ] `worktree.mjs` create/remove 在 git 仓库内工作
- [ ] `state.mjs` 写入文件是原子的（用 `writeFile` + rename 或直接 writeFile 都行，但要处理并发）
- [ ] 所有模块用 ESM 导出（`export ...`）

## 禁止事项

- **不得**实现 plan/develop/test/evaluate 的业务逻辑（那是 P2 的工作）
- **不得**创建 subagents/commands/hooks 的 markdown（那是 P3 的工作）
- **不得**修改 P0 的 package.json/plugin.json
