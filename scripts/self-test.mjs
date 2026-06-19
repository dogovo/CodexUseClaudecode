#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "scripts", "claude-task.mjs");
const tempDir = await mkdtemp(join(tmpdir(), "codex-use-claude-code-"));

try {
  const bridgeDir = join(tempDir, "jobs");
  const fakeSdk = join(tempDir, "fake-sdk.mjs");
  await mkdir(bridgeDir, { recursive: true });
  await writeFile(fakeSdk, fakeSdkSource(), "utf8");

  const env = {
    ...process.env,
    CLAUDE_BRIDGE_DIR: bridgeDir,
    CLAUDE_TASK_SDK_MODULE: pathToFileURL(fakeSdk).href,
    CLAUDE_TASK_POLL_MS: "25",
    CLAUDE_TASK_EVENT_LIMIT: "8",
    CLAUDE_TASK_RETAIN_DAYS: "7",
    CLAUDE_TASK_RETAIN_TASKS: "50",
    CLAUDE_TASK_MODEL: "",
    CLAUDE_TASK_MAX_TURNS: "",
    CLAUDE_TASK_SESSION_PERSISTENCE: "",
    CLAUDE_TASK_TIMEOUT_MS: ""
  };

  const doctor = await run(["doctor"], { env });
  assertIncludes(doctor, "nodeStatus: ok", "doctor should accept current Node version");
  assertIncludes(doctor, "sdkStatus: ok", "doctor should load fake SDK");
  assertIncludes(doctor, "storage: compact-json", "doctor should report compact storage");
  trace("doctor");

  const promptFile = join(tempDir, "prompt.md");
  await writeFile(promptFile, "Review prompt file", "utf8");
  const jsonStart = JSON.parse(await run(["start", "--json", "--file", promptFile], { env }));
  await run(["wait", jsonStart.id], { env });
  const jsonResult = JSON.parse(await run(["result", "--json", jsonStart.id], { env }));
  assertIncludes(JSON.stringify(jsonResult.parsedJson), "reviewed", "result --json should parse embedded JSON results");
  const jsonStatus = JSON.parse(await run(["status", "--json", jsonStart.id], { env }));
  assertIncludes(jsonStatus.status, "completed", "status --json should report completion");
  const startedMeta = await readTaskMeta(bridgeDir, jsonStart.id);
  if (startedMeta.profile !== "safe") throw new Error("default task profile should be safe");
  if (startedMeta.storage !== "compact-json") throw new Error("task should use compact-json storage");
  if (startedMeta.options.permissionMode !== "dontAsk") throw new Error("default permission mode should be dontAsk");
  if (!startedMeta.options.tools.includes("Bash")) throw new Error("safe tools should include Bash for read-only git commands");
  if (!startedMeta.options.tools.includes("AskUserQuestion")) throw new Error("safe tools should include AskUserQuestion for explicit approval/clarification flows");
  if (!startedMeta.options.allowedTools.includes("Read")) throw new Error("safe allowedTools should pre-approve Read in dontAsk mode");
  if (!startedMeta.options.allowedTools.includes("Grep")) throw new Error("safe allowedTools should pre-approve Grep in dontAsk mode");
  if (!startedMeta.options.allowedTools.includes("Glob")) throw new Error("safe allowedTools should pre-approve Glob in dontAsk mode");
  if (!startedMeta.options.allowedTools.includes("Bash(git diff *)")) throw new Error("safe allowedTools should include git diff with arguments");
  if (startedMeta.options.approvalMode !== "deny") throw new Error("default approval mode should be deny");
  if (startedMeta.options.persistSession !== false) throw new Error("SDK session persistence should be disabled by default");
  if (startedMeta.events.length > 8) throw new Error("compact event history should respect event limit");
  const logFiles = await findFiles(bridgeDir, ".log");
  if (logFiles.length) throw new Error(`compact storage should not create .log files: ${logFiles.join(", ")}`);
  trace("json task");

  const stdinStart = JSON.parse(await run(["start", "--json", "--stdin", "Review stdin"], { env, input: "stdin payload" }));
  await run(["wait", stdinStart.id], { env });
  const stdinResult = JSON.parse(await run(["result", "--json", stdinStart.id], { env }));
  assertIncludes(stdinResult.result, "stdin payload", "start --stdin should include piped prompt content");
  if (stdinResult.parsedJson !== null) throw new Error("result --json should return parsedJson: null for plain text results");
  trace("stdin task");

  const dashPromptStart = JSON.parse(await run(["start", "--json", "--", "--flag-looking prompt"], { env }));
  const dashPromptMeta = await readTaskMeta(bridgeDir, dashPromptStart.id);
  assertIncludes(dashPromptMeta.prompt, "--flag-looking prompt", "-- should allow prompts that start with a dash");
  await run(["stop", dashPromptStart.id], { env });
  trace("dash prompt");

  const researchStart = JSON.parse(await run(["start", "--json", "--profile", "research", "Research profile"], { env }));
  const researchMeta = await readTaskMeta(bridgeDir, researchStart.id);
  if (!researchMeta.options.tools.includes("WebSearch")) throw new Error("research profile should include WebSearch");
  if (!researchMeta.options.allowedTools.includes("WebSearch")) throw new Error("research allowedTools should pre-approve WebSearch in dontAsk mode");
  await run(["stop", researchStart.id], { env });

  const fullStart = JSON.parse(await run(["start", "--json", "--profile=full", "Full profile"], { env }));
  const fullMeta = await readTaskMeta(bridgeDir, fullStart.id);
  if (fullMeta.options.tools?.preset !== "claude_code") throw new Error("full profile should enable Claude Code preset tools");
  await run(["stop", fullStart.id], { env });
  trace("profiles");

  const approvalStart = JSON.parse(await run(["start", "--json", "--approval", "ask", "Approval prompt"], { env }));
  const approvalMeta = await readTaskMeta(bridgeDir, approvalStart.id);
  if (approvalMeta.options.permissionMode !== "default") throw new Error("--approval ask should switch dontAsk profiles to default permission mode");
  const approvalWaiter = run(["wait", approvalStart.id], { env, background: true });
  await delay(300);
  const pendingApproval = JSON.parse(await run(["approvals", "--json", approvalStart.id], { env }));
  if (pendingApproval.approval?.status !== "pending") {
    throw new Error(`approval should be pending before approve:\n${JSON.stringify(pendingApproval, null, 2)}`);
  }
  await run(["approve", approvalStart.id, pendingApproval.approval.id], { env });
  await approvalWaiter;
  const approvalResult = JSON.parse(await run(["result", "--json", approvalStart.id], { env }));
  assertIncludes(approvalResult.result, "approval:allow", "approve should release a pending SDK approval request");
  const approvalStatusAfter = JSON.parse(await run(["status", "--json", approvalStart.id], { env }));
  if (approvalStatusAfter.pendingApproval !== null) throw new Error("consumed approvals should clear pendingApproval from status");
  trace("approval");

  const envStart = JSON.parse(await run(["start", "--json", "Environment overrides"], {
    env: {
      ...env,
      CLAUDE_TASK_SESSION_PERSISTENCE: "1",
      CLAUDE_TASK_MODEL: "test-model",
      CLAUDE_TASK_MAX_TURNS: "3",
      CLAUDE_TASK_MAX_BUDGET_USD: "9.5"
    }
  }));
  const envMeta = await readTaskMeta(bridgeDir, envStart.id);
  if (envMeta.options.persistSession !== true) throw new Error("CLAUDE_TASK_SESSION_PERSISTENCE=1 should enable SDK persistence");
  if (envMeta.options.model !== "test-model") throw new Error("CLAUDE_TASK_MODEL should be saved");
  if (envMeta.options.maxTurns !== 3) throw new Error("CLAUDE_TASK_MAX_TURNS should be saved");
  if (envMeta.options.maxBudgetUsd !== 9.5) throw new Error("CLAUDE_TASK_MAX_BUDGET_USD should be saved");
  await run(["stop", envStart.id], { env });
  trace("env overrides");

  const timeoutStart = JSON.parse(await run(["start", "--json", "Timeout recoverable task"], {
    env: { ...env, CLAUDE_TASK_TIMEOUT_MS: "100" }
  }));
  const timeoutMeta = await readTaskMeta(bridgeDir, timeoutStart.id);
  if (timeoutMeta.timeoutMs !== 100) throw new Error("CLAUDE_TASK_TIMEOUT_MS should be saved in task metadata");
  await expectFailure(["wait", timeoutStart.id], { env: { ...env, FAKE_SDK_HANG: "1", CLAUDE_TASK_TIMEOUT_MS: "100" } }, "Command failed");
  const timeoutStatus = JSON.parse(await run(["status", "--json", timeoutStart.id], { env }));
  if (timeoutStatus.status !== "failed" || timeoutStatus.timeoutMs !== 100) {
    throw new Error(`timeout task should fail and report timeout metadata:\n${JSON.stringify(timeoutStatus, null, 2)}`);
  }
  await run(["wait", "--retry-failed", timeoutStart.id], { env });
  const timeoutRetryResult = JSON.parse(await run(["result", "--json", timeoutStart.id], { env }));
  assertIncludes(timeoutRetryResult.result, "Timeout recoverable task", "wait --retry-failed should rerun a failed task");
  trace("timeout");

  const missingBinEnv = { ...env, CLAUDE_TASK_BIN: "definitely-missing-claude-bin.exe" };
  const missingBinStart = JSON.parse(await run(["start", "--json", "Missing SDK executable"], { env: missingBinEnv }));
  await expectFailure(["wait", missingBinStart.id], { env: missingBinEnv }, "Command failed");
  const missingBinStatus = JSON.parse(await run(["status", "--json", missingBinStart.id], { env }));
  if (missingBinStatus.status !== "failed" || !missingBinStatus.error.includes("ENOENT")) {
    throw new Error(`missing SDK executable should fail with ENOENT:\n${JSON.stringify(missingBinStatus, null, 2)}`);
  }
  trace("missing executable");

  const noBoundaryStart = JSON.parse(await run(["start", "--json", "--no-boundaries", "No boundaries prompt"], { env }));
  const noBoundaryMeta = await readTaskMeta(bridgeDir, noBoundaryStart.id);
  if (noBoundaryMeta.fullPrompt.includes("Boundaries:")) throw new Error("start --no-boundaries should omit the default boundary prompt");
  await run(["stop", noBoundaryStart.id], { env });
  const customBoundaryStart = JSON.parse(await run(["start", "--json", "Custom boundaries prompt"], {
    env: { ...env, CLAUDE_TASK_BOUNDARIES: "Custom test boundaries" }
  }));
  const customBoundaryMeta = await readTaskMeta(bridgeDir, customBoundaryStart.id);
  assertIncludes(customBoundaryMeta.fullPrompt, "Custom test boundaries", "CLAUDE_TASK_BOUNDARIES should replace the default boundary prompt");
  await run(["stop", customBoundaryStart.id], { env });
  trace("boundaries");

  const latestFirst = JSON.parse(await run(["start", "--json", "Latest first"], { env }));
  const latestSecond = JSON.parse(await run(["start", "--json", "Latest second"], { env }));
  await rewriteTaskMeta(bridgeDir, latestFirst.id, { createdAt: "2099-01-01T00:00:00.000Z" });
  await rewriteTaskMeta(bridgeDir, latestSecond.id, { createdAt: "2000-01-01T00:00:00.000Z" });
  const latestStatus = JSON.parse(await run(["status", "--json"], { env }));
  if (latestStatus.id !== latestFirst.id) throw new Error(`latest task should sort by metadata createdAt. Expected ${latestFirst.id}, got ${latestStatus.id}`);
  await run(["stop", latestFirst.id], { env });
  await run(["stop", latestSecond.id], { env });

  const staleStart = JSON.parse(await run(["start", "--json", "Retry stale task"], { env }));
  await rewriteTaskMeta(bridgeDir, staleStart.id, { status: "running", workerPid: 99999999 });
  const staleStatus = JSON.parse(await run(["status", "--json", staleStart.id], { env }));
  assertIncludes(staleStatus.status, "stale", "dead recorded worker PID should make a running task stale");
  await run(["wait", "--retry-stale", staleStart.id], { env });
  const staleResult = JSON.parse(await run(["result", "--json", staleStart.id], { env }));
  assertIncludes(staleResult.result, "Retry stale task", "wait --retry-stale should rerun a stale task");
  trace("stale");

  const group = JSON.parse(await run(["batch", "--json", "--stdin"], { env, input: "Group task one\nGroup task two\n" }));
  if (group.tasks.length !== 2) throw new Error("batch should create two tasks");
  const groupStatusBefore = JSON.parse(await run(["group-status", "--json", group.id], { env }));
  if (!groupStatusBefore.tasks.every((task) => task.status === "queued")) throw new Error("new batch tasks should start queued");
  const groupWait = JSON.parse(await run(["wait-group", "--json", "--concurrency", "2", group.id], { env }));
  if (!groupWait.outcomes.every((outcome) => outcome.status === "completed")) {
    throw new Error(`wait-group should complete every task:\n${JSON.stringify(groupWait, null, 2)}`);
  }
  const groupResult = JSON.parse(await run(["group-result", "--json", group.id], { env }));
  if (!groupResult.results.every((item) => item.result?.includes("Group task"))) throw new Error("group-result should include each task result");

  const cancelGroup = JSON.parse(await run(["batch", "--json", "--stdin"], { env, input: "Cancel group one\nCancel group two\n" }));
  const stopGroup = JSON.parse(await run(["stop-group", cancelGroup.id, "--json"], { env }));
  if (!stopGroup.outcomes.every((outcome) => outcome.status === "canceled")) throw new Error("stop-group should cancel queued tasks");

  const separatedGroup = JSON.parse(await run(["batch", "--json", "--separator=---", "--stdin"], {
    env,
    input: "Multi line task A\ncontinued\n---\nMulti line task B\ncontinued\n"
  }));
  if (separatedGroup.tasks.length !== 2 || !separatedGroup.tasks[0].waitCommand) throw new Error("batch --separator should create multi-line tasks");
  const jsonlGroup = JSON.parse(await run(["batch", "--json", "--jsonl", "--stdin"], {
    env,
    input: "{\"prompt\":\"JSONL task one\"}\n\"JSONL task two\"\n"
  }));
  if (jsonlGroup.tasks.length !== 2) throw new Error("batch --jsonl should create two tasks");
  trace("groups");

  const normalId = parseTaskId(await run(["start", "Review diff"], { env }));
  await run(["wait", normalId], { env });
  const normalResult = await run(["result", normalId], { env });
  assertIncludes(normalResult, "Review diff", "normal result should include the prompt");
  const normalStatus = await run(["status", normalId], { env });
  assertIncludes(normalStatus, "sessionId: 00000000-0000-4000-8000-000000000000", "normal status should record session id");
  await expectFailure(["wait", normalId], { env }, "wait can only run queued tasks");
  trace("normal");

  const liveId = parseTaskId(await run(["start", "--live", "Initial review"], { env }));
  const waiter = run(["wait", liveId], { env, background: true });
  await delay(200);
  const liveStatus = JSON.parse(await run(["status", "--json", liveId], { env }));
  if (liveStatus.status !== "running") throw new Error(`live task should be running before finish:\n${JSON.stringify(liveStatus, null, 2)}`);
  await run(["ask", liveId, "Also inspect tests"], { env });
  await delay(100);
  await run(["finish", liveId], { env });
  await waiter;
  const liveResult = await run(["result", liveId], { env });
  assertIncludes(liveResult, "Initial review", "live result should include initial prompt");
  assertIncludes(liveResult, "Also inspect tests", "live result should include follow-up");
  await expectFailure(["ask", liveId, "Too late"], { env }, "follow-ups can only be queued");
  const shortTail = await run(["tail", liveId, "8"], { env });
  assertIncludes(shortTail, "follow-up-sent", "tail should show compact follow-up events");
  trace("live");

  const queuedId = parseTaskId(await run(["start", "--live", "Never run this task"], { env }));
  await run(["stop", queuedId], { env });
  const stoppedStatus = await run(["status", queuedId], { env });
  assertIncludes(stoppedStatus, "status: canceled", "stop should cancel queued tasks");
  await expectFailure(["wait", queuedId], { env }, "wait can only run queued tasks");
  await rewriteTaskMeta(bridgeDir, queuedId, {
    createdAt: "2000-01-01T00:00:00.000Z",
    updatedAt: "2000-01-01T00:00:00.000Z"
  });
  const cleanDryRun = JSON.parse(await run(["clean", "--json", "--dry-run", "--older-than", "0ms"], { env }));
  if (!cleanDryRun.dryRun || !cleanDryRun.removed.some((item) => item.id === queuedId)) {
    throw new Error("clean --dry-run should report old task records without deleting them");
  }
  const cleanActual = JSON.parse(await run(["clean", "--json", "--older-than", "0ms", "--keep", "0"], { env }));
  if (cleanActual.dryRun || !cleanActual.removed.some((item) => item.id === queuedId)) {
    throw new Error("clean should delete old task records when dry-run is not set");
  }
  if (existsSync(taskFile(bridgeDir, queuedId))) throw new Error("clean should remove compact task metadata");
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
  if (!String(value).includes(expected)) {
    throw new Error(`${message}\nExpected: ${expected}\nActual:\n${value}`);
  }
}

