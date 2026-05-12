---
name: codex-use-claude
description: Bridge Codex to Claude Code as a tracked external helper. Use when Codex should ask Claude Code for code review, architecture review, risk analysis, second opinions, long-running read-only investigation, or collaborative agent work while keeping Codex in control through start/wait/status/result logs. Especially useful on Windows where spawning detached Claude Code windows can break paths or encoding.
---

# Codex Use Claude

Use this skill to run Claude Code as an external tracked helper from Codex.

Default posture: Claude Code is a read-only reviewer. Codex remains the owner of edits, final judgment, and user communication.

## Core Pattern

Run Claude Code as a tracked job:

```bash
node <skill-dir>/scripts/claude-task.mjs start <task>
node <skill-dir>/scripts/claude-task.mjs wait <task-id>
node <skill-dir>/scripts/claude-task.mjs status <task-id>
node <skill-dir>/scripts/claude-task.mjs result <task-id>
```

For subagent-like use:

1. Run `start` locally from the target repository root.
2. Delegate `wait <task-id>` to a Codex worker subagent.
3. Keep working locally while the worker waits for Claude Code.
4. Use `status`, `tail`, or `result` from the main thread to collect output.

Do not rely on Windows `start`, `Start-Process`, or detached command windows for long Claude Code tasks. They can break Chinese or non-ASCII paths, inherit the wrong encoding, or disappear from Codex control.

## Commands

Run all commands from the target repository root unless `CLAUDE_BRIDGE_DIR` is set.

```bash
node <skill-dir>/scripts/claude-task.mjs start <task>
node <skill-dir>/scripts/claude-task.mjs wait [task-id]
node <skill-dir>/scripts/claude-task.mjs status [task-id]
node <skill-dir>/scripts/claude-task.mjs list
node <skill-dir>/scripts/claude-task.mjs tail [task-id]
node <skill-dir>/scripts/claude-task.mjs result [task-id]
```

`start` creates a job and prints the task id.

`wait` runs Claude Code for the job and writes stream output to the job log. It should usually be run by a Codex worker subagent for long tasks.

`status` reports `queued`, `running`, `completed`, `failed`, or `missing`.

`result` extracts Claude Code's final text from `stream-json` logs.

`tail` prints recent raw logs when debugging.

## Storage

The script stores jobs under:

```text
<target-repo>/.codex/claude-code/
```

Add this path to the target repository's `.gitignore` if needed:

```gitignore
.codex/claude-code/
```

To put logs elsewhere, set:

```bash
CLAUDE_BRIDGE_DIR=/path/to/job-dir
```

## Environment

Claude Code must be available on PATH as `claude` or `claude.cmd`.

Useful overrides:

```bash
CLAUDE_TASK_BIN=/absolute/path/to/claude
CLAUDE_TASK_MAX_BUDGET_USD=20.00
```

`CLAUDE_TASK_BIN` is also useful for failure tests.

## Prompting

Ask Claude Code for bounded, read-only work:

```text
Review the current diff for correctness risks. Do not modify files. Return findings by severity with file paths.
```

Good tasks:

- code review
- README or architecture review
- risk scanning
- comparing approaches
- checking for missed edge cases
- long read-only exploration

Avoid handing Claude Code urgent blocking work that Codex must integrate immediately. If the main thread is blocked, run the work locally instead.

## Windows Notes

This skill sends the prompt through stdin and uses `claude -p --input-format text --output-format stream-json --verbose`.

Reasons:

- `stream-json` requires `--verbose`.
- Passing multi-line prompts as `cmd.exe` arguments is fragile.
- Detached Windows consoles can corrupt non-ASCII paths.
- Codex-managed workers are easier to track than OS-level background windows.

## Failure Handling

If `status` returns `failed`, inspect:

```bash
node <skill-dir>/scripts/claude-task.mjs tail <task-id>
```

Common causes:

- Claude Code is not installed or not on PATH.
- The current directory is not trusted by Claude Code.
- The model or provider is unavailable.
- The task exceeded the configured budget.

If Claude Code is unavailable, continue without it and use Codex subagents or local inspection instead.
