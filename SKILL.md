---
name: codex-use-claude-code
description: Bridge Codex to Claude Code as a lightweight tracked helper through the official Claude Agent TypeScript SDK. Use when Codex should ask Claude Code for code review, architecture review, risk analysis, official documentation checks, second opinions, long-running investigation, or collaborative agent work while Codex remains in control through compact start/wait/status/result records and explicit approvals.
---

# Codex Use Claude Code

Use this skill to run Claude Code as an external tracked helper from Codex.

Default posture: Claude Code is a bounded reviewer. Codex remains the owner of edits, final judgment, and user communication.

## Core Pattern

Run Claude Code as a tracked job:

```bash
node <skill-dir>/scripts/claude-task.mjs start [--profile safe|research|full] [--approval ask|allow|deny] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --live [--profile safe|research|full] [--approval ask|allow|deny] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs wait [--retry-stale] [--retry-failed] <task-id>
node <skill-dir>/scripts/claude-task.mjs ask <task-id> <follow-up>
node <skill-dir>/scripts/claude-task.mjs finish <task-id>
node <skill-dir>/scripts/claude-task.mjs stop <task-id>
node <skill-dir>/scripts/claude-task.mjs approvals [--json] <task-id>
node <skill-dir>/scripts/claude-task.mjs approve <task-id> [approval-id]
node <skill-dir>/scripts/claude-task.mjs deny <task-id> [approval-id] [message]
node <skill-dir>/scripts/claude-task.mjs status [--json] <task-id>
node <skill-dir>/scripts/claude-task.mjs tail <task-id> 40
node <skill-dir>/scripts/claude-task.mjs result [--json] <task-id>
```

For worker-style use:

1. Run `start` locally from the target repository root.
2. Delegate `wait <task-id>` to a Codex worker subagent.
3. Keep working locally while the worker waits for Claude Code.
4. Use `status`, `tail`, `approvals`, or `result` from the main thread.

If the task may need mid-flight guidance, start it with `--live`. Then the main thread can run `ask <task-id> <follow-up>` while the worker is still running `wait`. Live tasks must be closed with `finish <task-id>`.

## SDK Backend

This skill uses the official `@anthropic-ai/claude-agent-sdk` package:

```js
import { query } from "@anthropic-ai/claude-agent-sdk";
```

It does not manually spawn the Claude CLI, does not hand-roll the lower-level JSONL protocol, and does not require a TypeScript build step. The script is a plain ESM `.mjs` wrapper around the TypeScript SDK.

Run `npm install` in the skill directory before first real use. The official SDK normally bundles the platform Claude Code binary through optional dependencies, so a separate Claude Code CLI install is not required. Use `CLAUDE_TASK_BIN` only when you need to override `pathToClaudeCodeExecutable`.

## Compact Storage

The script stores compact task records under:

```text
<target-repo>/.codex/claude-code/tasks/<task-id>.json
<target-repo>/.codex/claude-code/groups/<group-id>.json
```

It does not create unbounded raw `.log` files. `tail` prints recent compact events from the task record.

Defaults:

- Keep recent event summaries per task: `CLAUDE_TASK_EVENT_LIMIT=80`
- Keep final result up to: `CLAUDE_TASK_RESULT_MAX_CHARS=200000`
- Retain completed/failed/canceled tasks for: `CLAUDE_TASK_RETAIN_DAYS=7`
- Retain at least recent terminal tasks: `CLAUDE_TASK_RETAIN_TASKS=50`
- SDK transcript persistence: disabled by default via `persistSession: false`

`start` runs automatic cleanup for terminal tasks. Running, queued, approval-pending, and stale tasks are not auto-deleted.

## Profiles

Use `--profile safe`, `--profile research`, or `--profile full`.

`safe` is the default:

```js
{
  permissionMode: "dontAsk",
  tools: ["Read", "Grep", "Glob", "Bash", "AskUserQuestion"],
  allowedTools: [
    "Read",
    "Grep",
    "Glob",
    "Bash(git diff)",
    "Bash(git diff *)",
    "Bash(git status)",
    "Bash(git status *)",
    "Bash(git log)",
    "Bash(git log *)",
    "Bash(git show)",
    "Bash(git show *)"
  ],
  approvalMode: "deny",
  persistSession: false,
  maxBudgetUsd: 5.00
}
```

`research` adds and pre-approves `WebFetch` and `WebSearch`.

`full` uses the Claude Code preset tool surface and `acceptEdits`. Use it only when Codex intentionally wants Claude Code's fuller tool set. Prefer `--approval ask` when commands or other unapproved actions may be needed.

## Approvals

The default approval mode is `deny`, so hidden SDK permission prompts do not stall the job. Use `--approval ask` for yes/no control:

```bash
node <skill-dir>/scripts/claude-task.mjs start --profile full --approval ask <task>
node <skill-dir>/scripts/claude-task.mjs wait <task-id>
```

