# codex-use-claude

让 Codex 以 tracked job 的方式调用 Claude Code，用于只读审查、架构分析、风险扫描和第二视角协作。

## 使用

把本仓库作为 Codex skill 安装或引用后，让 Codex 使用 `$codex-use-claude`。

脚本也可以直接运行：

```bash
node scripts/claude-task.mjs start "Review the current diff. Do not edit files."
node scripts/claude-task.mjs wait <task-id>
node scripts/claude-task.mjs status <task-id>
node scripts/claude-task.mjs result <task-id>
```

长任务建议让 Codex 子代理执行 `wait`，主线程继续工作并用 `result` 收取结果。
