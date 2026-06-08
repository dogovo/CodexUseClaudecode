#!/usr/bin/env node
import { existsSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const rootDir = resolve(process.cwd());
const bridgeDir = resolve(process.env.CLAUDE_BRIDGE_DIR || join(rootDir, ".codex", "claude-code"));
const tasksDir = join(bridgeDir, "tasks");
const groupsDir = join(bridgeDir, "groups");
const command = process.argv[2] || "help";
const args = process.argv.slice(3);

const terminalStatuses = new Set(["completed", "failed", "canceled"]);
const readOnlyTools = ["Read", "Grep", "Glob", "Bash"];
const readOnlyGitTools = [
  "Bash(git diff)",
  "Bash(git diff *)",
  "Bash(git status)",
  "Bash(git status *)",
  "Bash(git log)",
  "Bash(git log *)",
  "Bash(git show)",
  "Bash(git show *)"
];
const toolProfiles = {
  safe: {
    permissionMode: "dontAsk",
    tools: readOnlyTools,
    allowedTools: readOnlyGitTools
  },
  research: {
    permissionMode: "dontAsk",
    tools: [...readOnlyTools, "WebFetch", "WebSearch"],
    allowedTools: readOnlyGitTools
  },
  full: {
    permissionMode: "acceptEdits",
    tools: { type: "preset", preset: "claude_code" },
    allowedTools: []
  }
};

try {
  if (command === "start") {
    await startTask(args);
  } else if (command === "wait") {
    await waitTask(args);
  } else if (command === "tail") {
    await tailTask(args);
  } else if (command === "result") {
    await resultTask(args);
  } else if (command === "ask") {
    await askTask(args);
  } else if (command === "finish") {
    await finishTask(args);
  } else if (command === "stop") {
    await stopTask(args);
  } else if (command === "doctor") {
    await doctorTask();
  } else if (command === "batch") {
    await batchTask(args);
  } else if (command === "wait-group") {
    await waitGroupTask(args);
  } else if (command === "group-status") {
    await groupStatusTask(args);
  } else if (command === "group-result") {
    await groupResultTask(args);
  } else if (command === "stop-group") {
    await stopGroupTask(args);
  } else if (command === "clean") {
    await cleanTask(args);
  } else if (command === "status") {
    await statusTask(args);
  } else if (command === "list") {
    await listTasks(args);
  } else if (command === "run") {
    await runTask(args);
  } else {
    printHelp();
  }
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}

async function startTask(values) {
  const { flags, rest } = parseFlags(values);
  const prompt = await readPrompt(flags, rest);
  if (!prompt) throw new Error("Missing prompt. Example: claude-task.mjs start Review the current diff");

  await createTask({
    prompt,
    live: flags.has("live") || flags.has("followups"),
    json: flags.has("json"),
    boundaries: flags.has("no-boundaries") ? "" : boundaryPrompt(),
    profile: flags.get("profile")
  });
}

async function createTask({ prompt, live, json = false, silent = false, groupId = null, boundaries = boundaryPrompt(), profile = null, cleanFirst = true }) {
  await ensureStorage();
  if (cleanFirst) await autoClean({ silent: true });

  const id = timestamp();
  const createdAt = now();
  const launchOptions = claudeLaunchOptions({ profile });
  const timeoutMs = parseNonNegativeInt(process.env.CLAUDE_TASK_TIMEOUT_MS || "0", "CLAUDE_TASK_TIMEOUT_MS");
  const eventLimit = eventLimitValue();
  const fullPrompt = [
    "Please complete this read-only task.",
    "",
    prompt,
    boundaries ? `\n${boundaries}` : ""
  ].filter(Boolean).join("\n");
  const task = {
    schemaVersion: 2,
    storage: "compact-json",
    id,
    cwd: rootDir,
    status: "queued",
    live,
    groupId,
    profile: launchOptions.profile,
    options: publicLaunchOptions(launchOptions),
    timeoutMs,
    eventLimit,
    prompt,
    fullPrompt,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    workerPid: null,
    sessionId: null,
    result: null,
    resultSubtype: null,
    isError: null,
    totalCostUsd: null,
    usage: null,
    permissionDenials: [],
    error: null,
    stopRequestedAt: null,
    inboxOffset: 0,
    events: [event("queued", "Task created")]
  };

  await writeJsonAtomic(taskFile(id), task);
  if (live) await writeFile(taskInboxFile(id), "", "utf8");

  const record = taskRecord(task);
  if (silent) return record;
  if (json) {
    console.log(JSON.stringify(record, null, 2));
  } else {
    console.log(`Started Claude Code task: ${id}`);
    console.log(`Record: ${displayPath(taskFile(id))}`);
    if (live) {
      console.log(`Ask: node ${displayPath(process.argv[1])} ask ${id} <message>`);
      console.log(`Finish: node ${displayPath(process.argv[1])} finish ${id}`);
    }
    console.log(`Run: node ${displayPath(process.argv[1])} wait ${id}`);
  }
  return record;
}

async function waitTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  await runTask([
    ...(flags.has("retry-stale") ? ["--retry-stale"] : []),
    ...(flags.has("retry-failed") ? ["--retry-failed"] : []),
    id
  ]);
}