If `wait` runs in an interactive terminal, the script asks `[y/N]`. If `wait` runs in a non-interactive worker, use the main thread:

```bash
node <skill-dir>/scripts/claude-task.mjs approvals <task-id>
node <skill-dir>/scripts/claude-task.mjs approve <task-id> <approval-id>
node <skill-dir>/scripts/claude-task.mjs deny <task-id> <approval-id> "Reason for Claude"
```

Modes:

- `deny`: reject unapproved requests.
- `ask`: wait for a human decision. For `safe` and `research`, this switches `permissionMode` from `dontAsk` to `default` so the SDK `canUseTool` callback can fire.
- `allow`: automatically allow unapproved requests. Use only in controlled directories or trusted automation.

## Commands

```bash
node <skill-dir>/scripts/claude-task.mjs start [--profile safe|research|full] [--approval ask|allow|deny] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --live [--profile safe|research|full] [--approval ask|allow|deny] [--json] [--file prompt.md] [--stdin] <task>
node <skill-dir>/scripts/claude-task.mjs start --no-boundaries [--profile safe|research|full] <task>
node <skill-dir>/scripts/claude-task.mjs wait [--retry-stale] [--retry-failed] [task-id]
node <skill-dir>/scripts/claude-task.mjs ask <task-id> <follow-up>
node <skill-dir>/scripts/claude-task.mjs finish <task-id>
node <skill-dir>/scripts/claude-task.mjs stop [task-id]
node <skill-dir>/scripts/claude-task.mjs approvals [--json] [task-id]
node <skill-dir>/scripts/claude-task.mjs approve <task-id> [approval-id]
node <skill-dir>/scripts/claude-task.mjs deny <task-id> [approval-id] [message]
node <skill-dir>/scripts/claude-task.mjs doctor
node <skill-dir>/scripts/claude-task.mjs status [--json] [task-id]
node <skill-dir>/scripts/claude-task.mjs list [--json]
node <skill-dir>/scripts/claude-task.mjs tail [task-id] [lines]
node <skill-dir>/scripts/claude-task.mjs result [--json] [task-id]
node <skill-dir>/scripts/claude-task.mjs clean [--json] [--dry-run] [--older-than 7d] [--keep 50]
```

`status` reports `queued`, `running`, `stale`, `completed`, `failed`, `canceled`, or `missing`.

`result --json` returns `parsedJson` when the final result is JSON or a fenced JSON block.

## Task Groups

Use task groups when Codex wants several Claude Code reviewers:

```bash
node <skill-dir>/scripts/claude-task.mjs batch --json --profile research [--approval ask] [--no-boundaries] --file tasks.txt
node <skill-dir>/scripts/claude-task.mjs wait-group --json [--retry-failed] --concurrency 2 <group-id>
node <skill-dir>/scripts/claude-task.mjs group-status --json <group-id>
node <skill-dir>/scripts/claude-task.mjs group-result --json <group-id>
```

`wait-group` defaults to concurrency 2. Increase with `--concurrency` only when the machine and budget can handle more simultaneous SDK agents.

## Environment

Useful overrides:

```bash
CLAUDE_TASK_PROFILE=research
CLAUDE_TASK_APPROVAL_MODE=ask
CLAUDE_TASK_TOOLS="Read,Grep,Glob,Bash,AskUserQuestion,WebFetch,WebSearch"
CLAUDE_TASK_ALLOWED_TOOLS="Read,Grep,Glob,Bash(git diff),Bash(git diff *),Bash(git status),Bash(git status *),Bash(git log),Bash(git log *),Bash(git show),Bash(git show *)"
CLAUDE_TASK_PERMISSION_MODE=dontAsk
CLAUDE_TASK_SESSION_PERSISTENCE=1
CLAUDE_TASK_MAX_BUDGET_USD=5.00
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

`CLAUDE_TASK_BIN` is still supported as a compatibility override, but now maps to SDK `pathToClaudeCodeExecutable`.

`CLAUDE_TASK_SDK_MODULE` is intended for tests or local SDK overrides.

## Failure Handling

If `status` returns `failed` or `stale`, inspect compact events:

```bash
node <skill-dir>/scripts/claude-task.mjs tail <task-id>
```

If a task is no longer useful or appears stuck, cancel it:

```bash
node <skill-dir>/scripts/claude-task.mjs stop <task-id>
```

Common causes:

- SDK package has not been installed with `npm install`.
- The model or provider is unavailable.
- The task exceeded `CLAUDE_TASK_TIMEOUT_MS`, `CLAUDE_TASK_MAX_TURNS`, or `CLAUDE_TASK_MAX_BUDGET_USD`.
- The task is live and `finish <task-id>` has not been sent.
- The task is waiting for approval. Use `approvals <task-id>`, then `approve` or `deny`.

## Testing

Run the local self-test and audit:

```bash
node <skill-dir>/scripts/self-test.mjs
npm audit
```

The self-test uses a fake SDK module and does not require Claude credentials.
