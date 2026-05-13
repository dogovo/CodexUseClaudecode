#!/usr/bin/env node
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";

const rootDir = resolve(process.cwd());
const logsDir = resolve(process.env.CLAUDE_BRIDGE_DIR || join(rootDir, ".codex", "claude-code"));
const command = process.argv[2] || "help";
const args = process.argv.slice(3);

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

  await createTask({ prompt, live: flags.has("live") || flags.has("followups"), json: flags.has("json") });
}

async function createTask({ prompt, live, json = false, silent = false, groupId = null }) {
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
    "",
    "Boundaries:",
    "- You are an external read-only review helper for Codex.",
    "- Do not modify files.",
    "- Continue until you can provide a clear conclusion.",
    "- If you find issues, report them by severity with file paths and suggestions."
  ].join("\n");
  const launch = claudeLaunch();
  const inputFormat = "stream-json";
  const claudeArgs = claudeArguments(launch, { inputFormat });
  const createdAt = new Date().toISOString();

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
  await writeFile(metaFile, `${JSON.stringify({
    id,
    cwd: rootDir,
    command: launch.file,
    args: claudeArgs,
    log: displayPath(logFile),
    status: "queued",
    live,
    inputFormat,
    protocol: "claude-code-sdk-stream-json",
    groupId,
    inbox: live ? displayPath(inboxFile) : null,
    finishSignal: live ? displayPath(finishFile) : null,
    inboxOffset: 0,
    createdAt,
    startedAt: createdAt,
    prompt,
    fullPrompt
  }, null, 2)}\n`, "utf8");
  if (live) await writeFile(inboxFile, "", "utf8");

  const record = {
    id,
    log: displayPath(logFile),
    live,
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
  await runTask([...(flags.has("retry-stale") ? ["--retry-stale"] : []), id]);
}

