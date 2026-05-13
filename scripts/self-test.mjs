#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
    CLAUDE_TASK_POLL_MS: "50",
    CLAUDE_TASK_MODEL: "",
    CLAUDE_TASK_MAX_TURNS: "",
    CLAUDE_TASK_SESSION_PERSISTENCE: "",
    CLAUDE_TASK_TIMEOUT_MS: ""
  };

  const doctor = await run(["doctor"], { env });
  assertIncludes(doctor, "nodeStatus: ok", "doctor should accept current Node version");
  assertIncludes(doctor, "claudeStatus: ok", "doctor should find fake Claude CLI");
  trace("doctor");

  const promptFile = join(tempDir, "prompt.md");
  await writeFile(promptFile, "Review prompt file", "utf8");
  const jsonStart = JSON.parse(await run(["start", "--json", "--file", promptFile], { env }));
  await run(["wait", jsonStart.id], { env });
  const jsonResult = JSON.parse(await run(["result", "--json", jsonStart.id], { env }));
  assertIncludes(JSON.stringify(jsonResult.parsedJson), "reviewed", "result --json should parse embedded JSON results");
  const jsonStatus = JSON.parse(await run(["status", "--json", jsonStart.id], { env }));
  assertIncludes(jsonStatus.status, "completed", "status --json should report completion");
  const startedArgs = await readTaskMeta(bridgeDir, jsonStart.id);
  if (startedArgs.profile !== "safe") throw new Error("default task profile should be safe");
  assertIncludes(startedArgs.args.join(" "), "--permission-mode acceptEdits", "default permission mode should allow read-only tools");
  assertIncludes(startedArgs.args.join(" "), "--allowed-tools", "default launch should include an allowed-tools whitelist");
  assertIncludes(startedArgs.args.join(" "), "--no-session-persistence", "default launch should avoid session persistence");
  assertIncludes(startedArgs.args.join(" "), "--max-budget-usd 5.00", "default budget should be conservative");
  const jsonList = JSON.parse(await run(["list", "--json"], { env }));
  if (!jsonList.some((task) => task.id === jsonStart.id)) {
    throw new Error("list --json should include JSON-created task");
  }
  trace("json task");
  const stdinStart = JSON.parse(await run(["start", "--json", "--stdin", "Review stdin"], { env, input: "stdin payload" }));
  await run(["wait", stdinStart.id], { env });
  const stdinResult = JSON.parse(await run(["result", "--json", stdinStart.id], { env }));
  assertIncludes(stdinResult.result, "stdin payload", "start --stdin should include piped prompt content");
  if (stdinResult.parsedJson !== null) {
    throw new Error("result --json should return parsedJson: null for plain text results");
  }
  trace("stdin task");

  const researchStart = JSON.parse(await run(["start", "--json", "--profile", "research", "Research profile"], { env }));
  const researchMeta = await readTaskMeta(bridgeDir, researchStart.id);
  assertIncludes(researchMeta.args.join(" "), "WebSearch", "research profile should include web search tools");
  await run(["stop", researchStart.id], { env });
  trace("research profile");
  const fullStart = JSON.parse(await run(["start", "--json", "--profile=full", "Full profile"], { env }));
  const fullMeta = await readTaskMeta(bridgeDir, fullStart.id);
  assertIncludes(fullMeta.args.join(" "), "--tools default", "full profile should enable Claude Code's default tool set");
  await run(["stop", fullStart.id], { env });
  trace("full profile");
  const envStart = JSON.parse(await run(["start", "--json", "Environment overrides"], {
    env: {
      ...env,
      CLAUDE_TASK_SESSION_PERSISTENCE: "1",
      CLAUDE_TASK_MODEL: "test-model",
      CLAUDE_TASK_MAX_TURNS: "3"
    }
  }));
  const envMeta = await readTaskMeta(bridgeDir, envStart.id);
  const envArgs = envMeta.args.join(" ");
  assertIncludes(envArgs, "--model test-model", "CLAUDE_TASK_MODEL should be passed through to Claude Code");
  assertIncludes(envArgs, "--max-turns 3", "CLAUDE_TASK_MAX_TURNS should be passed through to Claude Code");
  if (envArgs.includes("--no-session-persistence")) {
    throw new Error("CLAUDE_TASK_SESSION_PERSISTENCE=1 should omit --no-session-persistence");
  }
  if (envMeta.sessionPersistence !== true) {
    throw new Error("metadata should record enabled session persistence");
  }
  await run(["stop", envStart.id], { env });
  trace("env overrides");
  const timeoutStart = JSON.parse(await run(["start", "--json", "Timeout recoverable task"], {
    env: { ...env, CLAUDE_TASK_TIMEOUT_MS: "200" }
  }));
  const timeoutMeta = await readTaskMeta(bridgeDir, timeoutStart.id);
  if (timeoutMeta.timeoutMs !== 200) throw new Error("CLAUDE_TASK_TIMEOUT_MS should be saved in task metadata");
  trace("timeout start");
  await expectFailure(["wait", timeoutStart.id], { env: { ...env, FAKE_CLAUDE_HANG: "1" } }, "Command failed");
  const timeoutStatus = JSON.parse(await run(["status", "--json", timeoutStart.id], { env }));
  if (timeoutStatus.status !== "failed" || timeoutStatus.timeoutMs !== 200) {
    throw new Error(`timeout task should fail and report timeout metadata:\n${JSON.stringify(timeoutStatus, null, 2)}`);
  }
  await run(["wait", "--retry-failed", timeoutStart.id], { env });
  const timeoutRetryResult = JSON.parse(await run(["result", "--json", timeoutStart.id], { env }));
  assertIncludes(timeoutRetryResult.result, "Timeout recoverable task", "wait --retry-failed should rerun a failed task");
  trace("timeout task");
  const earlyExitStart = JSON.parse(await run(["start", "--json", "Early exit before stdin"], { env }));
  await expectFailure(["wait", earlyExitStart.id], { env: { ...env, FAKE_CLAUDE_EXIT_EARLY: "1" } }, "Command failed");
  const earlyExitStatus = JSON.parse(await run(["status", "--json", earlyExitStart.id], { env }));
  if (earlyExitStatus.status !== "failed") {
    throw new Error(`early child exit should fail without crashing the bridge:\n${JSON.stringify(earlyExitStatus, null, 2)}`);
  }
  trace("early exit task");
  const missingBinEnv = { ...env, CLAUDE_TASK_BIN: "definitely-missing-claude-bin.exe" };
  const missingBinStart = JSON.parse(await run(["start", "--json", "Missing Claude binary"], { env: missingBinEnv }));
  await expectFailure(["wait", missingBinStart.id], { env: missingBinEnv }, "Command failed");
  const missingBinStatus = JSON.parse(await run(["status", "--json", missingBinStart.id], { env }));
  if (missingBinStatus.status !== "failed") {
    throw new Error(`missing Claude binary should mark the task failed, not stale:\n${JSON.stringify(missingBinStatus, null, 2)}`);
  }
  assertIncludes(missingBinStatus.spawnError || "", "ENOENT", "status --json should expose spawnError for missing Claude binaries");
  const missingBinMeta = await readTaskMeta(bridgeDir, missingBinStart.id);
  assertIncludes(missingBinMeta.spawnError || "", "ENOENT", "missing Claude binary should record spawnError");
  trace("missing binary task");
  const noBoundaryStart = JSON.parse(await run(["start", "--json", "--no-boundaries", "No boundaries prompt"], { env }));
  const noBoundaryMeta = await readTaskMeta(bridgeDir, noBoundaryStart.id);
  if (noBoundaryMeta.fullPrompt.includes("Boundaries:")) {
    throw new Error("start --no-boundaries should omit the default boundary prompt");
  }
  await run(["stop", noBoundaryStart.id], { env });
  const customBoundaryStart = JSON.parse(await run(["start", "--json", "Custom boundaries prompt"], {
    env: { ...env, CLAUDE_TASK_BOUNDARIES: "Custom test boundaries" }
  }));
  const customBoundaryMeta = await readTaskMeta(bridgeDir, customBoundaryStart.id);
  assertIncludes(customBoundaryMeta.fullPrompt, "Custom test boundaries", "CLAUDE_TASK_BOUNDARIES should replace the default boundary prompt");
  await run(["stop", customBoundaryStart.id], { env });
  trace("profile and boundaries");

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
  trace("stale and tricky");

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
  const staleCancelGroup = JSON.parse(await run(["batch", "--json", "--stdin"], { env, input: "Stale cancel one\nStale cancel two\n" }));
  await rewriteTaskMeta(bridgeDir, staleCancelGroup.taskIds[0], {
    status: "running",
    claudeStartedAt: "2000-01-01T00:00:00.000Z",
    workerPid: 99999995,
    claudePid: 99999994
  });
  const staleStopGroup = JSON.parse(await run(["stop-group", "--json", staleCancelGroup.id], { env }));
  if (!staleStopGroup.outcomes.every((outcome) => outcome.status === "canceled")) {
    throw new Error(`stop-group --json should cancel stale and queued tasks:\n${JSON.stringify(staleStopGroup, null, 2)}`);
  }
  const liveGroup = JSON.parse(await run(["batch", "--json", "--live", "--stdin"], { env, input: "Running cancel task\n" }));
  const liveGroupWaiter = run(["wait", liveGroup.taskIds[0]], { env, background: true }).catch((error) => error);
  await delay(250);
  const runningGroupStatus = JSON.parse(await run(["group-status", "--json", liveGroup.id], { env }));
  if (runningGroupStatus.tasks[0].status !== "running") {
    throw new Error(`live group task should be running before stop-group:\n${JSON.stringify(runningGroupStatus, null, 2)}`);
  }
  const runningStopGroup = JSON.parse(await run(["stop-group", liveGroup.id, "--json"], { env }));
  if (runningStopGroup.outcomes[0].status !== "canceled") {
    throw new Error(`stop-group --json should cancel running tasks:\n${JSON.stringify(runningStopGroup, null, 2)}`);
  }
  await liveGroupWaiter;
  trace("stop group");
  const failedGroup = JSON.parse(await run(["batch", "--json", "--stdin"], { env, input: "Recover failed group task\n" }));
  await rewriteTaskMeta(bridgeDir, failedGroup.taskIds[0], {
    status: "failed",
    finishedAt: "2000-01-01T00:00:00.000Z",
    exitCode: 1,
    runError: "simulated failure"
  });
  const failedGroupRetry = JSON.parse(await run(["wait-group", "--json", "--retry-failed", failedGroup.id], { env }));
  if (failedGroupRetry.outcomes[0].status !== "completed") {
    throw new Error(`wait-group --retry-failed should rerun failed tasks:\n${JSON.stringify(failedGroupRetry, null, 2)}`);
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

  const separatedGroup = JSON.parse(await run(["batch", "--json", "--separator=---", "--stdin"], {
    env,
    input: "Multi line task A\ncontinued\n---\nMulti line task B\ncontinued\n"
  }));
  if (separatedGroup.tasks.length !== 2 || !separatedGroup.tasks[0].waitCommand) {
    throw new Error("batch --separator should create multi-line tasks");
  }
  const noBoundaryGroup = JSON.parse(await run(["batch", "--json", "--no-boundaries", "--stdin"], {
    env,
    input: "No boundary batch one\nNo boundary batch two\n"
  }));
  for (const taskId of noBoundaryGroup.taskIds) {
    const meta = await readTaskMeta(bridgeDir, taskId);
    if (meta.fullPrompt.includes("Boundaries:")) {
      throw new Error("batch --no-boundaries should omit the default boundary prompt for every task");
    }
  }
  const jsonlGroup = JSON.parse(await run(["batch", "--json", "--jsonl", "--stdin"], {
    env,
    input: "{\"prompt\":\"JSONL task one\"}\n\"JSONL task two\"\n"
  }));
  if (jsonlGroup.tasks.length !== 2) throw new Error("batch --jsonl should create two tasks");
  trace("batch formats");

  const normalId = parseTaskId(await run(["start", "Review diff"], { env }));
  await run(["wait", normalId], { env });
  const normalResult = await run(["result", normalId], { env });
  assertIncludes(normalResult, "Review diff", "normal result should include the prompt");
  const normalStatus = await run(["status", normalId], { env });
  assertIncludes(normalStatus, "sessionId: 00000000-0000-4000-8000-000000000000", "normal status should record session id");
  await expectFailure(["wait", normalId], { env }, "wait can only run queued tasks");
  trace("normal task");

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
  trace("live task");

  const queuedId = parseTaskId(await run(["start", "--live", "Never run this task"], { env }));
  await run(["stop", queuedId], { env });
  const stoppedStatus = await run(["status", queuedId], { env });
  assertIncludes(stoppedStatus, "status: canceled", "stop should cancel queued tasks");
  await expectFailure(["wait", queuedId], { env }, "wait can only run queued tasks");
  await rewriteTaskMeta(bridgeDir, queuedId, {
    createdAt: "2000-01-01T00:00:00.000Z",
    startedAt: "2000-01-01T00:00:00.000Z"
  });
  const cleanDryRun = JSON.parse(await run(["clean", "--json", "--dry-run", "--older-than", "0ms"], { env }));
  if (!cleanDryRun.dryRun || !cleanDryRun.removed.some((item) => item.id === queuedId)) {
    throw new Error("clean --dry-run should report old task files without deleting them");
  }
  await writeFile(join(bridgeDir, "fresh.tmp"), "partial", "utf8");
  const oldTmp = join(bridgeDir, "leftover.tmp");
  await writeFile(oldTmp, "partial", "utf8");
  await utimes(oldTmp, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));
  const cleanTmp = JSON.parse(await run(["clean", "--json", "--dry-run", "--older-than", "999d"], { env }));
  if (!cleanTmp.removed.some((item) => item.type === "tmp" && item.id === "leftover.tmp")) {
    throw new Error("clean --dry-run should report stale tmp files");
  }
  if (cleanTmp.removed.some((item) => item.type === "tmp" && item.id === "fresh.tmp")) {
    throw new Error("clean --dry-run should not report fresh tmp files");
  }
  const cleanActual = JSON.parse(await run(["clean", "--json", "--older-than", "999d"], { env }));
  if (cleanActual.dryRun || !cleanActual.removed.some((item) => item.id === queuedId)) {
    throw new Error("clean should delete old task files when dry-run is not set");
  }
  if (existsSync(join(bridgeDir, `${queuedId}.json`)) || existsSync(join(bridgeDir, "leftover.tmp"))) {
    throw new Error("clean should remove task metadata and stale tmp files");
  }
  if (!existsSync(join(bridgeDir, "fresh.tmp"))) {
    throw new Error("clean should preserve fresh tmp files");
  }
  trace("clean");

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

async function readTaskMeta(bridgeDir, id) {
  return JSON.parse(await readFile(join(bridgeDir, `${id}.json`), "utf8"));
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function trace(message) {
  if (process.env.SELF_TEST_TRACE === "1") console.error(`[self-test] ${message}`);
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

if (process.env.FAKE_CLAUDE_EXIT_EARLY === "1") {
  process.exit(17);
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
    if (process.env.FAKE_CLAUDE_HANG === "1") {
      setInterval(() => {}, 1000);
      return;
    }
    process.stdout.write(JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: sessionId,
      result: messages.join("\n---\n").includes("Review prompt file")
        ? "{\"reviewed\":true,\"source\":\"file\"}"
        : messages.join("\n---\n")
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