async function runTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0];
  if (!id) throw new Error("Missing task id.");

  let releaseLock = null;
  const retryStale = flags.has("retry-stale");
  const retryFailed = flags.has("retry-failed");
  const status = await taskStatus(id);
  if (status !== "queued" && !(status === "stale" && retryStale) && !(status === "failed" && retryFailed)) {
    throw new Error(`Task is ${status}; wait can only run queued tasks${status === "stale" ? " unless --retry-stale is set" : ""}${status === "failed" ? " unless --retry-failed is set" : ""}. Start a new task if you need another Claude Code run.`);
  }

  try {
    releaseLock = await acquireTaskLock(id);
    const lockedStatus = await taskStatus(id);
    if (lockedStatus !== "queued" && !(lockedStatus === "stale" && retryStale) && !(lockedStatus === "failed" && retryFailed)) {
      throw new Error(`Task is ${lockedStatus}; another worker may have taken it.`);
    }

    const task = await readTask(id);
    const startedAt = now();
    await updateTask(id, {
      status: "running",
      workerPid: process.pid,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      error: null,
      result: null,
      resultSubtype: null,
      isError: null
    }, event(lockedStatus === "queued" ? "running" : `retry-${lockedStatus}`, `Worker ${process.pid} started SDK query`));

    const abortController = new AbortController();
    const stopState = { stopped: false, timedOut: false };
    const timeoutTimer = startTimeout(task.timeoutMs || 0, abortController, stopState);
    const stopWatcher = watchStopSignal(id, abortController, stopState);

    let resultMessage = null;
    try {
      const { query } = await loadSdk();
      const promptInput = task.live ? livePromptStream(id, task.fullPrompt, abortController.signal) : task.fullPrompt;
      const options = sdkOptions(task, abortController);
      await recordEvent(id, event("sdk-start", "Claude Agent SDK query started", {
        profile: task.profile,
        persistSession: options.persistSession
      }));

      for await (const message of query({ prompt: promptInput, options })) {
        resultMessage = message?.type === "result" ? message : resultMessage;
        await handleSdkMessage(id, message);
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      abortController.abort();
      await stopWatcher;
    }

    const finalTask = await readTask(id);
    const finishedAt = now();
    if (finalTask.stopRequestedAt || stopState.stopped) {
      await updateTask(id, {
        status: "canceled",
        finishedAt,
        updatedAt: finishedAt,
        error: null
      }, event("canceled", "Task canceled"));
      process.exitCode = 130;
      return;
    }

    if (stopState.timedOut) {
      await updateTask(id, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: `Claude Agent SDK task timed out after ${task.timeoutMs}ms`
      }, event("timeout", `Timed out after ${task.timeoutMs}ms`));
      process.exitCode = 124;
      return;
    }

    const failed = !resultMessage || resultMessage.subtype !== "success" || resultMessage.is_error === true;
    await updateTask(id, {
      status: failed ? "failed" : "completed",
      finishedAt,
      updatedAt: finishedAt,
      sessionId: resultMessage?.session_id || finalTask.sessionId || null,
      resultSubtype: resultMessage?.subtype || null,
      isError: typeof resultMessage?.is_error === "boolean" ? resultMessage.is_error : null,
      result: typeof resultMessage?.result === "string" ? limitResult(resultMessage.result) : finalTask.result,
      totalCostUsd: typeof resultMessage?.total_cost_usd === "number" ? resultMessage.total_cost_usd : null,
      usage: resultMessage?.usage || null,
      permissionDenials: resultMessage?.permission_denials || [],
      error: failed ? resultErrorText(resultMessage) : null
    }, event(failed ? "failed" : "completed", failed ? resultErrorText(resultMessage) : "Task completed"));
    if (failed) process.exitCode = 1;
  } catch (error) {
    if (!releaseLock) {
      process.exitCode = 1;
      throw error;
    }
    const task = await readTask(id).catch(() => null);
    const finishedAt = now();
    if (task?.stopRequestedAt) {
      await updateTask(id, {
        status: "canceled",
        finishedAt,
        updatedAt: finishedAt,
        error: null
      }, event("canceled", "Task canceled"));
      process.exitCode = 130;
    } else {
      await updateTask(id, {
        status: "failed",
        finishedAt,
        updatedAt: finishedAt,
        error: error.message
      }, event("error", error.message));
      process.exitCode = 1;
    }
  } finally {
    if (releaseLock) await releaseLock();
  }
}

async function statusTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  const task = await readTask(id);
  const status = await taskStatus(id);
  if (flags.has("json")) {
    console.log(JSON.stringify({ ...publicTask(task), status }, null, 2));
    return;
  }
  console.log(`id: ${task.id}`);
  console.log(`status: ${status}`);
  console.log(`record: ${displayPath(taskFile(id))}`);
  console.log(`profile: ${task.profile}`);
  console.log(`createdAt: ${task.createdAt}`);
  if (task.startedAt) console.log(`startedAt: ${task.startedAt}`);
  if (task.finishedAt) console.log(`finishedAt: ${task.finishedAt}`);
  if (task.sessionId) console.log(`sessionId: ${task.sessionId}`);
  if (task.totalCostUsd !== null && task.totalCostUsd !== undefined) console.log(`totalCostUsd: ${task.totalCostUsd}`);
  if (task.live) console.log("live: true");
  if (task.error) console.log(`error: ${task.error}`);
  console.log(`prompt: ${task.prompt}`);
}

async function askTask(values) {
  const id = values[0] || await latestTaskId();
  const message = values.slice(1).join(" ").trim();
  if (!id) throw new Error("Missing task id. Use list first.");
  if (!message) throw new Error("Missing follow-up message.");

  const task = await readTask(id);
  if (!task.live) throw new Error("This task was not started with --live. Start live tasks with: claude-task.mjs start --live <prompt>");
  const status = await taskStatus(id);
  if (status !== "queued" && status !== "running") {
    throw new Error(`Task is ${status}; follow-ups can only be queued for live tasks that are queued or running.`);
  }

  const followup = { id: randomUUID(), at: now(), text: message };
  await appendFile(taskInboxFile(id), `${JSON.stringify(followup)}\n`, "utf8");
  await recordEvent(id, event("follow-up-queued", message));
  console.log(`Queued follow-up for Claude Code task: ${id}`);
}

