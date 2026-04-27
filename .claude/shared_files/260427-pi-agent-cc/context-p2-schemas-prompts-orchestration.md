# P2 · Schemas + Prompts + 编排 lib（handoff/evals/task-graph/prompts）+ companion 业务 handler

## 任务目标

把 P1 留下来的 `pi-companion.mjs` 处理器骨架填满：实现 plan/plan-confirm/develop/test/evaluate/orchestrate/resume/report/approve/cancel 的业务逻辑。同时产出所有 JSON Schema 和角色 system prompt。

## 依赖任务

- P0（骨架）
- P1 的 **lib 契约**（已在 context-common.md 锁定，不需要代码，按接口实现即可 —— 允许和 P1 并行开发；合并时如果 P1 的签名略有变化需要适配）

**说明**：P2 可以和 P1 并行开始，因为 API 契约已在 `context-common.md` 的"跨任务共享约定"章节定义。合并时做接口对齐。

## 关键复用源

- **`pi-mono/packages/coding-agent/examples/extensions/handoff.ts`** L19-39 —— 跨角色上下文压缩提示词模板，用作 `prompts/evaluator.md`/`lib/handoff.mjs` 的灵感
- **`pi-mono/packages/coding-agent/examples/extensions/subagent/agents/{scout,planner,reviewer,worker}.md`** —— `prompts/*.md` 的格式参考（YAML frontmatter + 角色说明）
- **`pi-mono/packages/coding-agent/examples/extensions/plan-mode/index.ts`** —— 步骤解析、`[DONE:n]` 追踪思路

## 实现步骤

### 1. JSON Schemas（`schemas/*.json`）

#### `plan.schema.json`

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "tasks"],
  "properties": {
    "version": { "type": "integer", "minimum": 1 },
    "requirements": { "type": "string" },
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "title", "description", "acceptance", "deps"],
        "properties": {
          "id": { "type": "string", "pattern": "^t\\d{3,}$" },
          "title": { "type": "string" },
          "description": { "type": "string" },
          "acceptance": { "type": "array", "items": { "type": "string" } },
          "deps": { "type": "array", "items": { "type": "string" } },
          "evals": { "type": "array", "items": { "type": "string" } },
          "touchedPaths": { "type": "array", "items": { "type": "string" } },
          "effort": { "type": "string", "enum": ["xs","s","m","l","xl"] }
        }
      }
    }
  }
}
```

#### `test-report.schema.json`

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["taskId", "verdict", "issues"],
  "properties": {
    "taskId": { "type": "string" },
    "verdict": { "type": "string", "enum": ["PASS", "FAIL"] },
    "summary": { "type": "string" },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "severity", "description"],
        "properties": {
          "id": { "type": "string" },
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "severity": { "type": "string", "enum": ["low","medium","high","critical"] },
          "description": { "type": "string" },
          "reproduce": { "type": "string" }
        }
      }
    }
  }
}
```

#### `eval-report.schema.json`

```jsonc
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["score", "verdict"],
  "properties": {
    "score": { "type": "number", "minimum": 0, "maximum": 100 },
    "verdict": { "type": "string", "enum": ["ACCEPT","REWORK","REJECT"] },
    "dimensions": {
      "type": "object",
      "properties": {
        "functional": { "type": "number" },
        "quality": { "type": "number" },
        "coverage": { "type": "number" }
      }
    },
    "issues": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "taskId": { "type": "string" },
          "severity": { "type": "string" },
          "detail": { "type": "string" }
        }
      }
    },
    "recommendations": { "type": "string" }
  }
}
```

### 2. 角色 Prompts（`prompts/*.md`）

每个都是纯文本 system prompt（不带 YAML frontmatter，因为是给 `pi --append-system-prompt` 用的）。

#### `prompts/planner.md`

