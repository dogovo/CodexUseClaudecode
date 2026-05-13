#!/usr/bin/env node
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const rootDir = resolve(process.cwd());
const logsDir = resolve(process.env.CLAUDE_BRIDGE_DIR || join(rootDir, ".codex", "claude-code"));
const command = process.argv[2] || "help";
const args = process.argv.slice(3);
const toolProfiles = {
  safe: {
    permissionMode: "acceptEdits",
    allowedTools: "Read,Grep,Glob,Bash(git diff),Bash(git status),Bash(git log),Bash(git show)"
  },
  research: {
    permissionMode: "acceptEdits",
    allowedTools: "Read,Grep,Glob,WebFetch,WebSearch,Bash(git diff),Bash(git status),Bash(git log),Bash(git show)"
  },
  full: {
    permissionMode: "acceptEdits",
    tools: "default"
  }
};

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

async function startTask(values) {
  const { flags, rest } = parseFlags(values);
  const promptFromFile = flags.has("file") ? await readFile(resolve(String(flags.get("file"))), "utf8") : "";
  const promptFromStdin = flags.has("stdin") ? await readStdin() : "";
  const prompt = [rest.join(" "), promptFromFile, promptFromStdin].filter(Boolean).join("\n\n").trim();
  if (!prompt) {
    throw new Error("Missing prompt. Example: claude-task.mjs start Review the current diff");
  }

  await createTask({
    prompt,
    live: flags.has("live") || flags.has("followups"),
    json: flags.has("json"),
    boundaries: flags.has("no-boundaries") ? "" : boundaryPrompt(),
    profile: flags.get("profile")
  });
}