async function finishTask(values) {
  const id = values[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  const task = await readTask(id);
  if (!task.live) throw new Error("This task is not a live task.");
  const status = await taskStatus(id);
  if (status !== "queued" && status !== "running") {
    throw new Error(`Task is ${status}; finish can only close live tasks that are queued or running.`);
  }
  await writeFile(taskFinishFile(id), `${now()}\n`, "utf8");
  await recordEvent(id, event("finish-requested", "Live input will close after queued follow-ups are sent"));
  console.log(`Finish requested for Claude Code task: ${id}`);
}

async function stopTask(values) {
  const { rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  const outcome = await stopOneTask(id);
  console.log(`Stop requested for Claude Code task: ${id}`);
  console.log(`status: ${outcome.status}`);
}

async function stopOneTask(id) {
  const task = await readTask(id);
  const status = await taskStatus(id);
  if (status !== "queued" && status !== "running" && status !== "stale") {
    throw new Error(`Task is ${status}; stop only applies to queued, running, or stale tasks.`);
  }
  const stoppedAt = now();
  await writeFile(taskStopFile(id), `${stoppedAt}\n`, "utf8");
  if (task.live) await writeFile(taskFinishFile(id), `${stoppedAt}\n`, "utf8");
  await updateTask(id, {
    status: "canceled",
    stopRequestedAt: stoppedAt,
    finishedAt: status === "queued" || status === "stale" ? stoppedAt : task.finishedAt,
    updatedAt: stoppedAt
  }, event("stop-requested", "Abort signal recorded"));
  return { taskId: id, status: "canceled" };
}

async function doctorTask() {
  let ok = true;
  console.log(`node: ${process.versions.node}`);
  if (!isAtLeastNode("18.0.0")) {
    ok = false;
    console.log("nodeStatus: failed (requires Node.js 18.0.0 or newer)");
  } else {
    console.log("nodeStatus: ok");
  }
  console.log(`bridgeDir: ${displayPath(bridgeDir)}`);
  console.log(`storage: compact-json`);
  console.log(`retentionDays: ${retentionDaysValue()}`);
  console.log(`retentionTasks: ${retentionTasksValue()}`);
  console.log(`eventLimit: ${eventLimitValue()}`);
  try {
    await loadSdk();
    console.log("sdkStatus: ok");
    console.log("sdkPackage: @anthropic-ai/claude-agent-sdk");
  } catch (error) {
    ok = false;
    console.log("sdkStatus: failed");
    console.log(`sdkError: ${error.message}`);
  }
  if (!ok) process.exitCode = 1;
}

async function batchTask(values) {
  const { flags, rest } = parseFlags(values);
  const source = await readPromptSource(flags, rest);
  const prompts = parseBatchPrompts(source, flags);
  if (!prompts.length) throw new Error("Missing batch prompts. Provide non-empty lines via --file, --stdin, or arguments.");

  await ensureStorage();
  await autoClean({ silent: true });
  const groupId = `group-${timestamp()}`;
  const tasks = [];
  for (const prompt of prompts) {
    tasks.push(await createTask({
      prompt,
      live: flags.has("live") || flags.has("followups"),
      silent: true,
      groupId,
      boundaries: flags.has("no-boundaries") ? "" : boundaryPrompt(),
      profile: flags.get("profile"),
      cleanFirst: false
    }));
  }
  const group = {
    schemaVersion: 2,
    id: groupId,
    cwd: rootDir,
    createdAt: now(),
    promptCount: prompts.length,
    taskIds: tasks.map((task) => task.id),
    tasks
  };
  await writeJsonAtomic(groupFile(groupId), group);

  if (flags.has("json")) {
    console.log(JSON.stringify(group, null, 2));
    return;
  }
  console.log(`Started Claude Code group: ${groupId}`);
  console.log(`Tasks: ${tasks.length}`);
  console.log(`Run: node ${displayPath(process.argv[1])} wait-group ${groupId}`);
  console.log(`Status: node ${displayPath(process.argv[1])} group-status ${groupId}`);
}

async function waitGroupTask(values) {
  const { flags, rest } = parseFlags(values);
  const groupId = rest[0] || await latestGroupId();
  if (!groupId) throw new Error("Missing group id.");
  const group = await readGroup(groupId);
  const defaultConcurrency = Math.min(group.taskIds.length, parsePositiveInt(process.env.CLAUDE_TASK_GROUP_CONCURRENCY || "2", "CLAUDE_TASK_GROUP_CONCURRENCY"));
  const concurrency = parsePositiveInt(flags.get("concurrency") || flags.get("n") || String(defaultConcurrency), "concurrency");
  const retryFailed = flags.has("retry-failed");
  const outcomes = await runLimited(group.taskIds, concurrency, async (taskId) => {
    const status = await taskStatus(taskId);
    if (status !== "queued" && status !== "stale" && !(status === "failed" && retryFailed)) return { taskId, skipped: true, status };
    await runTask([
      ...(status === "stale" ? ["--retry-stale"] : []),
      ...(status === "failed" ? ["--retry-failed"] : []),
      taskId
    ]);
    return { taskId, skipped: false, status: await taskStatus(taskId) };
  });
  const failed = outcomes.filter((outcome) => outcome.status === "failed" || outcome.error);
  if (flags.has("json")) {
    console.log(JSON.stringify({ groupId, outcomes }, null, 2));
  } else {
    for (const outcome of outcomes) {
      console.log(`${outcome.taskId} status=${outcome.status}${outcome.skipped ? " skipped=true" : ""}`);
      if (outcome.error) console.log(`  error=${outcome.error}`);
    }
  }
  if (failed.length) process.exitCode = 1;
}

async function groupStatusTask(values) {
  const { flags, rest } = parseFlags(values);
  const groupId = rest[0] || await latestGroupId();
  if (!groupId) throw new Error("Missing group id.");
  const group = await readGroup(groupId);
  const tasks = [];
  for (const taskId of group.taskIds) {
    const task = await readTask(taskId);
    tasks.push({ ...publicTask(task), status: await taskStatus(taskId) });
  }
  if (flags.has("json")) {
    console.log(JSON.stringify({ ...group, tasks }, null, 2));
    return;
  }
  console.log(`group: ${group.id}`);
  for (const task of tasks) console.log(`${task.id} status=${task.status} record=${task.record}`);
}

async function groupResultTask(values) {
  const { flags, rest } = parseFlags(values);
  const groupId = rest[0] || await latestGroupId();
  if (!groupId) throw new Error("Missing group id.");
  const group = await readGroup(groupId);
  const results = [];
  for (const taskId of group.taskIds) {
    const task = await readTask(taskId);
    results.push({
      id: taskId,
      status: await taskStatus(taskId),
      result: task.result,
      parsedJson: parseEmbeddedJson(task.result)
    });
  }
  if (flags.has("json")) {
    console.log(JSON.stringify({ groupId, results }, null, 2));
    return;
  }
  for (const item of results) {
    console.log(`## ${item.id} status=${item.status}`);
    console.log(item.result || "No result yet.");
    console.log("");
  }
}

async function stopGroupTask(values) {
  const { flags, rest } = parseFlags(values);
  const groupId = rest[0] || await latestGroupId();
  if (!groupId) throw new Error("Missing group id.");
  const group = await readGroup(groupId);
  const outcomes = [];
  for (const taskId of group.taskIds) {
    const status = await taskStatus(taskId);
    if (status === "queued" || status === "running" || status === "stale") {
      outcomes.push(await stopOneTask(taskId));
    } else {
      outcomes.push({ taskId, status, skipped: true });
    }
  }
  if (flags.has("json")) {
    console.log(JSON.stringify({ groupId, outcomes }, null, 2));
  } else {
    for (const outcome of outcomes) console.log(`${outcome.taskId} status=${outcome.status}${outcome.skipped ? " skipped=true" : ""}`);
  }
}

async function cleanTask(values) {
  const { flags } = parseFlags(values);
  const olderThan = parseDurationMs(String(flags.get("older-than") || `${retentionDaysValue()}d`));
  const keep = parseNonNegativeInt(String(flags.get("keep") || retentionTasksValue()), "keep");
  const dryRun = flags.has("dry-run");
  const removed = await autoClean({ olderThan, keep, dryRun, silent: true, includeActive: false });
  if (flags.has("json")) {
    console.log(JSON.stringify({ dryRun, olderThanMs: olderThan, keep, removed }, null, 2));
    return;
  }
  if (!removed.length) {
    console.log("No old Claude Code task records to clean.");
    return;
  }
  for (const item of removed) console.log(`${dryRun ? "would remove" : "removed"} ${item.type} ${item.id}`);
}

async function listTasks(values = []) {
  const { flags } = parseFlags(values);
  if (!existsSync(tasksDir)) {
    console.log(flags.has("json") ? "[]" : "No Claude Code tasks.");
    return;
  }
  const tasks = await allTasks();
  if (!tasks.length) {
    console.log(flags.has("json") ? "[]" : "No Claude Code tasks.");
    return;
  }
  const rows = [];
  for (const task of tasks) rows.push({ ...publicTask(task), status: await taskStatus(task.id) });
  if (flags.has("json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  for (const task of rows) console.log(`${task.id} status=${task.status} record=${task.record}`);
}

async function tailTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  const lines = parsePositiveInt(flags.get("lines") || flags.get("n") || rest[1] || "40", "line count");
  const task = await readTask(id);
  for (const item of (task.events || []).slice(-lines)) {
    const data = item.data ? ` ${JSON.stringify(item.data)}` : "";
    console.log(`[${item.at}] ${item.type}: ${item.text || ""}${data}`.trimEnd());
  }
}

async function resultTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  const task = await readTask(id);
  if (flags.has("json")) {
    console.log(JSON.stringify({
      id,
      status: await taskStatus(id),
      sessionId: task.sessionId || null,
      subtype: task.resultSubtype || null,
      isError: task.isError ?? null,
      totalCostUsd: task.totalCostUsd ?? null,
      result: task.result,
      parsedJson: parseEmbeddedJson(task.result),
      error: task.error || null
    }, null, 2));
    return;
  }
  if (task.result) {
    console.log(task.result.trim());
    return;
  }
  console.log("Claude task has no final text result yet. Use tail for recent compact events.");
}

async function readPrompt(flags, rest) {
  return (await readPromptSource(flags, rest)).trim();
}

async function readPromptSource(flags, rest) {
  const promptFromFile = flags.has("file") ? await readFile(resolve(String(flags.get("file"))), "utf8") : "";
  const promptFromStdin = flags.has("stdin") ? await readStdin() : "";
  return [rest.join(" "), promptFromFile, promptFromStdin].filter(Boolean).join(flags.has("stdin") ? "\n\n" : "\n");
}

async function ensureStorage() {
  await mkdir(tasksDir, { recursive: true });
  await mkdir(groupsDir, { recursive: true });
}

async function loadSdk() {
  const specifier = process.env.CLAUDE_TASK_SDK_MODULE || "@anthropic-ai/claude-agent-sdk";
  try {
    const moduleSpecifier = importSpecifier(specifier);
    const sdk = await import(moduleSpecifier);
    if (typeof sdk.query !== "function") throw new Error("module does not export query()");
    return sdk;
  } catch (error) {
    throw new Error(`Could not load Claude Agent SDK (${specifier}). Install with: npm install @anthropic-ai/claude-agent-sdk. ${error.message}`);
  }
}

function importSpecifier(value) {
  if (/^[a-z@][a-z0-9@/_.-]*$/iu.test(value) && !value.includes("\\") && !value.match(/^[a-z]:/iu)) return value;
  if (value.startsWith("file:")) return value;
  return pathToFileURL(resolve(value)).href;
}

function claudeLaunchOptions(options = {}) {
  const profileName = String(options.profile || process.env.CLAUDE_TASK_PROFILE || "safe");
  const profile = toolProfiles[profileName];
  if (!profile) throw new Error(`Unknown Claude task profile: ${profileName}. Use safe, research, or full.`);
  const tools = parseToolsOverride(process.env.CLAUDE_TASK_TOOLS, profile.tools);
  return {
    profile: profileName,
    permissionMode: options.permissionMode || process.env.CLAUDE_TASK_PERMISSION_MODE || profile.permissionMode,
    allowedTools: splitCsv(process.env.CLAUDE_TASK_ALLOWED_TOOLS) || profile.allowedTools,
    tools,
    persistSession: process.env.CLAUDE_TASK_SESSION_PERSISTENCE === "1",
    maxBudgetUsd: parseOptionalNonNegativeFloat(process.env.CLAUDE_TASK_MAX_BUDGET_USD || "5.00", "CLAUDE_TASK_MAX_BUDGET_USD"),
    maxTurns: process.env.CLAUDE_TASK_MAX_TURNS ? parsePositiveInt(process.env.CLAUDE_TASK_MAX_TURNS, "CLAUDE_TASK_MAX_TURNS") : null,
    model: process.env.CLAUDE_TASK_MODEL || null,
    pathToClaudeCodeExecutable: process.env.CLAUDE_TASK_BIN || null,
    settingSources: splitCsv(process.env.CLAUDE_TASK_SETTING_SOURCES)
  };
}

function sdkOptions(task, abortController) {
  const saved = task.options || {};
  const options = {
    cwd: task.cwd,
    abortController,
    permissionMode: saved.permissionMode || "dontAsk",
    tools: deserializeTools(saved.tools),
    allowedTools: Array.isArray(saved.allowedTools) ? saved.allowedTools : [],
    persistSession: saved.persistSession === true,
    maxBudgetUsd: typeof saved.maxBudgetUsd === "number" ? saved.maxBudgetUsd : 5.00
  };
  if (Number.isInteger(saved.maxTurns)) options.maxTurns = saved.maxTurns;
  if (saved.model) options.model = saved.model;
  if (saved.pathToClaudeCodeExecutable) options.pathToClaudeCodeExecutable = saved.pathToClaudeCodeExecutable;
  if (Array.isArray(saved.settingSources) && saved.settingSources.length) options.settingSources = saved.settingSources;
  return options;
}

function publicLaunchOptions(options) {
  return {
    profile: options.profile,
    permissionMode: options.permissionMode,
    tools: serializeTools(options.tools),
    allowedTools: options.allowedTools,
    persistSession: options.persistSession,
    maxBudgetUsd: options.maxBudgetUsd,
    maxTurns: options.maxTurns,
    model: options.model,
    pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
    settingSources: options.settingSources
  };
}

function serializeTools(tools) {
  if (Array.isArray(tools)) return tools;
  if (tools?.type === "preset") return { type: "preset", preset: tools.preset };
  return [];
}

function deserializeTools(tools) {
  if (Array.isArray(tools)) return tools;
  if (tools?.type === "preset") return { type: "preset", preset: tools.preset };
  return [];
}

function parseToolsOverride(value, fallback) {
  if (!value) return fallback;
  if (value === "default" || value === "claude_code") return { type: "preset", preset: "claude_code" };
  return splitCsv(value) || [];
}

async function handleSdkMessage(id, message) {
  if (!message || typeof message !== "object") return;
  if (message.type === "assistant") {
    const text = assistantText(message);
    if (text) await recordEvent(id, event("assistant", text));
    return;
  }
  if (message.type === "result") {
    await updateTask(id, {
      sessionId: message.session_id || null,
      resultSubtype: message.subtype || null,
      isError: typeof message.is_error === "boolean" ? message.is_error : null,
      result: typeof message.result === "string" ? limitResult(message.result) : null,
      totalCostUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : null,
      usage: message.usage || null,
      permissionDenials: message.permission_denials || []
    }, event("result", resultEventText(message), {
      subtype: message.subtype,
      isError: message.is_error,
      totalCostUsd: message.total_cost_usd
    }));
    return;
  }
  if (message.type === "system" && message.subtype === "init") {
    await updateTask(id, {
      sessionId: message.session_id || null
    }, event("init", `model=${message.model || "unknown"} tools=${Array.isArray(message.tools) ? message.tools.join(",") : ""}`, {
      permissionMode: message.permissionMode,
      version: message.claude_code_version
    }));
    return;
  }
  if (message.type === "system") {
    await recordEvent(id, event(`system:${message.subtype || "message"}`, systemEventText(message)));
    return;
  }
  await recordEvent(id, event(message.type || "message", compactJson(message)));
}

async function* livePromptStream(id, initialPrompt, signal) {
  yield sdkUserMessage(initialPrompt);
  let offset = 0;
  while (!signal.aborted) {
    let batch = await readQueuedFollowUps(id, offset);
    offset = batch.nextOffset;
    for (const message of batch.messages) yield message;
    const task = await readTask(id).catch(() => null);
    if (task) await updateTask(id, { inboxOffset: offset, updatedAt: now() });
    if (existsSync(taskFinishFile(id)) || existsSync(taskStopFile(id))) {
      batch = await readQueuedFollowUps(id, offset);
      offset = batch.nextOffset;
      for (const message of batch.messages) yield message;
      await recordEvent(id, event("live-input-closed", "Finish signal received"));
      return;
    }
    await delay(pollMsValue());
  }
}

async function readQueuedFollowUps(id, offset) {
  const inboxFile = taskInboxFile(id);
  if (!existsSync(inboxFile)) return { messages: [], nextOffset: offset };
  const content = await readFile(inboxFile, "utf8");
  const next = content.slice(offset);
  if (!next.trim()) return { messages: [], nextOffset: content.length };
  const messages = [];
  for (const line of next.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const item = JSON.parse(line);
    await recordEvent(id, event("follow-up-sent", item.text));
    messages.push(sdkUserMessage(followUpPrompt(item.text)));
  }
  return { messages, nextOffset: content.length };
}

function sdkUserMessage(text) {
  return {
    type: "user",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [{ type: "text", text }]
    }
  };
}

function startTimeout(timeoutMs, abortController, stopState) {
  if (!timeoutMs) return null;
  return setTimeout(() => {
    stopState.timedOut = true;
    abortController.abort();
  }, timeoutMs);
}

async function watchStopSignal(id, abortController, stopState) {
  while (!abortController.signal.aborted) {
    if (existsSync(taskStopFile(id))) {
      stopState.stopped = true;
      abortController.abort();
      return;
    }
    await delay(pollMsValue());
  }
}

async function acquireTaskLock(id) {
  await ensureStorage();
  const file = taskLockFile(id);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: now() }), "utf8");
      await handle.close();
      return async () => {
        await rm(file, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lock = await readLock(file);
      if (!lock.pid || !processExists(lock.pid)) {
        await rm(file, { force: true });
        continue;
      }
      throw new Error(`Task is already locked by worker ${lock.pid}.`);
    }
  }
  throw new Error(`Could not acquire task lock: ${id}`);
}

