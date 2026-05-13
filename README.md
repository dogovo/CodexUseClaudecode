# codex-use-claude

让 Codex 以 tracked job 的方式调用 Claude Code，用于审查、架构分析、风险扫描和第二视角协作。Codex 负责调度、监督和最终交付；Claude Code 作为可追踪的外部 helper 运行。

## 使用

把本仓库作为 Codex skill 安装或引用后，让 Codex 使用 `$codex-use-claude`。

脚本也可以直接运行：

```bash
node scripts/claude-task.mjs start "Review the current diff. Do not edit files."
node scripts/claude-task.mjs start --profile research "Search current docs and review this integration."
node scripts/claude-task.mjs start --profile full "Use full Claude Code tools for this task."
node scripts/claude-task.mjs start --file prompt.md
node scripts/claude-task.mjs start --no-boundaries "Use my prompt exactly as written."
git diff | node scripts/claude-task.mjs start --stdin "Review this diff."
node scripts/claude-task.mjs wait [--retry-stale] [--retry-failed] <task-id>
node scripts/claude-task.mjs status --json <task-id>
node scripts/claude-task.mjs tail <task-id> 40
node scripts/claude-task.mjs result --json <task-id>
```

长任务建议让 Codex worker 子代理执行 `wait <task-id>`，主线程继续用 `tail`、`status` 和 `result` 观察进度。

## 安全默认值

脚本使用 Claude Code 官方 SDK JSONL 协议：

```bash
claude -p --input-format stream-json --output-format stream-json --verbose
```

默认 profile 是 `safe`：

- `--permission-mode acceptEdits`
- `--allowed-tools "Read,Grep,Glob,Bash(git diff),Bash(git status),Bash(git log),Bash(git show)"`
- `--no-session-persistence`
- `--max-budget-usd 5.00`

可选 profile：

- `safe`：读文件、搜索文件、常见只读 git 查询。
- `research`：在 `safe` 基础上增加 `WebFetch` 和 `WebSearch`，适合查网页、读文档、做外部资料审查。
- `full`：传 `--tools default` 给 Claude Code，启用 Claude Code 默认完整工具集，适合你明确希望 Claude Code 使用更完整终端/网页/内置能力的任务。

可以用命令行或环境变量选择：

```bash
node scripts/claude-task.mjs start --profile research "Look up current docs and review this code."
node scripts/claude-task.mjs start --profile full "Use full Claude Code tools for a deep investigation."
CLAUDE_TASK_PROFILE=full node scripts/claude-task.mjs start "Deep investigation."
```

也可以直接覆盖底层参数：

```bash
CLAUDE_TASK_PROFILE=research
CLAUDE_TASK_ALLOWED_TOOLS="Read,Grep,Glob,WebFetch,WebSearch"
CLAUDE_TASK_TOOLS=default
CLAUDE_TASK_PERMISSION_MODE=default
CLAUDE_TASK_SESSION_PERSISTENCE=1
CLAUDE_TASK_MAX_BUDGET_USD=20.00
CLAUDE_TASK_TIMEOUT_MS=0
CLAUDE_TASK_MAX_TURNS=8
CLAUDE_TASK_MODEL=sonnet
CLAUDE_TASK_POLL_MS=500
CLAUDE_TASK_BOUNDARIES="Custom task boundaries..."
```

`--no-boundaries` 会跳过默认追加的 Codex/Claude 分工说明。只建议在 prompt 已经完整写明边界、权限和输出要求时使用。

`CLAUDE_TASK_TIMEOUT_MS` 会在 `start` 创建任务时保存到任务元数据。默认 `0` 表示 `wait` 可以无限等待，适合长时间审查；设置正整数毫秒值后，Claude Code 卡住超过该时间会被停止并标记为失败。

失败或超时后，先看 `tail <task-id>`，确认原因后可以用 `wait --retry-failed <task-id>` 在同一个任务日志里重跑。`stop` 和超时路径会尽力清理 Claude Code 进程树，避免后台进程越积越多。

`full` profile 会把 `--tools default` 交给 Claude Code，可能不再是严格只读工具面。即使使用 `full`，Codex 仍需要审查 Claude Code 的结果并决定保留什么。

## 环境要求

- Node.js 20.11 或更新版本。
- Claude Code CLI 已安装，并且命令行里能找到 `claude` 或 `claude.cmd`。
- Windows 上建议使用支持 UTF-8 的 shell；脚本通过 stdin 传 prompt，避免中文路径和非 ASCII 文本作为命令参数时出问题。

可以先跑环境检查：

```bash
node scripts/claude-task.mjs doctor
```

## 追问模式

如果预计 Claude Code 工作时需要中途补充信息或纠偏，使用 live 任务：

```bash
node scripts/claude-task.mjs start --live "Review the current diff."
node scripts/claude-task.mjs wait <task-id>
node scripts/claude-task.mjs ask <task-id> "Also check Windows path handling."
node scripts/claude-task.mjs finish <task-id>
node scripts/claude-task.mjs result <task-id>
```

`wait` 可以交给 Codex worker 子代理跑；主线程继续用 `ask` 追问。live 任务最后必须调用 `finish`，否则 stdin 会保持打开，`wait` 不会自行退出。

## 多 Claude 并行

把多条任务按行写入文件或 stdin：

```bash
node scripts/claude-task.mjs batch --json --profile research [--no-boundaries] --file tasks.txt
node scripts/claude-task.mjs wait-group --json [--retry-failed] --concurrency 2 <group-id>
node scripts/claude-task.mjs group-status --json <group-id>
node scripts/claude-task.mjs group-result --json <group-id>
```

多行 prompt 可以使用分隔符：

```bash
node scripts/claude-task.mjs batch --json --separator=--- --file tasks.md
```

或者使用 JSONL：

```bash
node scripts/claude-task.mjs batch --json --jsonl --file tasks.jsonl
```

如果 Codex worker 或外部进程中断，任务可能变成 `stale`。单任务可用 `wait --retry-stale <task-id>` 重新接管；`wait-group` 会自动重试 stale 子任务。

组任务失败后，可以在确认日志后使用 `wait-group --retry-failed <group-id>` 重跑失败子任务。

## 结果与清理

`result --json` 会返回 `parsedJson`，如果 Claude 的最终文本是 JSON 或 fenced JSON block，会自动解析：

```bash
node scripts/claude-task.mjs result --json <task-id>
```

清理旧日志：

```bash
node scripts/claude-task.mjs clean --older-than 7d
node scripts/claude-task.mjs clean --json --dry-run --older-than 12h
```

## 自测

本地自测：

```bash
node scripts/self-test.mjs
```