async function createTask({ prompt, live, json = false, silent = false, groupId = null, boundaries = boundaryPrompt(), profile = null }) {
  await mkdir(logsDir, { recursive: true });

  const id = timestamp();
  const logFile = taskLogFile(id);
  const metaFile = taskMetaFile(id);
  const inboxFile = taskInboxFile(id);
  const finishFile = taskFinishFile(id);
  const fullPrompt = [
    "Please complete this read-only task.",
    "",
    prompt,
    boundaries ? `\n${boundaries}` : ""
  ].filter(Boolean).join("\n");
  const launch = claudeLaunch();
  const inputFormat = "stream-json";
  const launchOptions = claudeLaunchOptions({ inputFormat, profile });
  const claudeArgs = claudeArguments(launch, launchOptions);
  const createdAt = new Date().toISOString();
  const timeoutMs = parseNonNegativeInt(process.env.CLAUDE_TASK_TIMEOUT_MS || "0", "CLAUDE_TASK_TIMEOUT_MS");

  const header = [
    `# Claude Code task ${id}`,
    `cwd: ${rootDir}`,
    `startedAt: ${createdAt}`,
    `command: ${launch.file} ${claudeArgs.join(" ")} <prompt-from-stdin>`,
    "",
    "## Prompt",
    fullPrompt,
    "",
    "## Output",
    ""
  ].join("\n");

  await writeFile(logFile, header, "utf8");
  await writeJsonAtomic(metaFile, {
    id,
    cwd: rootDir,
    command: launch.file,
    args: claudeArgs,
    log: displayPath(logFile),
    status: "queued",
    live,
    inputFormat,
    profile: launchOptions.profile,
    permissionMode: launchOptions.permissionMode,
    allowedTools: launchOptions.allowedTools || null,
    tools: launchOptions.tools || null,
    sessionPersistence: launchOptions.sessionPersistence,
    maxBudgetUsd: launchOptions.maxBudgetUsd,
    timeoutMs,
    protocol: "claude-code-sdk-stream-json",
    groupId,
    inbox: live ? displayPath(inboxFile) : null,
    finishSignal: live ? displayPath(finishFile) : null,
    inboxOffset: 0,
    createdAt,
    startedAt: createdAt,
    prompt,
    fullPrompt
  });
  if (live) await writeFile(inboxFile, "", "utf8");

  const record = {
    id,
    log: displayPath(logFile),
    live,
    profile: launchOptions.profile,
    waitCommand: `node ${displayPath(process.argv[1])} wait ${id}`,
    askCommand: live ? `node ${displayPath(process.argv[1])} ask ${id} <message>` : null,
    finishCommand: live ? `node ${displayPath(process.argv[1])} finish ${id}` : null
  };

  if (silent) return record;

  if (json) {
    console.log(JSON.stringify({
      ...record
    }, null, 2));
  } else {
    console.log(`Started Claude Code task: ${id}`);
    console.log(`Log: ${displayPath(logFile)}`);
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

  const status = await taskStatus(id);
  const retryStale = flags.has("retry-stale");
  const retryFailed = flags.has("retry-failed");
  if (status !== "queued" && !(status === "stale" && retryStale) && !(status === "failed" && retryFailed)) {
    throw new Error(`Task is ${status}; wait can only run queued tasks${status === "stale" ? " unless --retry-stale is set" : ""}${status === "failed" ? " unless --retry-failed is set" : ""}. Start a new task if you need another Claude Code run.`);
  }

  const meta = await readTaskMeta(taskMetaFile(id));
  const logFile = taskLogFile(id);
  const launch = claudeLaunch();
  const claudeArgs = meta.args || claudeArguments(launch, claudeLaunchOptions({
    inputFormat: meta.inputFormat || "text",
    profile: meta.profile,
    permissionMode: meta.permissionMode,
    allowedTools: meta.allowedTools,
    tools: meta.tools,
    sessionPersistence: meta.sessionPersistence,
    maxBudgetUsd: meta.maxBudgetUsd
  }));
  const claudeStartedAt = new Date().toISOString();

  await updateTaskMeta(id, {
    status: "running",
    workerPid: process.pid,
    claudeStartedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    spawnError: null,
    timeoutError: null,
    stdinError: null,
    runError: null
  });
  if (status === "stale") {
    await append(logFile, `\n## Retry Stale\nat: ${claudeStartedAt}\npreviousWorkerPid: ${meta.workerPid || "none"}\npreviousClaudePid: ${meta.claudePid || "none"}\n`);
  }
  if (status === "failed") {
    await append(logFile, `\n## Retry Failed\nat: ${claudeStartedAt}\npreviousExitCode: ${Number.isInteger(meta.exitCode) ? meta.exitCode : "none"}\npreviousSignal: ${meta.signal || "none"}\npreviousError: ${meta.timeoutError || meta.stdinError || meta.spawnError || meta.runError || "none"}\n`);
  }
  await append(logFile, `\nworkerPid: ${process.pid}\nclaudeStartedAt: ${claudeStartedAt}\n`);

  const child = spawn(launch.file, claudeArgs, {
    cwd: meta.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const childResult = waitForChildExit(child, meta.timeoutMs || 0);
  const stdinErrors = [];
  child.stdin?.on("error", (error) => {
    stdinErrors.push(error.message);
  });
  await updateTaskMeta(id, { claudePid: child.pid || null });
  const initialInputSent = await writeChildStdin(child, `${JSON.stringify(userMessage(meta.fullPrompt))}\n`, logFile, "initial user message");
  if (initialInputSent) {
    await append(logFile, `\n## SDK Input\ninitial user message sent\n`);
  } else {
    await updateTaskMeta(id, { stdinError: "initial user message could not be written" });
    child.kill();
  }
  if (!meta.live) await endChildStdin(child, logFile, "initial user message");

  let writeQueue = Promise.resolve();
  const queueAppend = (chunk) => {
    writeQueue = writeQueue.then(() => append(logFile, chunk));
  };

  child.stdout.on("data", queueAppend);
  child.stderr.on("data", queueAppend);
  let inboxLoop = Promise.resolve();
  if (meta.live) {
    inboxLoop = forwardLiveInput(id, child, logFile);
  }

  const result = await childResult;

  await inboxLoop;
  await writeQueue;
  const finalMeta = await readTaskMeta(taskMetaFile(id));
  if (result.error) {
    await updateTaskMeta(id, {
      status: finalMeta.stopRequestedAt ? "canceled" : "failed",
      finishedAt: new Date().toISOString(),
      spawnError: result.error.message
    });
    await append(logFile, `\n\n## Spawn Error\n${result.error.stack || result.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (result.timeout) {
    const timeoutMeta = await readTaskMeta(taskMetaFile(id));
    const finishedAt = new Date().toISOString();
    await updateTaskMeta(id, {
      status: timeoutMeta.stopRequestedAt ? "canceled" : "failed",
      finishedAt,
      exitCode: null,
      signal: "timeout",
      timeoutMs: meta.timeoutMs || 0,
      timeoutError: `Claude Code task timed out after ${meta.timeoutMs}ms`
    });
    await append(logFile, `\n\n## Timeout\nms: ${meta.timeoutMs}\nfinishedAt: ${finishedAt}\n`);
    process.exitCode = 124;
    return;
  }

  const finishedAt = new Date().toISOString();
  const summary = await taskSummaryFromLog(logFile);
  const stdinError = stdinErrors.at(-1) || finalMeta.stdinError || null;
  const latestMeta = await readTaskMeta(taskMetaFile(id));
  const finalStatus = latestMeta.stopRequestedAt ? "canceled" : result.code === 0 && !stdinError ? "completed" : "failed";
  await updateTaskMeta(id, {
    status: finalStatus,
    finishedAt,
    exitCode: result.code,
    signal: result.signal,
    sessionId: summary.sessionId || null,
    resultSubtype: summary.resultSubtype || null,
    isError: summary.isError ?? null,
    stdinError
  });
  if (stdinError) await append(logFile, `\n\n## Stdin Error\n${stdinError}\n`);
  await append(logFile, `\n\n## Exit\ncode: ${result.code}\nsignal: ${result.signal}\nfinishedAt: ${finishedAt}\n`);
  if (finalStatus === "failed") process.exitCode = result.code || 1;
}

async function statusTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const metaFile = taskMetaFile(id);
  if (!existsSync(metaFile)) throw new Error(`Claude task metadata not found: ${metaFile}`);

  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  const status = await taskStatus(meta.id);
  if (flags.has("json")) {
    console.log(JSON.stringify({ ...publicTaskMeta(meta), status }, null, 2));
    return;
  }

  console.log(`id: ${meta.id}`);
  console.log(`status: ${status}`);
  console.log(`log: ${meta.log}`);
  console.log(`startedAt: ${meta.startedAt}`);
  if (meta.claudeStartedAt) console.log(`claudeStartedAt: ${meta.claudeStartedAt}`);
  if (meta.finishedAt) console.log(`finishedAt: ${meta.finishedAt}`);
  if (Number.isInteger(meta.exitCode)) console.log(`exitCode: ${meta.exitCode}`);
  if (meta.sessionId) console.log(`sessionId: ${meta.sessionId}`);
  if (meta.live) {
    console.log(`live: true`);
    console.log(`inbox: ${meta.inbox}`);
    console.log(`finishSignal: ${meta.finishSignal}`);
  }
  console.log(`prompt: ${meta.prompt}`);
}

async function askTask(values) {
  const id = values[0] || await latestTaskId();
  const message = values.slice(1).join(" ").trim();
  if (!id) throw new Error("Missing task id. Use list first.");
  if (!message) throw new Error("Missing follow-up message.");

  const meta = await readTaskMeta(taskMetaFile(id));
  if (!meta.live) {
    throw new Error("This task was not started with --live. Start live tasks with: claude-task.mjs start --live <prompt>");
  }

  const status = await taskStatus(id);
  if (status !== "queued" && status !== "running") {
    throw new Error(`Task is ${status}; follow-ups can only be queued for live tasks that are queued or running.`);
  }

  const event = {
    id: randomUUID(),
    at: new Date().toISOString(),
    text: message
  };
  await appendFile(taskInboxFile(id), `${JSON.stringify(event)}\n`, "utf8");
  await append(taskLogFile(id), `\n## Follow-up Queued\nat: ${event.at}\n${message}\n`);
  console.log(`Queued follow-up for Claude Code task: ${id}`);
}

async function finishTask(values) {
  const id = values[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const meta = await readTaskMeta(taskMetaFile(id));
  if (!meta.live) throw new Error("This task is not a live task.");
  const status = await taskStatus(id);
  if (status !== "queued" && status !== "running") {
    throw new Error(`Task is ${status}; finish can only close live tasks that are queued or running.`);
  }

  await writeFile(taskFinishFile(id), `${new Date().toISOString()}\n`, "utf8");
  await append(taskLogFile(id), "\n## Live Input\nfinish requested; stdin will close after queued follow-ups are sent\n");
  console.log(`Finish requested for Claude Code task: ${id}`);
}

async function stopTask(values) {
  const { rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const outcome = await stopOneTask(id);
  console.log(`Stop requested for Claude Code task: ${id}`);
  if (outcome.killedPids.length) console.log(`Killed PIDs: ${outcome.killedPids.join(", ")}`);
}

async function stopOneTask(id) {
  const meta = await readTaskMeta(taskMetaFile(id));
  const status = await taskStatus(id);
  if (status !== "queued" && status !== "running" && status !== "stale") {
    throw new Error(`Task is ${status}; stop only applies to queued, running, or stale tasks.`);
  }

  const stoppedAt = new Date().toISOString();
  await updateTaskMeta(id, {
    status: "canceled",
    stopRequestedAt: stoppedAt,
    finishedAt: status === "queued" || status === "stale" ? stoppedAt : meta.finishedAt || null
  });
  if (meta.live) await writeFile(taskFinishFile(id), `${stoppedAt}\n`, "utf8");

  const killed = [];
  for (const pid of [meta.claudePid, meta.workerPid]) {
    if (Number.isInteger(pid) && processExists(pid)) {
      try {
        await terminateProcessTree(pid);
        killed.push(pid);
      } catch {
        // Status is already canceled; failure to signal a stale process is not fatal.
      }
    }
  }

  await append(taskLogFile(id), `\n## Stop Requested\nat: ${stoppedAt}\nkilledPids: ${killed.join(", ") || "none"}\n`);
  return { taskId: id, status: "canceled", killedPids: killed };
}

async function doctorTask() {
  let ok = true;
  const nodeVersion = process.versions.node;
  console.log(`node: ${nodeVersion}`);
  if (!isAtLeastNode("20.11.0")) {
    ok = false;
    console.log("nodeStatus: failed (requires Node.js 20.11.0 or newer)");
  } else {
    console.log("nodeStatus: ok");
  }

  console.log(`bridgeDir: ${displayPath(logsDir)}`);
  const launch = claudeLaunch();
  const check = await runVersionCheck(launch);
  if (check.ok) {
    console.log(`claudeStatus: ok`);
    if (check.output) console.log(`claudeVersion: ${check.output}`);
  } else {
    ok = false;
    console.log(`claudeStatus: failed`);
    console.log(`claudeError: ${check.output || check.error}`);
  }

  if (!ok) process.exitCode = 1;
}

async function batchTask(values) {
  const { flags, rest } = parseFlags(values);
  const promptFromFile = flags.has("file") ? await readFile(resolve(String(flags.get("file"))), "utf8") : "";
  const promptFromStdin = flags.has("stdin") ? await readStdin() : "";
  const source = [rest.join(" "), promptFromFile, promptFromStdin].filter(Boolean).join("\n");
  const prompts = parseBatchPrompts(source, flags);
  if (!prompts.length) throw new Error("Missing batch prompts. Provide non-empty lines via --file, --stdin, or arguments.");

  await mkdir(logsDir, { recursive: true });
  const groupId = `group-${timestamp()}`;
  const tasks = [];
  for (const prompt of prompts) {
    tasks.push(await createTask({
      prompt,
      live: flags.has("live") || flags.has("followups"),
      silent: true,
      groupId,
      boundaries: flags.has("no-boundaries") ? "" : boundaryPrompt(),
      profile: flags.get("profile")
    }));
  }

  const group = {
    id: groupId,
    cwd: rootDir,
    createdAt: new Date().toISOString(),
    promptCount: prompts.length,
    taskIds: tasks.map((task) => task.id),
    tasks
  };
  await writeJsonAtomic(groupMetaFile(groupId), group);

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

  const group = await readGroupMeta(groupId);
  const concurrency = parsePositiveInt(flags.get("concurrency") || flags.get("n") || String(group.taskIds.length), "concurrency");
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
  }, async (taskId, error) => {
    await updateTaskMeta(taskId, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      runError: error.message
    });
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

  const group = await readGroupMeta(groupId);
  const tasks = [];
  for (const taskId of group.taskIds) {
    const meta = await readTaskMeta(taskMetaFile(taskId));
    tasks.push({ ...publicTaskMeta(meta), status: await taskStatus(taskId) });
  }

  if (flags.has("json")) {
    console.log(JSON.stringify({ ...group, tasks }, null, 2));
    return;
  }

  console.log(`group: ${group.id}`);
  for (const task of tasks) console.log(`${task.id} status=${task.status} log=${task.log}`);
}

async function groupResultTask(values) {
  const { flags, rest } = parseFlags(values);
  const groupId = rest[0] || await latestGroupId();
  if (!groupId) throw new Error("Missing group id.");

  const group = await readGroupMeta(groupId);
  const results = [];
  for (const taskId of group.taskIds) {
    const events = parseJsonEvents(await readFile(taskLogFile(taskId), "utf8"));
    const result = [...events].reverse().find((event) => event.type === "result");
    const messages = assistantTextMessages(events);
    const text = result?.result?.trim() || messages.at(-1) || null;
    results.push({
      id: taskId,
      status: await taskStatus(taskId),
      result: text,
      parsedJson: parseEmbeddedJson(text)
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

  const group = await readGroupMeta(groupId);
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
    for (const outcome of outcomes) {
      console.log(`${outcome.taskId} status=${outcome.status}${outcome.skipped ? " skipped=true" : ""}`);
      if (outcome.killedPids?.length) console.log(`  killedPids=${outcome.killedPids.join(", ")}`);
    }
  }
}

async function cleanTask(values) {
  const { flags } = parseFlags(values);
  const olderThan = parseDurationMs(String(flags.get("older-than") || "7d"));
  const cutoff = Date.now() - olderThan;
  const dryRun = flags.has("dry-run");
  const json = flags.has("json");
  if (!existsSync(logsDir)) {
    console.log(json ? JSON.stringify({ removed: [], dryRun }, null, 2) : "No Claude Code tasks.");
    return;
  }

  const removed = [];
  const files = await readdir(logsDir);
  for (const file of files.filter((name) => name.endsWith(".tmp"))) {
    const fullPath = join(logsDir, file);
    const info = await stat(fullPath).catch(() => null);
    if (!info || info.mtimeMs >= cutoff) continue;
    removed.push({ type: "tmp", id: file, paths: [displayPath(fullPath)] });
    if (!dryRun) await rm(fullPath, { force: true });
  }

  const taskIds = new Set(files
    .filter((file) => file.endsWith(".json") && !file.endsWith(".group.json"))
    .map((file) => basename(file, ".json")));
  const groupIds = new Set(files
    .filter((file) => file.endsWith(".group.json"))
    .map((file) => basename(file, ".group.json")));

  for (const id of taskIds) {
    const meta = await readTaskMeta(taskMetaFile(id));
    if (Date.parse(meta.createdAt || meta.startedAt || "") >= cutoff) continue;
    const paths = [taskMetaFile(id), taskLogFile(id), taskInboxFile(id), taskFinishFile(id)];
    removed.push({ type: "task", id, paths: paths.filter((file) => existsSync(file)).map(displayPath) });
    if (!dryRun) {
      for (const file of paths) await rm(file, { force: true });
    }
  }

  for (const id of groupIds) {
    const group = await readGroupMeta(id);
    if (Date.parse(group.createdAt || "") >= cutoff) continue;
    const file = groupMetaFile(id);
    removed.push({ type: "group", id, paths: [displayPath(file)] });
    if (!dryRun) await rm(file, { force: true });
  }

  if (json) {
    console.log(JSON.stringify({ dryRun, olderThan: String(flags.get("older-than") || "7d"), removed }, null, 2));
    return;
  }

  if (!removed.length) {
    console.log("No old Claude Code tasks to clean.");
    return;
  }
  for (const item of removed) console.log(`${dryRun ? "would remove" : "removed"} ${item.type} ${item.id}`);
}

async function listTasks(values = []) {
  const { flags } = parseFlags(values);
  if (!existsSync(logsDir)) {
    console.log(flags.has("json") ? "[]" : "No Claude Code tasks.");
    return;
  }

  const files = (await readdir(logsDir)).filter((file) => file.endsWith(".json") && !file.endsWith(".group.json")).sort();
  if (!files.length) {
    console.log(flags.has("json") ? "[]" : "No Claude Code tasks.");
    return;
  }

  const tasks = [];
  for (const file of files) {
    const meta = JSON.parse(await readFile(join(logsDir, file), "utf8"));
    const status = await taskStatus(meta.id);
    if (flags.has("json")) {
      tasks.push({ ...publicTaskMeta(meta), status });
    } else {
      console.log(`${meta.id} status=${status} log=${meta.log}`);
    }
  }

  if (flags.has("json")) console.log(JSON.stringify(tasks, null, 2));
}

async function tailTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  const lines = parsePositiveInt(flags.get("lines") || flags.get("n") || rest[1] || "120", "line count");

  const file = taskLogFile(id);
  if (!existsSync(file)) throw new Error(`Claude log not found: ${file}`);

  const content = await readFile(file, "utf8");
  console.log(content.split(/\r?\n/u).slice(-lines).join("\n"));
}

async function resultTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const file = taskLogFile(id);
  if (!existsSync(file)) throw new Error(`Claude log not found: ${file}`);

  const events = parseJsonEvents(await readFile(file, "utf8"));
  const result = [...events].reverse().find((event) => event.type === "result");
  const messages = assistantTextMessages(events);
  const text = result?.result?.trim() || messages.at(-1) || null;
  if (flags.has("json")) {
    console.log(JSON.stringify({
      id,
      status: await taskStatus(id),
      sessionId: result?.session_id || events.find((event) => event.type === "system" && event.subtype === "init")?.session_id || null,
      subtype: result?.subtype || null,
      isError: typeof result?.is_error === "boolean" ? result.is_error : null,
      result: text,
      parsedJson: parseEmbeddedJson(text),
      assistantMessages: messages
    }, null, 2));
    return;
  }

  if (result?.result) {
    console.log(result.result.trim());
    return;
  }

  if (messages.length) {
    console.log(messages.at(-1).trim());
    return;
  }

  console.log("Claude task has no final text result yet. Use tail for raw logs.");
}

async function append(file, chunk) {
  await appendFile(file, chunk);
}

async function latestTaskId() {
  if (!existsSync(logsDir)) return "";
  const files = (await readdir(logsDir)).filter((file) => file.endsWith(".json") && !file.endsWith(".group.json"));
  const tasks = await Promise.all(files.map(async (file) => {
    try {
      const meta = JSON.parse(await readFile(join(logsDir, file), "utf8"));
      return { id: meta.id || basename(file, ".json"), createdAt: meta.createdAt || meta.startedAt || "" };
    } catch {
      return { id: basename(file, ".json"), createdAt: "" };
    }
  }));
  tasks.sort(compareCreated);
  return tasks.length ? tasks.at(-1).id : "";
}

async function latestGroupId() {
  if (!existsSync(logsDir)) return "";
  const files = (await readdir(logsDir)).filter((file) => file.endsWith(".group.json"));
  const groups = await Promise.all(files.map(async (file) => {
    try {
      const meta = JSON.parse(await readFile(join(logsDir, file), "utf8"));
      return { id: meta.id || basename(file, ".group.json"), createdAt: meta.createdAt || "" };
    } catch {
      return { id: basename(file, ".group.json"), createdAt: "" };
    }
  }));
  groups.sort(compareCreated);
  return groups.length ? groups.at(-1).id : "";
}

function compareCreated(left, right) {
  return String(left.createdAt).localeCompare(String(right.createdAt)) || String(left.id).localeCompare(String(right.id));
}

async function readTaskMeta(file) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError;
}

async function readGroupMeta(id) {
  return JSON.parse(await readFile(groupMetaFile(id), "utf8"));
}

async function taskStatus(id) {
  const logFile = taskLogFile(id);
  if (!existsSync(logFile)) return "missing";
  const metaFile = taskMetaFile(id);
  const meta = existsSync(metaFile) ? JSON.parse(await readFile(metaFile, "utf8")) : {};

  if (meta.status === "queued") return "queued";
  if (meta.status === "completed" || meta.status === "failed" || meta.status === "canceled") return meta.status;
  if (Number.isInteger(meta.exitCode)) return meta.exitCode === 0 ? "completed" : "failed";
  if (meta.spawnError) return "failed";

  if (meta.status === "running" || meta.claudeStartedAt) {
    const pid = Number.isInteger(meta.claudePid) ? meta.claudePid : meta.workerPid;
    if (!pid) return "running";
    return processExists(pid) ? "running" : "stale";
  }

  const log = await readFile(logFile, "utf8");
  if (/## Spawn Error/u.test(log)) return "failed";
  const exitCode = log.match(/\n## Exit\ncode: ([^\n]+)/u)?.[1]?.trim();
  if (exitCode && exitCode !== "0") return "failed";
  if (/\n## Exit\n/u.test(log)) return "completed";
  if (meta.claudeStartedAt || /claudeStartedAt:/u.test(log)) {
    const pid = Number.isInteger(meta.claudePid) ? meta.claudePid : meta.workerPid;
    if (!pid) return "running";
    return processExists(pid) ? "running" : "stale";
  }
  return "queued";
}

async function updateTaskMeta(id, values) {
  const file = taskMetaFile(id);
  const meta = await readTaskMeta(file);
  await writeJsonAtomic(file, { ...meta, ...values });
}

async function taskSummaryFromLog(logFile) {
  const events = parseJsonEvents(await readFile(logFile, "utf8"));
  const result = [...events].reverse().find((event) => event.type === "result");
  const init = events.find((event) => event.type === "system" && event.subtype === "init");
  return {
    sessionId: result?.session_id || init?.session_id || "",
    resultSubtype: result?.subtype || "",
    isError: typeof result?.is_error === "boolean" ? result.is_error : null
  };
}

async function forwardLiveInput(id, child, logFile) {
  let offset = 0;
  while (!child.killed && child.exitCode === null) {
    offset = await sendQueuedFollowUps(id, child, logFile, offset);
    if (existsSync(taskFinishFile(id))) {
      offset = await sendQueuedFollowUps(id, child, logFile, offset);
      await endChildStdin(child, logFile, "live finish");
      await updateTaskMeta(id, { liveInputClosedAt: new Date().toISOString(), inboxOffset: offset });
      return;
    }
    await updateTaskMeta(id, { inboxOffset: offset });
    await delay(Number.parseInt(process.env.CLAUDE_TASK_POLL_MS || "500", 10));
  }
}

async function sendQueuedFollowUps(id, child, logFile, offset) {
  const inboxFile = taskInboxFile(id);
  if (!existsSync(inboxFile)) return offset;

  const content = await readFile(inboxFile, "utf8");
  const next = content.slice(offset);
  if (!next.trim()) return content.length;

  for (const line of next.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const event = JSON.parse(line);
    const sent = await writeChildStdin(child, `${JSON.stringify(userMessage(followUpPrompt(event.text)))}\n`, logFile, "live follow-up");
    if (sent) {
      await append(logFile, `\n## Follow-up Sent\nat: ${new Date().toISOString()}\nid: ${event.id}\n${event.text}\n`);
    }
  }

  return content.length;
}

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    child.on("error", (error) => finish({ error }));
    child.on("exit", (code, signal) => finish({ code, signal }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // The child may already have exited between timer scheduling and firing.
        }
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        terminateProcessTreeDetached(child.pid);
        finish({ timeout: true });
      }, timeoutMs);
    }
  });
}

function terminateProcessTreeDetached(pid) {
  if (!Number.isInteger(pid)) return;
  if (process.platform !== "win32") {
    try {
      process.kill(pid);
    } catch {
      // The process may already have exited.
    }
    return;
  }

  try {
    const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
      stdio: "ignore",
      detached: true,
      windowsHide: true
    });
    killer.unref();
  } catch {
    // Timeout status has already been recorded; cleanup is best-effort here.
  }
}