async function readLock(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function taskStatus(id) {
  let task;
  try {
    task = await readTask(id);
  } catch (error) {
    if (error.code === "ENOENT") return "missing";
    throw error;
  }
  if (task.status === "running") {
    if (Number.isInteger(task.workerPid) && processExists(task.workerPid)) return "running";
    return "stale";
  }
  return task.status || "queued";
}

async function readTask(id) {
  return readJsonWithRetry(taskFile(id));
}

async function readGroup(id) {
  return readJsonWithRetry(groupFile(id));
}

async function readJsonWithRetry(file) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      lastError = error;
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      await delay(25);
    }
  }
  throw lastError;
}

async function updateTask(id, values, newEvent = null) {
  const task = await readTask(id);
  const updated = {
    ...task,
    ...values,
    updatedAt: values.updatedAt || now()
  };
  if (newEvent) {
    updated.events = [...(task.events || []), newEvent].slice(-eventLimitForTask(updated));
  }
  await writeJsonAtomic(taskFile(id), updated);
  return updated;
}

async function recordEvent(id, newEvent) {
  return updateTask(id, {}, newEvent);
}

function event(type, text = "", data = null) {
  return {
    at: now(),
    type,
    text: clip(String(text || ""), eventTextLimitValue()),
    ...(data ? { data } : {})
  };
}