async function rewriteTaskMeta(bridgeDir, id, values) {
  const file = taskFile(bridgeDir, id);
  const meta = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, `${JSON.stringify({ ...meta, ...values }, null, 2)}\n`, "utf8");
}

async function readTaskMeta(bridgeDir, id) {
  return JSON.parse(await readFile(taskFile(bridgeDir, id), "utf8"));
}

function taskFile(bridgeDir, id) {
  return join(bridgeDir, "tasks", `${id}.json`);
}

async function findFiles(dir, suffix) {
  const found = [];
  async function walk(current) {
    const entries = await import("node:fs/promises").then(({ readdir }) => readdir(current, { withFileTypes: true }).catch(() => []));
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      if (entry.isFile() && entry.name.endsWith(suffix)) found.push(full);
    }
  }
  await walk(dir);
  return found;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function trace(message) {
  if (process.env.SELF_TEST_TRACE === "1") console.error(`[self-test] ${message}`);
}

function fakeSdkSource() {
  return String.raw`
const sessionId = "00000000-0000-4000-8000-000000000000";

export function query({ prompt, options = {} }) {
  return (async function* () {
    if (options.pathToClaudeCodeExecutable?.includes("definitely-missing")) {
      throw new Error("ENOENT: fake SDK executable not found");
    }
    yield {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      claude_code_version: "fake-sdk-0.0.0",
      cwd: options.cwd || process.cwd(),
      tools: Array.isArray(options.tools) ? options.tools : ["preset:claude_code"],
      model: options.model || "fake-model",
      permissionMode: options.permissionMode || "default",
      slash_commands: [],
      output_style: "default",
      skills: [],
      plugins: [],
      mcp_servers: [],
      authSource: "temporary",
      uuid: "00000000-0000-4000-8000-000000000001"
    };

    if (process.env.FAKE_SDK_HANG === "1") {
      await waitForAbort(options.abortController?.signal);
      throw new Error("fake SDK aborted");
    }

    const messages = [];
    if (typeof prompt === "string") {
      messages.push(prompt);
      yield assistant(prompt);
    } else {
      for await (const item of prompt) {
        const text = item.message.content.map((part) => part.text || "").join("\n");
        messages.push(text);
        yield assistant(text);
      }
    }

    if (process.env.FAKE_SDK_ERROR_RESULT === "1") {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {},
        modelUsage: {},
        permission_denials: [],
        errors: ["fake SDK error"],
        session_id: sessionId,
        uuid: "00000000-0000-4000-8000-000000000003"
      };
      return;
    }

    const joined = messages.join("\n---\n");
    let approvalText = "";
    if (joined.includes("Approval prompt")) {
      const decision = await options.canUseTool?.("Bash", { command: "npm test" }, {
        signal: options.abortController?.signal,
        title: "Claude wants to run npm test",
        displayName: "Run command",
        description: "Fake SDK approval request"
      });
      approvalText = "approval:" + (decision?.behavior || "missing");
      yield assistant(approvalText);
    }
    const resultText = [joined, approvalText].filter(Boolean).join("\n");
    yield {
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 1,
      duration_api_ms: 1,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0.001,
      usage: { input_tokens: 1, output_tokens: 1 },
      modelUsage: {},
      permission_denials: [],
      result: joined.includes("Review prompt file") ? "{\"reviewed\":true,\"source\":\"file\"}" : resultText,
      session_id: sessionId,
      uuid: "00000000-0000-4000-8000-000000000002"
    };
  })();
}

function assistant(text) {
  return {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
    uuid: "00000000-0000-4000-8000-000000000004",
    session_id: sessionId
  };
}

function waitForAbort(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
}
`;
}