async function terminateProcessTree(pid) {
  if (!Number.isInteger(pid)) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill.exe", ["/pid", String(pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("error", resolve);
      killer.on("exit", resolve);
    });
    return;
  }

  // POSIX fallback signals the recorded process. Claude Code normally exits its
  // children, but this is not a full process-group kill without shell control.
  try {
    process.kill(pid);
  } catch {
    // The process may already have exited.
  }
}

async function writeChildStdin(child, payload, logFile, label) {
  if (child.exitCode !== null || child.signalCode !== null) {
    await append(logFile, `\n## Stdin Error\n${label}: child already exited\n`);
    return false;
  }

  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) {
    await append(logFile, `\n## Stdin Error\n${label}: stdin is not writable\n`);
    return false;
  }

  try {
    child.stdin.write(payload, "utf8");
    return true;
  } catch (error) {
    await append(logFile, `\n## Stdin Error\n${label}: ${error.message}\n`);
    return false;
  }
}

async function endChildStdin(child, logFile, label) {
  if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
  try {
    child.stdin.end();
  } catch (error) {
    await append(logFile, `\n## Stdin Error\n${label} end: ${error.message}\n`);
  }
}

function parseJsonEvents(content) {
  const events = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore non-JSON log lines.
    }
  }

  return events;
}