async function autoClean({ olderThan = retentionDaysValue() * 86_400_000, keep = retentionTasksValue(), dryRun = false, silent = false } = {}) {
  if (!existsSync(bridgeDir)) return [];
  await ensureStorage();
  const cutoff = Date.now() - olderThan;
  const removed = [];
  const tasks = await allTasks();
  const terminal = [];
  for (const task of tasks) {
    const status = await taskStatus(task.id);
    if (terminalStatuses.has(status)) terminal.push({ ...task, status });
  }
  terminal.sort(compareTaskCreatedDesc);
  const keepIds = new Set(terminal.slice(0, keep).map((task) => task.id));
  for (const task of terminal) {
    const created = Date.parse(task.createdAt || task.updatedAt || "");
    if (keepIds.has(task.id) && created >= cutoff) continue;
    const paths = taskPaths(task.id).filter((file) => existsSync(file));
    removed.push({ type: "task", id: task.id, paths: paths.map(displayPath) });
    if (!dryRun) {
      for (const file of paths) await rm(file, { force: true });
    }
  }
  if (existsSync(groupsDir)) {
    const files = (await readdir(groupsDir)).filter((file) => file.endsWith(".json"));
    for (const file of files) {
      const full = join(groupsDir, file);
      const group = JSON.parse(await readFile(full, "utf8"));
      const created = Date.parse(group.createdAt || "");
      const hasAnyTask = group.taskIds?.some((id) => existsSync(taskFile(id)));
      if (hasAnyTask && created >= cutoff) continue;
      removed.push({ type: "group", id: group.id || basename(file, ".json"), paths: [displayPath(full)] });
      if (!dryRun) await rm(full, { force: true });
    }
  }
  if (!silent && removed.length) {
    for (const item of removed) console.log(`${dryRun ? "would remove" : "removed"} ${item.type} ${item.id}`);
  }
  return removed;
}

