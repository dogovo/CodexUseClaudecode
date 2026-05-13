# codex-use-claude

让 Codex 以 tracked job 的方式调用 Claude Code，用于只读审查、架构分析、风险扫描和第二视角协作。

## 使用

把本仓库作为 Codex skill 安装或引用后，让 Codex 使用 `$codex-use-claude`。

脚本也可以直接运行：

```bash
node scripts/claude-task.mjs start "Review the current diff. Do not edit files."
node scripts/claude-task.mjs start --file prompt.md
git diff | node scripts/claude-task.mjs start --stdin "Review this diff."
node scripts/claude-task.mjs wait [--retry-stale] <task-id>
node scripts/claude-task.mjs status --json <task-id>
node scripts/claude-task.mjs tail <task-id> 40
node scripts/claude-task.mjs stop <task-id>
node scripts/claude-task.mjs result --json <task-id>
```

长任务建议让 Codex 子代理执行 `wait`，主线程继续工作并用 `result` 收取结果。

如果不想让当前 Codex turn 被 `wait` 阻塞，让 Codex worker 子代理执行 `wait <task-id>`。主线程继续用 `tail`、`status` 和 `result` 观察进度。

给脚本或 Codex worker 解析时，优先使用 `--json`：

```bash
node scripts/claude-task.mjs start --json --file prompt.md
git diff | node scripts/claude-task.mjs start --json --stdin "Review this diff."
node scripts/claude-task.mjs list --json
node scripts/claude-task.mjs result --json <task-id>
```

## 环境要求

- Node.js 20.11 或更新版本。
- Claude Code CLI 已安装，并且命令行里能找到 `claude` 或 `claude.cmd`。
- Windows 上建议使用支持 UTF-8 的 shell；脚本通过 stdin 传 prompt，避免中文路径和非 ASCII 文本作为命令参数时出问题。

可以先跑环境检查：

```bash
node scripts/claude-task.mjs doctor
```

脚本统一使用 Claude Code 官方 SDK 的 JSONL 输入输出协议：

```bash
claude -p --input-format stream-json --output-format stream-json --verbose
```

普通任务发送一条 JSON user message 后立即关闭 stdin；live 任务保持 stdin 打开，用于中途追问。

## 追问模式

如果预计 Claude Code 工作时需要中途补充信息或纠偏，使用 live 任务：

```bash
node scripts/claude-task.mjs start --live "Review the current diff. Do not edit files."
node scripts/claude-task.mjs wait <task-id>
node scripts/claude-task.mjs ask <task-id> "Also check Windows path handling."
node scripts/claude-task.mjs finish <task-id>
node scripts/claude-task.mjs result <task-id>
```

`wait` 可以交给 Codex worker 子代理跑；主线程继续用 `ask` 追问。live 任务最后必须调用 `finish`，否则 stdin 会保持打开，`wait` 不会自行退出。

如果任务已经不需要或疑似卡住，可以取消：

```bash
node scripts/claude-task.mjs stop <task-id>
```

## 多 Claude 并行

把多条任务按行写入文件或 stdin：

```bash
node scripts/claude-task.mjs batch --json --file tasks.txt
node scripts/claude-task.mjs wait-group --json --concurrency 2 <group-id>
node scripts/claude-task.mjs group-status --json <group-id>
node scripts/claude-task.mjs group-result --json <group-id>
```

如果 Codex worker 或外部进程中断，任务可能变成 `stale`。单任务可用 `wait --retry-stale <task-id>` 重新接管；`wait-group` 会自动重试 stale 子任务。

## 自测

不依赖真实 Claude Code 的本地自测：

```bash
node scripts/self-test.mjs
```