function assistantTextMessages(events) {
  return events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text?.trim())
    .filter(Boolean);
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

function publicTaskMeta(meta) {
  return {
    id: meta.id,
    log: meta.log,
    live: Boolean(meta.live),
    protocol: meta.protocol || null,
    profile: meta.profile || null,
    permissionMode: meta.permissionMode || null,
    allowedTools: meta.allowedTools || null,
    tools: meta.tools || null,
    timeoutMs: Number.isInteger(meta.timeoutMs) ? meta.timeoutMs : null,
    startedAt: meta.startedAt,
    claudeStartedAt: meta.claudeStartedAt || null,
    finishedAt: meta.finishedAt || null,
    exitCode: Number.isInteger(meta.exitCode) ? meta.exitCode : null,
    sessionId: meta.sessionId || null,
    spawnError: meta.spawnError || null,
    stdinError: meta.stdinError || null,
    timeoutError: meta.timeoutError || null,
    runError: meta.runError || null,
    prompt: meta.prompt
  };
}

function claudeLaunch() {
  if (process.env.CLAUDE_TASK_BIN) return { file: process.env.CLAUDE_TASK_BIN, prefixArgs: [] };
  if (process.platform === "win32") return { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "claude.cmd"] };
  return { file: "claude", prefixArgs: [] };
}

