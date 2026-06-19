# CodexUseClaudecode

<div align="center">
  简体中文 / <a href="./README_EN.md">English</a>
</div>

<div align="center">轻量的工具 Skill，让 Codex 通过官方 Claude Agent TypeScript SDK 以 tracked job 的方式调用 Claude Code</div>
<div align="center">适合审查、架构分析、风险扫描、官方文档核对、第二视角协作和长任务并行处理</div>

## 快速使用

将本仓库作为 Codex skill 安装或引用后，让 Codex 使用 `$codex-use-claude-code`。

首次使用先安装官方 SDK 依赖：

```bash
npm install
```

脚本也可以直接运行：

```bash
node scripts/claude-task.mjs start "Review the current diff. Do not edit files."
node scripts/claude-task.mjs start --profile research "Search current docs and review this integration."
node scripts/claude-task.mjs start --profile full --approval ask "Use full Claude Code tools, but ask before unapproved actions."
node scripts/claude-task.mjs start --file prompt.md
node scripts/claude-task.mjs start --no-boundaries "Use my prompt exactly as written."
git diff | node scripts/claude-task.mjs start --stdin "Review this diff."
node scripts/claude-task.mjs wait [--retry-stale] [--retry-failed] <task-id>
node scripts/claude-task.mjs status --json <task-id>
node scripts/claude-task.mjs tail <task-id> 40
node scripts/claude-task.mjs result --json <task-id>
```

长任务建议让 Codex worker 子代理执行 `wait <task-id>`，主线程继续用 `status`、`tail` 和 `result` 观察进度。

## 轻量架构

- 使用官方 `@anthropic-ai/claude-agent-sdk` 的 `query()`，不手动 spawn Claude CLI，也不手写底层 JSONL 协议。
- 脚本是单个 ESM `.mjs`，没有 TypeScript 编译链、数据库、后台服务或框架。
- 官方 SDK 默认自带平台 Claude Code binary；正常情况下不需要单独安装 Claude Code CLI。
- 默认 `persistSession: false`，避免 SDK 会话 transcript 持续落盘。
- 任务存储为 compact JSON：`.codex/claude-code/tasks/<task-id>.json`。
- 组任务存储为 compact JSON：`.codex/claude-code/groups/<group-id>.json`。
- 不写无限追加 raw `.log`；`tail` 只显示最近事件摘要。
- 默认保留最近 50 个已结束任务、7 天内任务；`start` 会自动清理，`clean` 可手动清理。
- 每个任务默认只保留最近 80 条事件摘要；最终结果默认最多保存 200000 字符。

具体数值可通过环境变量调整。

## 安全默认值

默认 profile 是 `safe`：

- `permissionMode: "dontAsk"`
- `tools: ["Read", "Grep", "Glob", "Bash", "AskUserQuestion"]`
- `allowedTools`: 预批准 `Read`、`Grep`、`Glob` 和 `git diff/status/log/show` 只读命令
- `approvalMode: "deny"`
- `persistSession: false`
- `maxBudgetUsd: 5.00`

这里按 Claude Agent SDK 官方语义区分 `tools` 和 `allowedTools`：`tools` 限制可见工具面，`allowedTools` 只用于免确认允许指定工具调用。`allowedTools` 本身不限制工具可见性；在 `dontAsk` 模式下，未预批准的工具会被拒绝。

可选 profile：

- `safe`：读文件、搜索文件、常见只读 git 查询。
- `research`：在 `safe` 基础上增加并预批准 `WebFetch` 和 `WebSearch`。
- `full`：使用 Claude Code 默认工具 preset 和 `acceptEdits`，适合明确希望 Claude Code 使用完整能力的任务；建议配合 `--approval ask` 或明确的自动化审批策略。

## 审批模式

默认不弹出审批，也不会无限等待隐藏 prompt。需要 yes/no 环节时显式开启：

```bash
node scripts/claude-task.mjs start --profile full --approval ask "Run the needed checks and fix issues."
node scripts/claude-task.mjs wait <task-id>
```

如果 `wait` 所在进程是交互式终端，脚本会直接询问 `[y/N]`。如果它运行在非交互 worker 中，任务会记录一个 pending approval，主线程可以查看并处理：