async function allTasks() {
  if (!existsSync(tasksDir)) return [];
  const files = (await readdir(tasksDir)).filter((file) => file.endsWith(".json"));
  const tasks = [];
  for (const file of files) {
    try {
      tasks.push(JSON.parse(await readFile(join(tasksDir, file), "utf8")));
    } catch {
      // Ignore partial task records.
    }
  }
  tasks.sort(compareTaskCreatedAsc);
  return tasks;
}

async function latestTaskId() {
  const tasks = await allTasks();
  return tasks.length ? tasks.at(-1).id : "";
}

async function latestGroupId() {
  if (!existsSync(groupsDir)) return "";
  const files = (await readdir(groupsDir)).filter((file) => file.endsWith(".json"));
  const groups = [];
  for (const file of files) {
    try {
      const group = JSON.parse(await readFile(join(groupsDir, file), "utf8"));
      groups.push({ id: group.id || basename(file, ".json"), createdAt: group.createdAt || "" });
    } catch {
      groups.push({ id: basename(file, ".json"), createdAt: "" });
    }
  }
  groups.sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id)));
  return groups.length ? groups.at(-1).id : "";
}

function taskRecord(task) {
  return {
    id: task.id,
    record: displayPath(taskFile(task.id)),
    live: Boolean(task.live),
    profile: task.profile,
    waitCommand: `node ${displayPath(process.argv[1])} wait ${task.id}`,
    askCommand: task.live ? `node ${displayPath(process.argv[1])} ask ${task.id} <message>` : null,
    finishCommand: task.live ? `node ${displayPath(process.argv[1])} finish ${task.id}` : null
  };
}