function claudeLaunchOptions(options = {}) {
  const profileName = String(options.profile || process.env.CLAUDE_TASK_PROFILE || "safe");
  const profile = toolProfiles[profileName];
  if (!profile) {
    throw new Error(`Unknown Claude task profile: ${profileName}. Use safe, research, or full.`);
  }
  return {
    inputFormat: options.inputFormat || "text",
    profile: profileName,
    permissionMode: options.permissionMode || process.env.CLAUDE_TASK_PERMISSION_MODE || profile.permissionMode,
    allowedTools: options.allowedTools ?? process.env.CLAUDE_TASK_ALLOWED_TOOLS ?? profile.allowedTools ?? "",
    tools: options.tools ?? process.env.CLAUDE_TASK_TOOLS ?? profile.tools ?? "",
    sessionPersistence: options.sessionPersistence ?? process.env.CLAUDE_TASK_SESSION_PERSISTENCE === "1",
    maxBudgetUsd: options.maxBudgetUsd || process.env.CLAUDE_TASK_MAX_BUDGET_USD || "5.00"
  };
}

function claudeArguments(launch, options = {}) {
  const args = [
    ...launch.prefixArgs,
    "-p",
    "--input-format",
    options.inputFormat || "text",
    "--permission-mode",
    options.permissionMode || "acceptEdits",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    options.maxBudgetUsd || "5.00"
  ];

  if (options.tools?.trim()) {
    args.push("--tools", options.tools);
  }

  if (options.allowedTools?.trim()) {
    args.push("--allowed-tools", options.allowedTools);
  }

  if (process.env.CLAUDE_TASK_MAX_TURNS) {
    args.push("--max-turns", process.env.CLAUDE_TASK_MAX_TURNS);
  }

  if (process.env.CLAUDE_TASK_MODEL) {
    args.push("--model", process.env.CLAUDE_TASK_MODEL);
  }

  if (!options.sessionPersistence) {
    args.push("--no-session-persistence");
  }

  return args;
}

