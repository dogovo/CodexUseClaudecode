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
node <skill-dir>/scripts/claude-task.mjs start [--profile safe|research|full] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --live [--profile safe|research|full] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --no-boundaries [--profile safe|research|full] <task>
node <skill-dir>/scripts/claude-task.mjs wait [--retry-stale] [--retry-failed] <task-id>
node <skill-dir>/scripts/claude-task.mjs ask <task-id> <follow-up>
node <skill-dir>/scripts/claude-task.mjs finish <task-id>
node <skill-dir>/scripts/claude-task.mjs stop <task-id>
node <skill-dir>/scripts/claude-task.mjs doctor
node <skill-dir>/scripts/claude-task.mjs status [--json] <task-id>
node <skill-dir>/scripts/claude-task.mjs result [--json] <task-id>
node <skill-dir>/scripts/claude-task.mjs clean [--json] [--dry-run] [--older-than 7d]
```

For subagent-like use:

1. Run `start` locally from the target repository root.
2. Delegate `wait <task-id>` to a Codex worker subagent.
3. Keep working locally while the worker waits for Claude Code.
4. Use `status`, `tail`, or `result` from the main thread to collect output.

If the task may need mid-flight guidance, start it with `--live`. Then the main thread can run `ask <task-id> <follow-up>` while the worker is still running `wait`. Live tasks must be closed with `finish <task-id>`; otherwise `wait` keeps stdin open and will not exit on its own.

Do not rely on Windows `start`, `Start-Process`, or detached command windows for long Claude Code tasks. They can break Chinese or non-ASCII paths, inherit the wrong encoding, or disappear from Codex control.

## Commands

Run all commands from the target repository root unless `CLAUDE_BRIDGE_DIR` is set.

```bash
node <skill-dir>/scripts/claude-task.mjs start [--profile safe|research|full] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --live [--profile safe|research|full] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --no-boundaries [--profile safe|research|full] <task>
node <skill-dir>/scripts/claude-task.mjs wait [--retry-stale] [--retry-failed] [task-id]
node <skill-dir>/scripts/claude-task.mjs ask <task-id> <follow-up>
node <skill-dir>/scripts/claude-task.mjs finish <task-id>
node <skill-dir>/scripts/claude-task.mjs stop [task-id]
node <skill-dir>/scripts/claude-task.mjs doctor
node <skill-dir>/scripts/claude-task.mjs status [--json] [task-id]
node <skill-dir>/scripts/claude-task.mjs list [--json]
node <skill-dir>/scripts/claude-task.mjs tail [task-id]
node <skill-dir>/scripts/claude-task.mjs result [--json] [task-id]
node <skill-dir>/scripts/claude-task.mjs clean [--json] [--dry-run] [--older-than 7d]
```

`start` creates a job and prints the task id.

Use `start --file prompt.md` for long prompts, or pipe data with `start --stdin`, for example `git diff | node <skill-dir>/scripts/claude-task.mjs start --stdin "Review this diff"`. Use `--json` on `start`, `status`, `list`, or `result` when another script or Codex worker needs machine-readable output.

Use `--profile safe`, `--profile research`, or `--profile full` to choose Claude Code's tool surface. `safe` is the default read-oriented profile. `research` adds `WebFetch` and `WebSearch`. `full` passes `--tools default` to Claude Code for tasks where Codex intentionally wants the fuller Claude Code tool set. `full` may no longer behave like a read-only reviewer tool surface, so Codex must review the result and decide what to keep. The selected profile is saved in task metadata so a worker running `wait` uses the same launch configuration.

Use `--no-boundaries` only when the prompt already contains its own complete operating boundaries. By default, the helper appends a short boundary block that tells Claude Code it is an external helper for Codex and should report findings clearly.

`wait` runs Claude Code for the job and writes stream output to the job log. It should usually be run by a Codex worker subagent for long tasks. If a worker is interrupted and the task becomes `stale`, use `wait --retry-stale <task-id>` to rerun the same prompt into the same tracked log. If Claude Code fails, times out, or exits early, use `wait --retry-failed <task-id>` after checking the log.

`start --live` runs Claude Code with streaming stdin so Codex can provide follow-up guidance while Claude is working.

`ask` queues a follow-up for a live task. It can be used while `wait` is still running in another Codex worker or terminal.

`finish` is required for live tasks. It closes stdin after queued follow-ups are sent, allowing Claude Code to finish and exit.

`stop` cancels a queued, running, or stale task and signals the recorded Claude/worker processes when possible.

`doctor` checks the local Node.js version, Claude Code CLI availability, and bridge directory.

`status` reports `queued`, `running`, `stale`, `completed`, `failed`, `canceled`, or `missing`.

`result` extracts Claude Code's final text from `stream-json` logs. With `--json`, it also returns `parsedJson` when the final text is JSON or a fenced JSON block.

`tail` prints recent raw logs when debugging. Pass a line count as the second argument, for example `tail <task-id> 40`.

## Task Groups

Use task groups when Codex wants several Claude Code reviewers in parallel:

```bash
node <skill-dir>/scripts/claude-task.mjs batch --json --profile research [--no-boundaries] --file tasks.txt
node <skill-dir>/scripts/claude-task.mjs wait-group --json [--retry-failed] --concurrency 2 <group-id>
node <skill-dir>/scripts/claude-task.mjs group-status --json <group-id>
node <skill-dir>/scripts/claude-task.mjs group-result --json <group-id>
```

`batch` creates one task per non-empty line. Use `batch --separator=--- --file tasks.md` for multi-line prompts, or `batch --jsonl --file tasks.jsonl` for JSONL where each entry is a string or an object with a `prompt` field. `wait-group` runs multiple Claude Code processes concurrently and automatically retries `stale` group tasks, which is useful when a Codex worker times out or is interrupted before Claude Code writes a final result. Add `wait-group --retry-failed <group-id>` when you intentionally want failed group tasks to be rerun.

`clean` removes old task and group logs from `.codex/claude-code/`. Use `--dry-run` before deleting, and set age with values like `12h`, `7d`, or `30m`.

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

Live task follow-ups are stored next to the job as:

```text
<task-id>.inbox.jsonl
<task-id>.finish
```

## Environment

Requirements:

- Node.js 20.11 or newer. The scripts use ESM, `import.meta.url`, and modern Node standard-library APIs.
- Claude Code CLI must be available on PATH as `claude` or `claude.cmd`.
- On Windows, run from a UTF-8-capable shell when possible. The helper passes prompts through stdin to avoid argument-encoding problems with Chinese and other non-ASCII text.

Check the local environment with:

```bash
node <skill-dir>/scripts/claude-task.mjs doctor
```

Useful overrides:

```bash
CLAUDE_TASK_BIN=/absolute/path/to/claude
CLAUDE_TASK_PROFILE=research
CLAUDE_TASK_ALLOWED_TOOLS=Read,Grep,Glob,Bash(git diff),Bash(git status),Bash(git log),Bash(git show)
CLAUDE_TASK_TOOLS=default
CLAUDE_TASK_PERMISSION_MODE=acceptEdits
CLAUDE_TASK_SESSION_PERSISTENCE=1
CLAUDE_TASK_MAX_BUDGET_USD=5.00
CLAUDE_TASK_TIMEOUT_MS=0
CLAUDE_TASK_MAX_TURNS=8
CLAUDE_TASK_MODEL=sonnet
CLAUDE_TASK_POLL_MS=500
CLAUDE_TASK_BOUNDARIES="Custom task boundaries..."
```

`CLAUDE_TASK_BIN` is also useful for failure tests.

`CLAUDE_TASK_TIMEOUT_MS` is saved when the task is created. The default `0` means `wait` can run indefinitely, which is useful for very long Claude Code reviews. Set a positive value such as `1800000` to fail and stop a stuck Claude Code process after that many milliseconds. Timeout and `stop` paths clean up the Claude Code process tree where the platform supports it.

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

This skill sends every prompt through Claude Code's official SDK JSONL protocol:

```bash
claude -p --input-format stream-json --output-format stream-json --verbose --permission-mode acceptEdits --allowed-tools "Read,Grep,Glob,Bash(git diff),Bash(git status),Bash(git log),Bash(git show)" --no-session-persistence
```

Normal tasks send one JSON user message and close stdin immediately. Live tasks keep stdin open so follow-up user messages can be sent while Claude Code is working.

Reasons:

- `stream-json` requires `--verbose`.
- `acceptEdits` plus `--allowed-tools` lets Claude Code inspect files while keeping tool access constrained.
- Passing multi-line prompts as `cmd.exe` arguments is fragile.
- Detached Windows consoles can corrupt non-ASCII paths.
- Codex-managed workers are easier to track than OS-level background windows.

## Live Follow-ups

Use live mode when Codex may need to steer Claude Code after seeing early output or after the user adds context:

Important: every live task needs a final `finish <task-id>`. If a live task seems stuck, first check whether `finish` has been sent.

```bash
node <skill-dir>/scripts/claude-task.mjs start --live "Review the current diff. Do not edit files."
node <skill-dir>/scripts/claude-task.mjs wait <task-id>
node <skill-dir>/scripts/claude-task.mjs ask <task-id> "Also check the Windows path handling."
node <skill-dir>/scripts/claude-task.mjs finish <task-id>
node <skill-dir>/scripts/claude-task.mjs result <task-id>
```

For live mode, `wait` should normally run in a Codex worker subagent. The main Codex thread can keep using `ask`, `status`, `tail`, and the required final `finish`.

## Testing

Run the local self-test:

```bash
node <skill-dir>/scripts/self-test.mjs
```

The self-test uses an isolated temporary test executable and verifies normal JSONL tasks, live follow-ups, status logging, failure recovery, and result extraction.

## Failure Handling

If `status` returns `failed` or `stale`, inspect:

```bash
node <skill-dir>/scripts/claude-task.mjs tail <task-id>
```

If a task is no longer useful or appears stuck, cancel it:

```bash
node <skill-dir>/scripts/claude-task.mjs stop <task-id>
```

Common causes:

- Claude Code is not installed or not on PATH.
- The current directory is not trusted by Claude Code.
- The model or provider is unavailable.
- The task exceeded the configured budget.

If Claude Code is unavailable, continue without it and use Codex subagents or local inspection instead.