function publicTask(task) {
  return {
    id: task.id,
    record: displayPath(taskFile(task.id)),
    live: Boolean(task.live),
    profile: task.profile || null,
    permissionMode: task.options?.permissionMode || null,
    tools: task.options?.tools || null,
    allowedTools: task.options?.allowedTools || null,
    persistSession: task.options?.persistSession === true,
    timeoutMs: Number.isInteger(task.timeoutMs) ? task.timeoutMs : null,
    startedAt: task.startedAt || null,
    createdAt: task.createdAt || null,
    finishedAt: task.finishedAt || null,
    sessionId: task.sessionId || null,
    totalCostUsd: task.totalCostUsd ?? null,
    error: task.error || null,
    prompt: task.prompt
  };
}

function taskFile(id) {
  return join(tasksDir, `${basename(id, ".json")}.json`);
}

function taskInboxFile(id) {
  return join(tasksDir, `${basename(id, ".inbox.jsonl")}.inbox.jsonl`);
}

function taskFinishFile(id) {
  return join(tasksDir, `${basename(id, ".finish")}.finish`);
}

function taskStopFile(id) {
  return join(tasksDir, `${basename(id, ".stop")}.stop`);
}

function taskLockFile(id) {
  return join(tasksDir, `${basename(id, ".lock")}.lock`);
}

function groupFile(id) {
  return join(groupsDir, `${basename(id, ".json")}.json`);
}

function taskPaths(id) {
  return [taskFile(id), taskInboxFile(id), taskFinishFile(id), taskStopFile(id), taskLockFile(id)];
}

function compareTaskCreatedAsc(left, right) {
  return String(left.createdAt || "").localeCompare(String(right.createdAt || "")) || String(left.id).localeCompare(String(right.id));
}

function compareTaskCreatedDesc(left, right) {
  return -compareTaskCreatedAsc(left, right);
}

function assistantText(message) {
  return (message.message?.content || [])
    .filter((part) => part?.type === "text" && part.text)
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n");
}

function systemEventText(message) {
  if (message.status) return `status=${message.status}`;
  if (message.state) return `state=${message.state}`;
  if (message.error) return String(message.error);
  return compactJson(message);
}

function resultEventText(message) {
  if (!message) return "No SDK result message";
  if (message.subtype === "success") return message.result || "success";
  return resultErrorText(message);
}

function resultErrorText(message) {
  if (!message) return "Claude Agent SDK returned no result message";
  if (Array.isArray(message.errors) && message.errors.length) return message.errors.join("\n");
  if (message.subtype) return `Claude Agent SDK result subtype: ${message.subtype}`;
  return "Claude Agent SDK task failed";
}

function parseEmbeddedJson(text) {
  if (!text) return null;
  const candidates = [
    text.trim(),
    ...Array.from(text.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu), (match) => match[1].trim())
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function parseBatchPrompts(source, flags) {
  const trimmed = source.trim();
  if (!trimmed) return [];
  if (flags.has("jsonl")) {
    return trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const value = JSON.parse(line);
        if (typeof value === "string") return value.trim();
        if (typeof value.prompt === "string") return value.prompt.trim();
        throw new Error("JSONL batch entries must be strings or objects with a prompt field.");
      })
      .filter(Boolean);
  }
  if (flags.has("separator")) {
    const separator = String(flags.get("separator"));
    return trimmed
      .split(new RegExp(`^${escapeRegExp(separator)}$`, "gmu"))
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function parseFlags(values) {
  const flags = new Map();
  const rest = [];
  const valueFlags = new Set(["file", "lines", "n", "concurrency", "older-than", "separator", "profile", "keep"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      rest.push(...values.slice(index + 1));
      break;
    }
    if (value.startsWith("--")) {
      const flag = value.slice(2);
      if (flag.includes("=")) {
        const [key, ...parts] = flag.split("=");
        flags.set(key, parts.join("="));
      } else if (valueFlags.has(flag) && values[index + 1] && !values[index + 1].startsWith("--")) {
        flags.set(flag, values[index + 1]);
        index += 1;
      } else {
        flags.set(flag, true);
      }
    } else {
      rest.push(value);
    }
  }
  return { flags, rest };
}

async function writeJsonAtomic(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tmp, content, "utf8");
  try {
    await rename(tmp, file);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeFile(tmp, content, "utf8");
      await rename(tmp, file);
      return;
    }
    if (error.code !== "EPERM" && error.code !== "EEXIST") throw error;
    await rm(file, { force: true });
    await rename(tmp, file);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))).toString("utf8");
}

