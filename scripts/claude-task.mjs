#!/usr/bin/env node
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

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
} else if (command === "status") {
  await statusTask(args);
} else if (command === "list") {
  await listTasks();
} else if (command === "run") {
  await runTask(args);
} else {
  printHelp();
}

async function startTask(values) {
  const prompt = values.join(" ").trim();
  if (!prompt) {
    throw new Error("Missing prompt. Example: claude-task.mjs start Review the current diff");
  }

  await mkdir(logsDir, { recursive: true });

  const id = timestamp();
  const logFile = taskLogFile(id);
  const metaFile = taskMetaFile(id);
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
  const claudeArgs = claudeArguments(launch);

  const header = [
    `# Claude Code task ${id}`,
    `cwd: ${rootDir}`,
    `startedAt: ${new Date().toISOString()}`,
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
    startedAt: new Date().toISOString(),
    prompt,
    fullPrompt
  }, null, 2)}\n`, "utf8");

  console.log(`Started Claude Code task: ${id}`);
  console.log(`Log: ${displayPath(logFile)}`);
  console.log(`Run: node ${displayPath(process.argv[1])} wait ${id}`);
}

async function waitTask(values) {
  const id = values[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");
  await runTask([id]);
}

async function runTask(values) {
  const id = values[0];
  if (!id) throw new Error("Missing task id.");

  const meta = await readTaskMeta(taskMetaFile(id));
  const logFile = taskLogFile(id);
  const launch = claudeLaunch();
  const claudeArgs = claudeArguments(launch);

  await append(logFile, `\nworkerPid: ${process.pid}\nclaudeStartedAt: ${new Date().toISOString()}\n`);

  const child = spawn(launch.file, claudeArgs, {
    cwd: meta.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  child.stdin?.end(meta.fullPrompt);

  let writeQueue = Promise.resolve();
  const queueAppend = (chunk) => {
    writeQueue = writeQueue.then(() => append(logFile, chunk));
  };

  child.stdout.on("data", queueAppend);
  child.stderr.on("data", queueAppend);

  const result = await new Promise((resolve) => {
    child.on("error", (error) => resolve({ error }));
    child.on("exit", (code, signal) => resolve({ code, signal }));
  });

  await writeQueue;
  if (result.error) {
    await append(logFile, `\n\n## Spawn Error\n${result.error.stack || result.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  await append(logFile, `\n\n## Exit\ncode: ${result.code}\nsignal: ${result.signal}\nfinishedAt: ${new Date().toISOString()}\n`);
}

async function statusTask(values) {
  const id = values[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const metaFile = taskMetaFile(id);
  if (!existsSync(metaFile)) throw new Error(`Claude task metadata not found: ${metaFile}`);

  const meta = JSON.parse(await readFile(metaFile, "utf8"));
  console.log(`id: ${meta.id}`);
  console.log(`status: ${await taskStatus(meta.id)}`);
  console.log(`log: ${meta.log}`);
  console.log(`startedAt: ${meta.startedAt}`);
  console.log(`prompt: ${meta.prompt}`);
}

async function listTasks() {
  if (!existsSync(logsDir)) {
    console.log("No Claude Code tasks.");
    return;
  }

  const files = (await readdir(logsDir)).filter((file) => file.endsWith(".json")).sort();
  if (!files.length) {
    console.log("No Claude Code tasks.");
    return;
  }

  for (const file of files) {
    const meta = JSON.parse(await readFile(join(logsDir, file), "utf8"));
    console.log(`${meta.id} status=${await taskStatus(meta.id)} log=${meta.log}`);
  }
}

async function tailTask(values) {
  const id = values[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const file = taskLogFile(id);
  if (!existsSync(file)) throw new Error(`Claude log not found: ${file}`);

  const content = await readFile(file, "utf8");
  console.log(content.split(/\r?\n/u).slice(-120).join("\n"));
}

async function resultTask(values) {
  const id = values[0] || await latestTaskId();
  if (!id) throw new Error("Missing task id. Use list first.");

  const file = taskLogFile(id);
  if (!existsSync(file)) throw new Error(`Claude log not found: ${file}`);

  const events = parseJsonEvents(await readFile(file, "utf8"));
  const result = [...events].reverse().find((event) => event.type === "result");
  if (result?.result) {
    console.log(result.result.trim());
    return;
  }

  const messages = events
    .filter((event) => event.type === "assistant")
    .flatMap((event) => event.message?.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .filter(Boolean);

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
  const files = (await readdir(logsDir)).filter((file) => file.endsWith(".json")).sort();
  return files.length ? basename(files.at(-1), ".json") : "";
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

async function taskStatus(id) {
  const logFile = taskLogFile(id);
  if (!existsSync(logFile)) return "missing";

  const log = await readFile(logFile, "utf8");
  if (/## Spawn Error/u.test(log)) return "failed";
  const exitCode = log.match(/\n## Exit\ncode: ([^\n]+)/u)?.[1]?.trim();
  if (exitCode && exitCode !== "0") return "failed";
  if (/\n## Exit\n/u.test(log)) return "completed";
  if (/claudeStartedAt:/u.test(log)) return "running";
  return "queued";
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

function claudeLaunch() {
  if (process.env.CLAUDE_TASK_BIN) return { file: process.env.CLAUDE_TASK_BIN, prefixArgs: [] };
  if (process.platform === "win32") return { file: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "claude.cmd"] };
  return { file: "claude", prefixArgs: [] };
}

function claudeArguments(launch) {
  return [
    ...launch.prefixArgs,
    "-p",
    "--input-format",
    "text",
    "--permission-mode",
    "plan",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-budget-usd",
    process.env.CLAUDE_TASK_MAX_BUDGET_USD || "20.00"
  ];
}

function taskLogFile(id) {
  return join(logsDir, `${basename(id, ".log")}.log`);
}

function taskMetaFile(id) {
  return join(logsDir, `${basename(id, ".json")}.json`);
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z");
}

function displayPath(file) {
  return relative(rootDir, resolve(file)).replaceAll("\\", "/") || ".";
}

function printHelp() {
  console.log([
    "Claude Code tracked task helper.",
    "",
    "Commands:",
    "  claude-task.mjs start <prompt>",
    "  claude-task.mjs wait [task-id]",
    "  claude-task.mjs status [task-id]",
    "  claude-task.mjs list",
    "  claude-task.mjs tail [task-id]",
    "  claude-task.mjs result [task-id]"
  ].join("\n"));
}