```markdown
You are the Planner agent. Your job: given a requirement, break it into a minimal set of independently-testable tasks.

Output rules:
- The last message of your response MUST be a single JSON object conforming to plan.schema.json.
- Before the JSON, you may explain your reasoning in a short paragraph.
- Each task MUST have: id (t001, t002, ...), title, description, acceptance criteria (2-4 bullets), deps (by id), and an optional `touchedPaths` hint.
- Keep tasks independent and parallelizable when possible. Fewer, bigger tasks > many tiny ones.
- If the user sends follow-up feedback, produce a new plan incorporating the change. Increment `version` in the JSON.
```

#### `prompts/developer.md`

```markdown
You are the Developer agent. You have been given a single task from a larger plan. Work only on this task.

Constraints:
- Stay within the current worktree. Do not touch unrelated files.
- When done, output a concise summary: what changed, which files, any decisions.
- Do not run destructive git operations (push, reset --hard, force-pushes).
- Tools available: read, write, edit, bash (for tests/lint), grep, find, ls.

If the orchestrator sends a follow-up "Tester reported issues: ..." via resume, address those issues specifically. Reply with a short summary of what you fixed per issue id.
```

#### `prompts/tester.md`

```markdown
You are the Tester agent. You verify work done by the Developer. You have read-only access (read, bash, grep, find, ls — no write/edit).

Your job:
1. Read the task description + acceptance criteria.
2. Review the provided diff and changed files.
3. Run any existing tests or linters (via bash) relevant to the touched paths.
4. Produce a verdict.

Output rules:
- The LAST message of your response MUST be a single JSON object conforming to test-report.schema.json.
- If verdict=PASS, issues may be empty or contain minor notes (severity: low).
- If verdict=FAIL, issues must contain at least one actionable item with id, severity, description, and reproduce steps.
- If called via resume, focus on the listed issue ids; verify each is now addressed.
```

#### `prompts/evaluator.md`

```markdown
You are the Evaluator agent. You perform a final quality review across the entire plan.

You are given:
- The frozen plan
- All task records with status
- All test reports
- A quantitative eval-run.json from automated eval scripts
- A `git diff --stat` since plan freeze

Your job: grade the overall delivery along three dimensions (functional, quality, coverage) 0-100 each, produce an aggregate score, and decide: ACCEPT / REWORK / REJECT.

Output rules:
- The LAST message MUST be a single JSON object conforming to eval-report.schema.json.
- ACCEPT only when all tasks are PASS and no critical issues found.
- REWORK when specific tasks need iteration — list them in issues[] with taskId.
- REJECT when the plan itself is flawed or delivery is unsalvageable — recommend coordinator intervention.
```

### 3. 编排 lib

#### `scripts/lib/prompts.mjs`

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '..', '..', 'prompts');

export function loadPrompt(name) {
  return path.join(PROMPTS_DIR, `${name}.md`);   // 绝对路径（pi CLI 接受）
}
```

#### `scripts/lib/handoff.mjs`

```js
import { execFileSync } from 'node:child_process';

export function buildTesterContext({ task, devSummary, worktreePath, baseBranch = 'main' }) {
  // 收集 git diff
  const diff = execFileSync('git', ['-C', worktreePath, 'diff', baseBranch, '--stat'], { encoding: 'utf8' });
  const fileList = execFileSync('git', ['-C', worktreePath, 'diff', baseBranch, '--name-only'], { encoding: 'utf8' });
  return `## Task
${task.title}
${task.description}

## Acceptance
${task.acceptance.map(a => '- ' + a).join('\n')}

## Developer Summary
${devSummary}

## Changed Files
${fileList}

## Diff Stat
${diff}

Verify the work meets acceptance criteria. Output JSON per test-report.schema.json.`;
}

export function buildDevResumePrompt({ issues }) {
  return `Tester reported the following issues. Please address each one and reply with a per-issue summary:\n\n${JSON.stringify(issues, null, 2)}`;
}