async function runLimited(items, concurrency, worker) {
  const outcomes = Array.from({ length: items.length });
  let index = 0;
  async function runNext() {
    while (index < items.length) {
      const currentIndex = index;
      const current = items[index];
      index += 1;
      try {
        outcomes[currentIndex] = await worker(current);
      } catch (error) {
        outcomes[currentIndex] = { taskId: current, status: "failed", error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return outcomes;
}

function splitCsv(value) {
  if (!value) return null;
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function parseDurationMs(value) {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/iu);
  if (!match) throw new Error(`Invalid duration: ${value}. Use values like 12h, 7d, or 30m.`);
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || "d").toLowerCase();
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function parseOptionalNonNegativeFloat(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid ${label}: ${value}`);
  return parsed;
}

function retentionDaysValue() {
  return parsePositiveInt(process.env.CLAUDE_TASK_RETAIN_DAYS || "7", "CLAUDE_TASK_RETAIN_DAYS");
}

function retentionTasksValue() {
  return parseNonNegativeInt(process.env.CLAUDE_TASK_RETAIN_TASKS || "50", "CLAUDE_TASK_RETAIN_TASKS");
}

function eventLimitValue() {
  if (process.env.CLAUDE_TASK_PERSIST_EVENTS === "1") {
    return parsePositiveInt(process.env.CLAUDE_TASK_EVENT_LIMIT || "500", "CLAUDE_TASK_EVENT_LIMIT");
  }
  return parsePositiveInt(process.env.CLAUDE_TASK_EVENT_LIMIT || "80", "CLAUDE_TASK_EVENT_LIMIT");
}

function eventLimitForTask(task) {
  return Number.isInteger(task.eventLimit) && task.eventLimit > 0 ? task.eventLimit : eventLimitValue();
}

function eventTextLimitValue() {
  return parsePositiveInt(process.env.CLAUDE_TASK_EVENT_TEXT_LIMIT || "2000", "CLAUDE_TASK_EVENT_TEXT_LIMIT");
}

function resultLimitValue() {
  return parsePositiveInt(process.env.CLAUDE_TASK_RESULT_MAX_CHARS || "200000", "CLAUDE_TASK_RESULT_MAX_CHARS");
}

function pollMsValue() {
  return parsePositiveInt(process.env.CLAUDE_TASK_POLL_MS || "500", "CLAUDE_TASK_POLL_MS");
}

function limitResult(value) {
  return clip(value, resultLimitValue());
}

function clip(value, limit) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function compactJson(value) {
  return clip(JSON.stringify(value), eventTextLimitValue());
}

function boundaryPrompt() {
  return process.env.CLAUDE_TASK_BOUNDARIES || [
    "Boundaries:",
    "- You are an external helper for Codex.",
    "- Stay within the tools Codex allowed for this task.",
    "- Continue until you can provide a clear conclusion.",
    "- If you find issues, report them by severity with file paths and suggestions."
  ].join("\n");
}

function followUpPrompt(text) {
  return [
    "Follow-up guidance from Codex while you are working:",
    "",
    text,
    "",
    "Keep the original task boundaries. Adjust your analysis if this changes the task."
  ].join("\n");
}

function timestamp() {
  return `${new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z")}-${randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function displayPath(file) {
  return relative(rootDir, resolve(file)).replaceAll("\\", "/") || ".";
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function isAtLeastNode(minimum) {
  const currentParts = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  const minimumParts = minimum.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < minimumParts.length; index += 1) {
    const current = currentParts[index] || 0;
    const required = minimumParts[index] || 0;
    if (current > required) return true;
    if (current < required) return false;
  }
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function printHelp() {
  console.log([
    "Claude Code tracked task helper backed by the Claude Agent TypeScript SDK.",
    "",
    "Commands:",
    "  claude-task.mjs start [--profile safe|research|full] [--json] [--file prompt.md] [--stdin] <prompt>",
    "  claude-task.mjs start --live [--profile safe|research|full] [--json] [--file prompt.md] [--stdin] <prompt>",
    "  claude-task.mjs wait [--retry-stale] [--retry-failed] [task-id]",
    "  claude-task.mjs ask <task-id> <follow-up>",
    "  claude-task.mjs finish <task-id>",
    "  claude-task.mjs stop [task-id]",
    "  claude-task.mjs batch [--profile safe|research|full] [--json] [--file tasks.txt] [--stdin] [--separator=---] [--jsonl]",
    "  claude-task.mjs wait-group [--json] [--retry-failed] [--concurrency n] [group-id]",
    "  claude-task.mjs group-status [--json] [group-id]",
    "  claude-task.mjs group-result [--json] [group-id]",
    "  claude-task.mjs stop-group [--json] [group-id]",
    "  claude-task.mjs clean [--json] [--dry-run] [--older-than 7d] [--keep 50]",
    "  claude-task.mjs doctor",
    "  claude-task.mjs status [--json] [task-id]",
    "  claude-task.mjs list [--json]",
    "  claude-task.mjs tail [task-id] [lines]",
    "  claude-task.mjs result [--json] [task-id]"
  ].join("\n"));
}