async function runVersionCheck(launch) {
  const child = spawn(launch.file, [...launch.prefixArgs, "--version"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timeout = delay(10_000).then(() => {
    child.kill();
    return { timeout: true };
  });
  const exit = new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });
  const result = await Promise.race([exit, timeout]);
  const output = `${stdout}${stderr}`.trim().split(/\r?\n/u)[0] || "";

  if (result.timeout) return { ok: false, output, error: "Claude Code version check timed out." };
  if (result.error) return { ok: false, output, error: result.error.message };
  return { ok: result.code === 0, output, error: `exit code ${result.code}` };
}

function taskLogFile(id) {
  return join(logsDir, `${basename(id, ".log")}.log`);
}

function taskMetaFile(id) {
  return join(logsDir, `${basename(id, ".json")}.json`);
}

function groupMetaFile(id) {
  return join(logsDir, `${basename(id, ".group.json")}.group.json`);
}

function taskInboxFile(id) {
  return join(logsDir, `${basename(id, ".inbox.jsonl")}.inbox.jsonl`);
}

function taskFinishFile(id) {
  return join(logsDir, `${basename(id, ".finish")}.finish`);
}

function timestamp() {
  return `${new Date().toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z")}-${randomUUID()}`;
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

function userMessage(text) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }]
    }
  };
}