async function runTask(values) {
  const { flags, rest } = parseFlags(values);
  const id = rest[0];
  if (!id) throw new Error("Missing task id.");

  const status = await taskStatus(id);
  const retryStale = flags.has("retry-stale");
  if (status !== "queued" && !(status === "stale" && retryStale)) {
    throw new Error(`Task is ${status}; wait can only run queued tasks${status === "stale" ? " unless --retry-stale is set" : ""}. Start a new task if you need another Claude Code run.`);
  }

  const meta = await readTaskMeta(taskMetaFile(id));
  const logFile = taskLogFile(id);
  const launch = claudeLaunch();
  const claudeArgs = claudeArguments(launch, { inputFormat: meta.inputFormat || "text" });
  const claudeStartedAt = new Date().toISOString();

  await updateTaskMeta(id, {
    status: "running",
    workerPid: process.pid,
    claudeStartedAt,
    finishedAt: null,
    exitCode: null,
    signal: null,
    spawnError: null
  });
  if (status === "stale") {
    await append(logFile, `\n## Retry Stale\nat: ${claudeStartedAt}\npreviousWorkerPid: ${meta.workerPid || "none"}\npreviousClaudePid: ${meta.claudePid || "none"}\n`);
  }
  await append(logFile, `\nworkerPid: ${process.pid}\nclaudeStartedAt: ${claudeStartedAt}\n`);

  const child = spawn(launch.file, claudeArgs, {
    cwd: meta.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  await updateTaskMeta(id, { claudePid: child.pid || null });
  child.stdin?.write(`${JSON.stringify(userMessage(meta.fullPrompt))}\n`);
  await append(logFile, `\n## SDK Input\ninitial user message sent\n`);
  if (!meta.live) child.stdin?.end();

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

  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

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

  const finishedAt = new Date().toISOString();
  const summary = await taskSummaryFromLog(logFile);
  const finalStatus = finalMeta.stopRequestedAt ? "canceled" : result.code === 0 ? "completed" : "failed";
  await updateTaskMeta(id, {
    status: finalStatus,
    finishedAt,
    exitCode: result.code,
    signal: result.signal,
    sessionId: summary.sessionId || null,
    resultSubtype: summary.resultSubtype || null,
    isError: summary.isError ?? null
  });
  await append(logFile, `\n\n## Exit\ncode: ${result.code}\nsignal: ${result.signal}\nfinishedAt: ${finishedAt}\n`);
  if (result.code !== 0) process.exitCode = result.code ?? 1;
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
        process.kill(pid);
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
  const prompts = source
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (!prompts.length) throw new Error("Missing batch prompts. Provide non-empty lines via --file, --stdin, or arguments.");

  await mkdir(logsDir, { recursive: true });
  const groupId = `group-${timestamp()}`;
  const tasks = [];
  for (const prompt of prompts) {
    tasks.push(await createTask({
      prompt,
      live: flags.has("live") || flags.has("followups"),
      silent: true,
      groupId
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
  await writeFile(groupMetaFile(groupId), `${JSON.stringify(group, null, 2)}\n`, "utf8");

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
  const outcomes = await runLimited(group.taskIds, concurrency, async (taskId) => {
    const status = await taskStatus(taskId);
    if (status !== "queued" && status !== "stale") return { taskId, skipped: true, status };
    await runTask([...(status === "stale" ? ["--retry-stale"] : []), taskId]);
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
    results.push({
      id: taskId,
      status: await taskStatus(taskId),
      result: result?.result?.trim() || messages.at(-1) || null
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
  if (flags.has("json")) {
    console.log(JSON.stringify({
      id,
      status: await taskStatus(id),
      sessionId: result?.session_id || events.find((event) => event.type === "system" && event.subtype === "init")?.session_id || null,
      subtype: result?.subtype || null,
      isError: typeof result?.is_error === "boolean" ? result.is_error : null,
      result: result?.result?.trim() || messages.at(-1) || null,
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
  await writeFile(file, `${JSON.stringify({ ...meta, ...values }, null, 2)}\n`, "utf8");
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
      child.stdin?.end();
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
    child.stdin?.write(`${JSON.stringify(userMessage(followUpPrompt(event.text)))}\n`);
    await append(logFile, `\n## Follow-up Sent\nat: ${new Date().toISOString()}\nid: ${event.id}\n${event.text}\n`);
  }

  return content.length;
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

function publicTaskMeta(meta) {
  return {
    id: meta.id,
    log: meta.log,
    live: Boolean(meta.live),
    protocol: meta.protocol || null,
    startedAt: meta.startedAt,
    claudeStartedAt: meta.claudeStartedAt || null,
    finishedAt: meta.finishedAt || null,
    exitCode: Number.isInteger(meta.exitCode) ? meta.exitCode : null,
    sessionId: meta.sessionId || null,
    prompt: meta.prompt
  };
}

function claudeLaunch() {
  if (process.env.CLAUDE_TASK_BIN) return { file: process.env.CLAUDE_TASK_BIN, prefixArgs: [] };
  if (process.platform === "win32") return { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "claude.cmd"] };
  return { file: "claude", prefixArgs: [] };
}

function claudeArguments(launch, options = {}) {
  const inputFormat = options.inputFormat || "text";
  const args = [
    ...launch.prefixArgs,
    "-p",
    "--input-format",
    inputFormat,
    "--permission-mode",
    "plan",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    process.env.CLAUDE_TASK_MAX_BUDGET_USD || "20.00"
  ];

  if (process.env.CLAUDE_TASK_MAX_TURNS) {
    args.push("--max-turns", process.env.CLAUDE_TASK_MAX_TURNS);
  }

  if (process.env.CLAUDE_TASK_MODEL) {
    args.push("--model", process.env.CLAUDE_TASK_MODEL);
  }

  if (process.env.CLAUDE_TASK_NO_SESSION_PERSISTENCE === "1") {
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
  const valueFlags = new Set(["file", "lines", "n", "concurrency"]);
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
    "  claude-task.mjs start [--json] [--file prompt.md] [--stdin] <prompt>",
    "  claude-task.mjs start --live [--json] [--file prompt.md] [--stdin] <prompt>",
    "  claude-task.mjs wait [--retry-stale] [task-id]",
    "  claude-task.mjs ask <task-id> <follow-up>",
    "  claude-task.mjs finish <task-id>",
    "  claude-task.mjs stop [task-id]",
    "  claude-task.mjs batch [--json] [--file tasks.txt] [--stdin]",
    "  claude-task.mjs wait-group [--json] [--concurrency n] [group-id]",
    "  claude-task.mjs group-status [--json] [group-id]",
    "  claude-task.mjs group-result [--json] [group-id]",
    "  claude-task.mjs stop-group [--json] [group-id]",
    "  claude-task.mjs doctor",
    "  claude-task.mjs status [--json] [task-id]",
    "  claude-task.mjs list [--json]",
    "  claude-task.mjs tail [task-id] [lines]",
    "  claude-task.mjs result [--json] [task-id]"
  ].join("\n"));
}
