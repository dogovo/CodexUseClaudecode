# CodexUseClaudecode

<div align="center">
  <a href="https://github.com/dogovo/CodexUseClaudecode/blob/main/README.md">简体中文</a> / English
</div>

<div align="center">A lightweight tool skill that lets Codex run Claude Code as a tracked job through the official Claude Agent TypeScript SDK</div>
<div align="center">Useful for reviews, architecture analysis, risk scans, official documentation checks, second opinions, and parallel long-running investigations</div>

## Quick Start

Install or reference this repository as a Codex skill, then ask Codex to use `$codex-use-claude-code`.

Install the official SDK dependency before first use:

```bash
npm install
```

You can also run the script directly:

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

For long tasks, delegate `wait <task-id>` to a Codex worker subagent while the main thread watches progress with `status`, `tail`, and `result`.

## Lightweight Architecture

- Uses the official `@anthropic-ai/claude-agent-sdk` `query()` API instead of manually spawning the Claude CLI or hand-rolling the lower-level JSONL protocol.
- Keeps the implementation as a single ESM `.mjs` script with no TypeScript build chain, database, daemon, or framework.
- The official SDK bundles a platform Claude Code binary by default, so normal installs do not require a separate Claude Code CLI installation.
- Defaults to `persistSession: false` so SDK transcript files do not keep accumulating.
- Stores task records as compact JSON: `.codex/claude-code/tasks/<task-id>.json`.
- Stores group records as compact JSON: `.codex/claude-code/groups/<group-id>.json`.
- Does not write unbounded raw `.log` files. `tail` prints recent compact events from the task record.
- Keeps the most recent 50 terminal tasks and tasks from the last 7 days by default. `start` runs automatic cleanup, and `clean` can run it manually.
- Keeps 80 recent event summaries per task by default. Final results are capped at 200000 characters by default.

These limits can be tuned with environment variables.

## Safe Defaults

The default profile is `safe`:

- `permissionMode: "dontAsk"`
- `tools: ["Read", "Grep", "Glob", "Bash", "AskUserQuestion"]`
- `allowedTools`: pre-approves `Read`, `Grep`, `Glob`, and read-only `git diff/status/log/show` Bash commands
- `approvalMode: "deny"`
- `persistSession: false`
- `maxBudgetUsd: 5.00`

This follows the Claude Agent SDK distinction between `tools` and `allowedTools`: `tools` controls the visible tool surface, while `allowedTools` only auto-approves matching tool calls. `allowedTools` does not restrict tool visibility by itself. In `dontAsk` mode, unapproved tools are denied.

Available profiles:

- `safe`: read files, search files, and run common read-only git queries.
- `research`: adds and pre-approves `WebFetch` and `WebSearch` on top of `safe`.
- `full`: uses the Claude Code default tool preset and `acceptEdits`. Use it when you intentionally want Claude Code's full tool surface, preferably with `--approval ask` or an explicit automation approval policy.

## Approval Mode

The default does not pop up approvals and does not wait forever on hidden prompts. Enable the yes/no flow explicitly:

```bash
node scripts/claude-task.mjs start --profile full --approval ask "Run the needed checks and fix issues."
node scripts/claude-task.mjs wait <task-id>
```

If `wait` runs in an interactive terminal, the script asks `[y/N]` directly. If it runs in a non-interactive worker, the task records a pending approval that the main thread can inspect and answer:

```bash
node scripts/claude-task.mjs approvals <task-id>
node scripts/claude-task.mjs approve <task-id> <approval-id>
node scripts/claude-task.mjs deny <task-id> <approval-id> "Reason for Claude"
```

Approval modes:

- `--approval deny`: default, denies unapproved tool requests.
- `--approval ask`: requires a human yes/no decision. For safe and research profiles, this automatically changes `dontAsk` to `default` so the SDK `canUseTool` callback can run.
- `--approval allow`: automatically allows unapproved tool requests. Use only in isolated directories, trusted tasks, or short-lived automation.

## Environment Variables

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

`CLAUDE_TASK_BIN` remains as a compatibility override and maps to SDK `pathToClaudeCodeExecutable`. Set it only when optional dependencies were skipped, the platform binary is unavailable, or you intentionally want to use an external Claude Code executable.

`CLAUDE_TASK_SESSION_PERSISTENCE=1` enables SDK session persistence. It is disabled by default for a lightweight tracked helper workflow.

## Live Follow-ups

Use live tasks when Claude Code may need mid-flight guidance or correction:

```bash
node scripts/claude-task.mjs start --live "Review the current diff."
node scripts/claude-task.mjs wait <task-id>
node scripts/claude-task.mjs ask <task-id> "Also check Windows path handling."
node scripts/claude-task.mjs finish <task-id>
node scripts/claude-task.mjs result <task-id>
```

`wait` can run in a Codex worker subagent while the main thread sends follow-ups with `ask`. A live task must end with `finish`; otherwise the SDK input stream stays open and `wait` will not exit by itself.

## Parallel Work

```bash
node scripts/claude-task.mjs batch --json --profile research [--approval ask] [--no-boundaries] --file tasks.txt
node scripts/claude-task.mjs wait-group --json [--retry-failed] --concurrency 2 <group-id>
node scripts/claude-task.mjs group-status --json <group-id>
node scripts/claude-task.mjs group-result --json <group-id>
```

`wait-group` defaults to concurrency 2 so the lightweight skill does not start too many SDK agents at once. Increase it explicitly with `--concurrency` when the machine and budget can handle it.

## Cleanup

```bash
node scripts/claude-task.mjs clean --older-than 7d
node scripts/claude-task.mjs clean --json --dry-run --older-than 12h --keep 50
```

`start` automatically cleans terminal tasks according to `CLAUDE_TASK_RETAIN_DAYS` and `CLAUDE_TASK_RETAIN_TASKS`. Running, queued, approval-pending, and stale tasks are not removed automatically.

## Doctor And Tests

```bash
node scripts/claude-task.mjs doctor
node scripts/self-test.mjs
npm audit
```

`doctor` checks Node, SDK import, storage, and retention settings. `self-test` uses a fake SDK and does not require a real Claude account or API key. The repository keeps `package-lock.json` so installs, transitive dependency versions, and security audits are reproducible.