export function buildTesterResumePrompt({ issueIds }) {
  return `Developer claims to have fixed the previously reported issues: ${issueIds.join(', ')}. Re-verify each and output an updated test-report.schema.json JSON.`;
}
```

#### `scripts/lib/task-graph.mjs`

```js
export function getReadyTasks(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  return tasks.filter(t =>
    t.status === 'ready' &&
    t.deps.every(dep => byId.get(dep)?.status === 'done')
  );
}

export function isTaskReady(task, tasks) {
  return task.status === 'ready' && task.deps.every(d => tasks.find(x => x.id === d)?.status === 'done');
}
```

#### `scripts/lib/evals.mjs`

```js
import { fork } from 'node:child_process';
import path from 'node:path';

// 为安全起见，每个 eval 用 child_process 隔离 + 超时
export async function runEvals(evalFiles, ctx, { timeoutMs = 60000 } = {}) {
  const results = [];
  for (const file of evalFiles) {
    try {
      const result = await runOne(file, ctx, timeoutMs);
      results.push(result);
    } catch (err) {
      results.push({ file, passed: false, error: err.message });
    }
  }
  return {
    results,
    totalPassed: results.filter(r => r.passed).length,
    totalFailed: results.filter(r => !r.passed).length,
  };
}

function runOne(file, ctx, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = fork(path.resolve(file), [], {
      silent: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('timeout')); }, timeoutMs);
    child.send({ type: 'run', ctx });
    child.on('message', msg => {
      if (msg?.type === 'result') { clearTimeout(timer); child.kill(); resolve({ file, ...msg.result }); }
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// eval 脚本模板（用户自己写）：
// process.on('message', async ({ type, ctx }) => {
//   if (type !== 'run') return;
//   const passed = /* ... */;
//   process.send({ type: 'result', result: { passed, metrics: {...} } });
// });
```

### 4. Companion 业务处理器

在 P1 创建的 `scripts/pi-companion.mjs` 基础上（注意要读 P1 的实现或直接往里添加），实现以下 handler。

以下给出核心逻辑伪码，落地时结合 P1 的真实 lib 签名。

#### `handlePlan(args)`

```js
// args: 用户自然语言文本
const text = args.join(' ');
const plannerSessionPath = path.join(stateDir, 'sessions', 'planner.jsonl');
const exists = fs.existsSync(plannerSessionPath);
const result = await runPi({
  systemPromptPath: loadPrompt('planner'),
  tools: ['read', 'grep', 'find', 'ls'],  // planner 只读
  sessionPath: plannerSessionPath,
  resume: exists,
  prompt: text,
});
// 解析 result.lastMessage.text 中的最后一块 JSON（可用 /\{[\s\S]*\}\s*$/ 兜底）
// 用 ajv 或自定义 schema 校验
const plan = parseAndValidate(result.lastMessage.text, 'plan.schema.json');
plan.version = (await loadPlan())?.version + 1 || 1;
await savePlan(plan);
console.log(JSON.stringify({ planStatus: 'draft', version: plan.version, tasks: plan.tasks.length }));
```

#### `handlePlanConfirm()`

```js
const plan = await loadPlan();
validateAgainstSchema(plan, 'plan.schema.json');
for (const taskSpec of plan.tasks) {
  await saveTask({
    ...taskSpec,
    status: 'ready',
    attempts: 0,
    maxAttempts: 5,
    sessions: {},
    history: [{ ts: new Date().toISOString(), event: 'created' }],
  });
}
const state = await loadState();
state.planStatus = 'frozen';
await saveState(state);
console.log(JSON.stringify({ planStatus: 'frozen', taskCount: plan.tasks.length }));
```

#### `handleDevelop({task, resume})`

```js
const t = await loadTask(task);
// 首跑：先建 worktree
if (!resume) {
  const wt = await createWorktree(t.id);
  t.worktree = wt;
  t.status = 'developing';
  await saveTask(t);
}
const sessionPath = path.join(stateDir, 'sessions', `dev-${t.id}.jsonl`);
const prompt = resume
  ? buildDevResumePrompt({ issues: <from args or last test report> })
  : `Task: ${t.title}\n\n${t.description}\n\nAcceptance:\n${t.acceptance.map(a=>'- '+a).join('\n')}`;
const result = await runPi({
  systemPromptPath: loadPrompt('developer'),
  tools: ['read','write','edit','bash','grep','find','ls'],
  sessionPath,
  resume,
  prompt,
  cwd: t.worktree.path,
});
t.sessions.developer = sessionPath;
await appendHistory(t.id, { role: 'developer', event: resume ? 'resumed' : 'completed', summary: result.lastMessage.text.slice(0, 300) });
console.log(JSON.stringify({ taskId: t.id, exitCode: result.exitCode, summary: result.lastMessage.text }));
```

#### `handleTest({task, resume})`

类似 handleDevelop，但：
- tools 只读 `['read','bash','grep','find','ls']`
- 不首次建 worktree（复用 dev 的）
- prompt 通过 `buildTesterContext` 组装
- 末条消息解析为 `test-report.schema.json`，写入 `reports/{taskId}.test.json`
- verdict=FAIL → task.status='developing'; verdict=PASS → task.status='evaluating'（如果没有 evaluator 则直接 done）

#### `handleEvaluate()`

```js
const plan = await loadPlan();
const tasks = await listTasks();
const evalFiles = [...new Set(tasks.flatMap(t => t.evals || []))];
const evalRun = await runEvals(evalFiles, { workspace, tasks });
await fs.writeFile(path.join(stateDir, 'eval-run.json'), JSON.stringify(evalRun, null, 2));

const prompt = `Plan:\n${JSON.stringify(plan)}\n\nTasks:\n${JSON.stringify(tasks)}\n\nTest Reports:\n${JSON.stringify(await loadAllReports())}\n\nEval Run:\n${JSON.stringify(evalRun)}\n\nGit Diff Stat:\n${getGitDiffStat()}`;
const sessionPath = path.join(stateDir, 'sessions', 'evaluator.jsonl');
const result = await runPi({
  systemPromptPath: loadPrompt('evaluator'),
  tools: ['read','grep','find','ls','bash'],
  sessionPath, resume: false, prompt,
  model: 'claude-opus-4-7',  // 用户 plan 指定 opus
});
const report = parseAndValidate(result.lastMessage.text, 'eval-report.schema.json');
await saveReport('_final', 'eval', report);
// 根据 verdict 更新 state.planStatus 或回派 dev resume
console.log(JSON.stringify(report));
```

#### `handleOrchestrate({parallel=4, autoApprove=false})`

```js
const state = await loadState();
if (state.planStatus !== 'frozen' && state.planStatus !== 'running') {
  throw new Error('plan not frozen, run /pi:plan-confirm first');
}
state.planStatus = 'running'; await saveState(state);

while (true) {
  const tasks = await listTasks();
  const ready = getReadyTasks(tasks);
  if (ready.length === 0) {
    if (tasks.every(t => t.status === 'done' || t.status === 'blocked')) break;
    // 有任务在进行中，继续主循环但 sleep（如果是同步版本，实际用事件驱动）
    await sleep(1000); continue;
  }
  const pool = ready.slice(0, parallel);
  await Promise.all(pool.map(t => runTaskLoop(t.id)));
}

async function runTaskLoop(taskId) {
  while (true) {
    const t = await loadTask(taskId);
    if (t.attempts >= t.maxAttempts) { t.status = 'blocked'; await saveTask(t); return; }
    if (!t.sessions.developer) await handleDevelop({task: taskId});
    else await handleDevelop({task: taskId, resume: true});
    await handleTest({task: taskId, resume: !!t.sessions.tester});
    const reports = await loadReports(taskId);
    const lastTest = reports.filter(r => r.kind === 'test').pop();
    if (lastTest.body.verdict === 'PASS') {
      const merge = await mergeWorktree(taskId);
      if (!merge.ok) { /* 标 blocked */ return; }
      t.status = 'done'; await saveTask(t);
      await removeWorktree(taskId);
      return;
    }
    t.attempts++; await saveTask(t);
  }
}

// 全部 done 后：
await handleEvaluate();
```

#### 其他 handler

- `handleStatus` — 已在 P1 基本实现，这里确保能带 taskId 过滤
- `handleResume({taskId, role})` — 显式触发 develop/test --resume
- `handleReport` — 拼接 plan.json + tasks + reports + eval-report.json 成 markdown
- `handleApprove({taskId, reason})` — 把 task 标 `done` 并记录
- `handleCancel([taskId])` — 向运行中的 pi 子进程发 SIGTERM（通过 `state.jobs` 里记录的 pid），标记任务 `cancelled`

### 5. Schema 校验辅助

写一个最小 `scripts/lib/schema.mjs`（或合并进 state.mjs）：
- 方案 A：npm 装 `ajv` 做完整校验
- 方案 B：手写必需字段校验（减一个依赖）

**推荐** 方案 A（ajv 广泛、可靠）。在 P4 阶段把 ajv 加进 `package.json` 的 `dependencies`。

**JSON 提取**：LLM 回复可能带前置解释，要写 `extractLastJsonBlock(text)`：
- 正则 `/\{[\s\S]*\}\s*$/` 抓末尾 JSON
- 找不到就返回 null，调用方决定重试/报错

## 涉及文件清单

- `schemas/plan.schema.json`
- `schemas/test-report.schema.json`
- `schemas/eval-report.schema.json`
- `prompts/planner.md`
- `prompts/developer.md`
- `prompts/tester.md`
- `prompts/evaluator.md`
- `scripts/lib/prompts.mjs`
- `scripts/lib/handoff.mjs`
- `scripts/lib/task-graph.mjs`
- `scripts/lib/evals.mjs`
- `scripts/lib/schema.mjs`（或并入 state.mjs）
- **修改** `scripts/pi-companion.mjs` 填补 handler（与 P1 合并时小心不冲突；建议 P2 写在单独 handler 文件中，pi-companion.mjs 只做 import 分发）

**优化建议**：为了减少和 P1 在 `pi-companion.mjs` 的冲突，可以把 P2 的 handler 放在 `scripts/lib/handlers/{plan,plan-confirm,develop,test,evaluate,orchestrate,resume,report,approve,cancel}.mjs`，然后 P1 的 `pi-companion.mjs` 只需一行 import 替换即可。**强烈推荐这个路径**。

## 验证方法

```bash
# schema 校验
node -e "
const ajv = (await import('ajv')).default;
const schema = await import('./schemas/plan.schema.json', { with: { type: 'json' } });
const validate = new ajv().compile(schema.default);
console.log(validate({ version: 1, tasks: [{id:'t001',title:'x',description:'y',acceptance:['z'],deps:[]}] }));
"

# prompts 路径
node -e "import('./scripts/lib/prompts.mjs').then(m => console.log(m.loadPrompt('developer')))"

# handoff 模板
node -e "
import('./scripts/lib/handoff.mjs').then(m =>
  console.log(m.buildDevResumePrompt({ issues:[{id:'i1',description:'d'}] })))
"
```

真正的端到端（跑通 pi CLI）由 P4 完成。

## 完成标准

- [ ] 3 个 JSON Schema 文件合法、能被 ajv 编译
- [ ] 4 个 prompt 文件编写得体（每个都强调"末条消息必须为 JSON"）
- [ ] 4 个编排 lib 导出符合 context-common.md 契约
- [ ] 10 个 companion handler（plan, plan-confirm, develop, test, evaluate, orchestrate, resume, report, approve, cancel）能编译运行（至少 smoke 测试不崩）
- [ ] JSON 提取/校验工具（schema.mjs）存在

## 禁止事项

- **不得**修改 P1 的 lib 导出签名（如需变更，通过 context 文件协调）
- **不得**创建 subagents/commands/hooks markdown（P3 的工作）
- **不得**在 handler 里直接调用 git —— 用 P1 的 `worktree.mjs`
