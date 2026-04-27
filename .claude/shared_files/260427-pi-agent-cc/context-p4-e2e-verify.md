# P4 · 端到端验证 + 权限 settings + 依赖补齐 + README

## 任务目标

P1/P2/P3 合并回 main 后，做收尾：
- 补齐 `package.json` 的 npm 依赖（如 `ajv`）
- 权限预设（`.claude/settings.json`）
- 文档完善（README）
- demo 仓库跑通端到端流程
- 记录验证结果

## 依赖任务

- **P1 合并完成**
- **P2 合并完成**
- **P3 合并完成**

## 实现步骤

### 1. 补齐 `package.json` 的依赖

```bash
cd /Users/yanyao/Projects/side/pi-agent-cc
npm install --save ajv
# 如果 P2 最终用了 ajv 做 JSON Schema 校验
```

最终 `package.json`：

```json
{
  "name": "pi-agent-cc",
  "version": "0.1.0",
  "type": "module",
  "bin": { "pi-companion": "./scripts/pi-companion.mjs" },
  "scripts": {
    "test:cli": "node scripts/pi-companion.mjs init",
    "test:status": "node scripts/pi-companion.mjs status --json"
  },
  "engines": { "node": ">=20" },
  "dependencies": { "ajv": "^8.x" }
}
```

提交 `package-lock.json`。

### 2. `.claude/settings.json`（权限预设）

放到项目根的 `.claude/settings.json`（注意不是 plugin 目录内的 settings）：

```json
{
  "permissions": {
    "allow": [
      "Bash(node scripts/pi-companion.mjs:*)",
      "Bash(node \"${CLAUDE_PLUGIN_ROOT}/scripts/pi-companion.mjs\":*)",
      "Bash(git worktree:*)",
      "Bash(git branch:*)",
      "Bash(git merge:*)",
      "Bash(git checkout:*)",
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(pi:*)"
    ]
  }
}
```

**注意**：现有 `.claude/settings.local.json` 已存在（包含对 fork/pi-mono、fork/codex-plugin-cc 的访问）—— 不要覆盖，追加到现有文件或用 `settings.json`（项目级）+ `settings.local.json`（用户本地）分层。

### 3. 完善 `README.md`

从 P0 的极简版本扩展，包含：
- 安装说明
- 完整命令清单表（见 context-common.md）
- "5 分钟体验"步骤
- 已知限制（Phase 2/3 roadmap）
- 如何贡献

### 4. 端到端验证

**前置**：pi CLI 已安装，能运行 `pi --help`；至少有一个 provider 的 API key 已配置（`pi --login`）。

**demo 仓库准备**：

```bash
mkdir -p /tmp/pi-agent-demo
cd /tmp/pi-agent-demo
git init -b main
echo "# demo" > README.md
git add . && git commit -m "init"
```

**在 Claude Code 中**：

```
/plugin install-local /Users/yanyao/Projects/side/pi-agent-cc
# CC 应该能识别 /pi:* 命令
```

**跑通完整流程**：

```
# 在 /tmp/pi-agent-demo 目录开 CC

/pi:plan 做一个 login.html 静态页面，要有 email+password 输入框和提交按钮，并有基本的 CSS 样式

# 观察 planner 输出 draft plan（预期 2-4 个任务）

/pi:plan 拆分 HTML 和 CSS 为两个独立任务

# 观察 planner 保留上下文产出新版

/pi:plan-confirm

# 观察 tasks/*.json 被创建

/pi:start --parallel 2

# 观察：
# - 每个 dev 任务在独立 worktree 下工作
# - tester 出报告
# - 如果 tester FAIL，dev resume 修复
# - 全部 PASS 后 evaluator 跑

/pi:status
/pi:report
```

### 5. 单元冒烟

```bash
cd /Users/yanyao/Projects/side/pi-agent-cc

# companion CLI 基础
node scripts/pi-companion.mjs init
node scripts/pi-companion.mjs status --json

# schema 校验
node -e "
import('./scripts/lib/state.mjs').then(m => m.loadState().then(console.log));
"

# pi-runner 模拟 dry run（不实际启 pi 的话需要 mock 或 stub）
```

### 6. 记录验证结果

在 `.claude/shared_files/260427-pi-agent-cc/` 下创建 `VERIFICATION.md`，记录：

- 哪些命令跑通了
- 哪些出现问题（+ 错误日志）
- plan → start → report 的 demo 运行日志摘录
- 性能/token 消耗数据
- 遗留问题清单

### 7. 最终 commit

```bash
git add .
git commit -m "P4: dependencies, permissions, README, E2E verification"
```

## 涉及文件清单

- `package.json`（补依赖）
- `package-lock.json`（新增）
- `.claude/settings.json`（新增）
- `README.md`（扩展）
- `.claude/shared_files/260427-pi-agent-cc/VERIFICATION.md`（新增）

## 验证方法

- 手动跑完上述"跑通完整流程"章节
- 检查 state 目录是否按设计生成文件
- 检查 worktree 是否正确创建/合并/清理
- 最终的 eval-report.json 是否为合法 JSON 且 verdict 明确

## 完成标准

- [ ] `npm install` 无错误
- [ ] 权限 settings 存在，不覆盖用户的 settings.local.json
- [ ] README.md 对陌生人友好（5 分钟上手）
- [ ] demo 仓库中 plan → confirm → start → report 走通
- [ ] VERIFICATION.md 记录了运行证据
- [ ] 所有 CI 友好的冒烟命令通过

## 禁止事项

- **不得**修改 plan 文件
- **不得** `git push`
- **不得**修改已合并的 P1/P2/P3 代码（如发现 bug，创建 follow-up issue/task）