```bash
node scripts/claude-task.mjs approvals <task-id>
node scripts/claude-task.mjs approve <task-id> <approval-id>
node scripts/claude-task.mjs deny <task-id> <approval-id> "Reason for Claude"
```

审批模式：

- `--approval deny`：默认值，拒绝未预批准工具请求。
- `--approval ask`：需要人工 yes/no；safe/research 会从 `dontAsk` 自动切到 `default`，让 SDK 的 `canUseTool` 回调可以触发。
- `--approval allow`：自动允许未预批准工具请求。只适合隔离目录、可信任务或短命自动化。

## 环境变量

```bash
CLAUDE_TASK_PROFILE=research
CLAUDE_TASK_APPROVAL_MODE=ask
CLAUDE_TASK_TOOLS="Read,Grep,Glob,Bash,AskUserQuestion,WebFetch,WebSearch"
CLAUDE_TASK_ALLOWED_TOOLS="Read,Grep,Glob,Bash(git diff),Bash(git diff *),Bash(git status),Bash(git status *),Bash(git log),Bash(git log *),Bash(git show),Bash(git show *)"
CLAUDE_TASK_PERMISSION_MODE=dontAsk
CLAUDE_TASK_SESSION_PERSISTENCE=1
CLAUDE_TASK_MAX_BUDGET_USD=20.00
CLAUDE_TASK_TIMEOUT_MS=0
CLAUDE_TASK_MAX_TURNS=8
CLAUDE_TASK_MODEL=sonnet
CLAUDE_TASK_POLL_MS=500
CLAUDE_TASK_RETAIN_DAYS=7
CLAUDE_TASK_RETAIN_TASKS=50
CLAUDE_TASK_EVENT_LIMIT=80
CLAUDE_TASK_RESULT_MAX_CHARS=200000
CLAUDE_TASK_BOUNDARIES="Custom task boundaries..."
```

`CLAUDE_TASK_BIN` 仍保留兼容，但现在映射到 SDK 的 `pathToClaudeCodeExecutable`。只有当包管理器跳过 optional dependencies、平台 binary 不可用，或你明确要使用外部 Claude Code 可执行文件时才需要设置它。

`CLAUDE_TASK_SESSION_PERSISTENCE=1` 会打开 SDK 会话落盘。默认关闭，适合轻量 tracked helper。

## 追问模式

如果预计 Claude Code 工作时需要中途补充信息或纠偏，使用 live 任务：

```bash
node scripts/claude-task.mjs start --live "Review the current diff."
node scripts/claude-task.mjs wait <task-id>
node scripts/claude-task.mjs ask <task-id> "Also check Windows path handling."
node scripts/claude-task.mjs finish <task-id>
node scripts/claude-task.mjs result <task-id>
```

`wait` 可以交给 Codex worker 子代理跑；主线程继续用 `ask` 追问。live 任务最后必须调用 `finish`，否则 SDK input stream 会保持打开，`wait` 不会自行退出。

## 并行处理

```bash
node scripts/claude-task.mjs batch --json --profile research [--approval ask] [--no-boundaries] --file tasks.txt
node scripts/claude-task.mjs wait-group --json [--retry-failed] --concurrency 2 <group-id>
node scripts/claude-task.mjs group-status --json <group-id>
node scripts/claude-task.mjs group-result --json <group-id>
```

`wait-group` 默认并发是 2，避免轻量 skill 一次启动过多 SDK agent。需要更多并发时显式传 `--concurrency`。

## 清理

```bash
node scripts/claude-task.mjs clean --older-than 7d
node scripts/claude-task.mjs clean --json --dry-run --older-than 12h --keep 50
```

`start` 会自动按 `CLAUDE_TASK_RETAIN_DAYS` 和 `CLAUDE_TASK_RETAIN_TASKS` 清理已结束任务。运行中、排队中、等待审批和 stale 的任务不会被自动清理。

## 环境检查和自测

```bash
node scripts/claude-task.mjs doctor
node scripts/self-test.mjs
npm audit
```

`doctor` 检查 Node、SDK import、存储目录和保留策略。`self-test` 使用 fake SDK，不需要真实 Claude 账号或 API Key。仓库保留 `package-lock.json`，用于固定传递依赖、支持可复现安装和安全审计。
