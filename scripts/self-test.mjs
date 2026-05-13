#!/usr/bin/env node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "claude-task.mjs");
const tempDir = await mkdtemp(join(tmpdir(), "codex-use-claude-"));

try {
  const binDir = join(tempDir, "bin");
  const bridgeDir = join(tempDir, "jobs");
  const fakeClaude = join(binDir, "fake-claude.mjs");
  await mkdir(binDir, { recursive: true });
  await writeFile(fakeClaude, fakeClaudeSource(), "utf8");

  if (process.platform === "win32") {
    await writeFile(join(binDir, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${fakeClaude}" %*\r\n`, "utf8");
  } else {
    await writeFile(join(binDir, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fakeClaude}" "$@"\n`, { encoding: "utf8", mode: 0o755 });
  }

  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH || ""}`,
    CLAUDE_BRIDGE_DIR: bridgeDir,
    CLAUDE_TASK_POLL_MS: "50"
  };

  const doctor = await run(["doctor"], { env });
  assertIncludes(doctor, "nodeStatus: ok", "doctor should accept current Node version");
  assertIncludes(doctor, "claudeStatus: ok", "doctor should find fake Claude CLI");

  const promptFile = join(tempDir, "prompt.md");
  await writeFile(promptFile, "Review prompt file", "utf8");
  const jsonStart = JSON.parse(await run(["start", "--json", "--file", promptFile], { env }));
  await run(["wait", jsonStart.id], { env });
  const jsonResult = JSON.parse(await run(["result", "--json", jsonStart.id], { env }));
  assertIncludes(jsonResult.result, "Review prompt file", "result --json should include file prompt");
  const jsonStatus = JSON.parse(await run(["status", "--json", jsonStart.id], { env }));
  assertIncludes(jsonStatus.status, "completed", "status --json should report completion");
  const jsonList = JSON.parse(await run(["list", "--json"], { env }));
  if (!jsonList.some((task) => task.id === jsonStart.id)) {
    throw new Error("list --json should include JSON-created task");
  }
  const stdinStart = JSON.parse(await run(["start", "--json", "--stdin", "Review stdin"], { env, input: "stdin payload" }));
  await run(["wait", stdinStart.id], { env });
  const stdinResult = JSON.parse(await run(["result", "--json", stdinStart.id], { env }));
  assertIncludes(stdinResult.result, "stdin payload", "start --stdin should include piped prompt content");

  const latestFirst = JSON.parse(await run(["start", "--json", "Latest first"], { env }));
  const latestSecond = JSON.parse(await run(["start", "--json", "Latest second"], { env }));
  await rewriteTaskMeta(bridgeDir, latestFirst.id, { createdAt: "2099-01-01T00:00:00.000Z" });
  await rewriteTaskMeta(bridgeDir, latestSecond.id, { createdAt: "2000-01-01T00:00:00.000Z" });
  const latestStatus = JSON.parse(await run(["status", "--json"], { env }));
  if (latestStatus.id !== latestFirst.id) {
    throw new Error(`latest task should sort by metadata createdAt, not filename. Expected ${latestFirst.id}, got ${latestStatus.id}`);
  }
  await run(["stop", latestFirst.id], { env });
  await run(["stop", latestSecond.id], { env });

  const staleStart = JSON.parse(await run(["start", "--json", "Retry stale task"], { env }));
  await rewriteTaskMeta(bridgeDir, staleStart.id, {
    status: "running",
    claudeStartedAt: "2000-01-01T00:00:00.000Z",
    workerPid: 99999999,
    claudePid: 99999998
  });
  const staleStatus = JSON.parse(await run(["status", "--json", staleStart.id], { env }));
  assertIncludes(staleStatus.status, "stale", "dead recorded PIDs should make a running task stale");
  await run(["wait", "--retry-stale", staleStart.id], { env });
  const staleResult = JSON.parse(await run(["result", "--json", staleStart.id], { env }));
  assertIncludes(staleResult.result, "Retry stale task", "wait --retry-stale should rerun a stale task");

  const trickyStart = JSON.parse(await run(["start", "--json", "--stdin", "Review tricky log-looking prompt"], {
    env,
    input: "This prompt contains log text:\n## Exit\ncode: 1\nbut the task is still queued."
  }));
  const trickyStatus = JSON.parse(await run(["status", "--json", trickyStart.id], { env }));
  assertIncludes(trickyStatus.status, "queued", "prompt text that looks like an exit block should not affect status");
  await run(["stop", trickyStart.id], { env });

  const group = JSON.parse(await run(["batch", "--json", "--stdin"], { env, input: "Group task one\nGroup task two\n" }));
  if (group.tasks.length !== 2) throw new Error("batch should create two tasks");
  const groupStatusBefore = JSON.parse(await run(["group-status", "--json", group.id], { env }));
  if (!groupStatusBefore.tasks.every((task) => task.status === "queued")) {
    throw new Error("new batch tasks should start queued");
  }
  const cancelGroup = JSON.parse(await run(["batch", "--json", "--stdin"], { env, input: "Cancel group one\nCancel group two\n" }));
  const stopGroup = JSON.parse(await run(["stop-group", cancelGroup.id, "--json"], { env }));
  if (!stopGroup.outcomes.every((outcome) => outcome.status === "canceled")) {
    throw new Error(`stop-group --json should return clean JSON and cancel queued tasks:\n${JSON.stringify(stopGroup, null, 2)}`);
  }
  await rewriteTaskMeta(bridgeDir, group.taskIds[0], {
    status: "running",
    claudeStartedAt: "2000-01-01T00:00:00.000Z",
    workerPid: 99999997,
    claudePid: 99999996
  });
  const groupWait = JSON.parse(await run(["wait-group", "--json", "--concurrency", "2", group.id], { env }));
  if (!groupWait.outcomes.every((outcome) => outcome.status === "completed")) {
    throw new Error(`wait-group should complete every task:\n${JSON.stringify(groupWait, null, 2)}`);
  }
  const groupResult = JSON.parse(await run(["group-result", "--json", group.id], { env }));
  if (!groupResult.results.every((item) => item.result?.includes("Group task"))) {
    throw new Error("group-result should include each task result");
  }

  const normalId = parseTaskId(await run(["start", "Review diff"], { env }));
  await run(["wait", normalId], { env });
  const normalResult = await run(["result", normalId], { env });
  assertIncludes(normalResult, "Review diff", "normal result should include the prompt");
  const normalStatus = await run(["status", normalId], { env });
  assertIncludes(normalStatus, "sessionId: 00000000-0000-4000-8000-000000000000", "normal status should record session id");
  await expectFailure(["wait", normalId], { env }, "wait can only run queued tasks");

  const liveId = parseTaskId(await run(["start", "--live", "Initial review"], { env }));
  const waiter = run(["wait", liveId], { env, background: true });
  await delay(250);
  await run(["ask", liveId, "Also inspect tests"], { env });
  await delay(250);
  await run(["finish", liveId], { env });
  await waiter;
  const liveResult = await run(["result", liveId], { env });
  assertIncludes(liveResult, "Initial review", "live result should include initial prompt");
  assertIncludes(liveResult, "Also inspect tests", "live result should include follow-up");
  await expectFailure(["ask", liveId, "Too late"], { env }, "follow-ups can only be queued");

  const liveLog = await readFile(join(bridgeDir, `${liveId}.log`), "utf8");
  assertIncludes(liveLog, "## Follow-up Sent", "live log should record sent follow-up");
  const shortTail = await run(["tail", liveId, "5"], { env });
  assertIncludes(shortTail, "## Exit", "tail with line count should include recent exit block");
  const flaggedTail = await run(["tail", liveId, "--lines", "5"], { env });
  assertIncludes(flaggedTail, "## Exit", "tail should parse flags after the task id");

  const queuedId = parseTaskId(await run(["start", "--live", "Never run this task"], { env }));
  await run(["stop", queuedId], { env });
  const stoppedStatus = await run(["status", queuedId], { env });
  assertIncludes(stoppedStatus, "status: canceled", "stop should cancel queued tasks");
  await expectFailure(["wait", queuedId], { env }, "wait can only run queued tasks");

  console.log("self-test passed");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

function run(args, options = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: repoRoot,
    env: options.env || process.env,
    stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true
  });
  if (options.input) child.stdin.end(options.input);

  const promise = new Promise((resolvePromise, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        reject(new Error(`Command failed: node ${cli} ${args.join(" ")}\n${stderr}\n${stdout}`));
      }
    });
  });

  return options.background ? promise : promise;
}

async function expectFailure(args, options, expected) {
  try {
    await run(args, options);
  } catch (error) {
    if (!String(error.message).includes(expected)) {
      throw new Error(`Expected failure to include: ${expected}\nActual:\n${error.message}`);
    }
    return;
  }

  throw new Error(`Expected command to fail: ${args.join(" ")}`);
}

function parseTaskId(output) {
  const match = output.match(/Started Claude Code task: ([^\s]+)/u);
  if (!match) throw new Error(`Could not parse task id from output:\n${output}`);
  return match[1];
}

function assertIncludes(value, expected, message) {
  if (!value.includes(expected)) {
    throw new Error(`${message}\nExpected: ${expected}\nActual:\n${value}`);
  }
}

async function rewriteTaskMeta(bridgeDir, id, values) {
  const file = join(bridgeDir, `${id}.json`);
  const meta = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify({ ...meta, ...values }, null, 2)}\n`, "utf8");
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function fakeClaudeSource() {
  return String.raw`#!/usr/bin/env node
const inputFormat = process.argv.includes("--input-format")
  ? process.argv[process.argv.indexOf("--input-format") + 1]
  : "text";
const sessionId = "00000000-0000-4000-8000-000000000000";

if (process.argv.includes("--version")) {
  console.log("fake-claude 0.0.0");
  process.exit(0);
}

if (inputFormat === "stream-json") {
  let buffer = "";
  const messages = [];
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      messages.push(event.message.content.map((part) => part.text).join("\n"));
      process.stdout.write(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: messages.at(-1) }] }
      }) + "\n");
    }
  });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: messages.join("\n---\n")
    }) + "\n");
  });
} else {
  let prompt = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    prompt += chunk;
  });
  process.stdin.on("end", () => {
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: prompt
    }) + "\n");
  });
}
`;
}