function followUpPrompt(text) {
  return [
    "Follow-up guidance from Codex while you are working:",
    "",
    text,
    "",
    "Keep the original read-only boundaries. Adjust your analysis if this changes the task."
  ].join("\n");
}

function parseFlags(values) {
  const flags = new Map();
  const rest = [];
  const valueFlags = new Set(["file", "lines", "n", "concurrency", "older-than", "separator", "profile"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
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

function boundaryPrompt() {
  return process.env.CLAUDE_TASK_BOUNDARIES || [
    "Boundaries:",
    "- You are an external helper for Codex.",
    "- Stay within the tools Codex allowed for this task.",
    "- Continue until you can provide a clear conclusion.",
    "- If you find issues, report them by severity with file paths and suggestions."
  ].join("\n");
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

function parseDurationMs(value) {
  const match = value.trim().match(/^(\d+)(ms|s|m|h|d)?$/iu);
  if (!match) throw new Error(`Invalid duration: ${value}. Use values like 12h, 7d, or 30m.`);
  const amount = Number.parseInt(match[1], 10);
  const unit = (match[2] || "d").toLowerCase();
  const multipliers = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return amount * multipliers[unit];
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function parsePositiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function parseNonNegativeInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

async function runLimited(items, concurrency, worker, onError = async () => {}) {
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
        await onError(current, error);
        outcomes[currentIndex] = { taskId: current, status: "failed", error: error.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runNext));
  return outcomes;
}

function printHelp() {
  console.log([
    "Claude Code tracked task helper.",
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
    "  claude-task.mjs clean [--json] [--dry-run] [--older-than 7d]",
    "  claude-task.mjs doctor",
    "  claude-task.mjs status [--json] [task-id]",
    "  claude-task.mjs list [--json]",
    "  claude-task.mjs tail [task-id] [lines]",
    "  claude-task.mjs result [--json] [task-id]"
  ].join("\n"));
}
