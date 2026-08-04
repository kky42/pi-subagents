#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  loadDotEnv,
  prepareDeepseekClaudeE2EEnv,
} from "./lib/deepseek-claude-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(repoRoot, "index.ts");
const rootModel = "openai-codex/gpt-5.6-sol";
const rootThinking = "xhigh";
const subagentModel = "openai-codex/gpt-5.6-luna";
const subagentThinking = "low";
const childDelaySeconds = 30;
const expectedPackageName = "background-idle-fixture";
const expectedPackageVersion = "1.2.3";

loadDotEnv(path.join(repoRoot, ".env"));

function parseArgs(argv) {
  const options = {
    repetitions: 3,
    timeoutMs: 180_000,
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    authAgentDir: path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent")),
    piCommand: process.env.PI_E2E_COMMAND || "pi",
    extension: extensionPath,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return next;
    };
    if (arg === "--repetitions") options.repetitions = Number(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = value();
    else if (arg === "--auth-agent-dir") options.authAgentDir = path.resolve(value());
    else if (arg === "--pi-command") options.piCommand = value();
    else if (arg === "--extension") options.extension = path.resolve(value());
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 10) {
    throw new Error("--repetitions must be an integer from 1 to 10");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be positive");
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/e2e/background-idle.mjs [options]

Runs a real foreground Pi with Bash available while one delayed PiFlow subagent works in the background.
The user task does not prescribe a waiting strategy. The command fails if the foreground invokes Bash after
acceptance and before the completion notification, or if the task lifecycle and final answer are incomplete.

Models:
  foreground: ${rootModel} (${rootThinking})
  subagent:   ${subagentModel} (${subagentThinking})

Options:
  --repetitions <1-10>            sequential checks (default: 3)
  --timeout-ms <ms>               timeout per check (default: 180000)
  --deepseek-api-key-env <name>   preferred DeepSeek credential variable for the Claude safety guard
  --auth-agent-dir <dir>          Pi agent directory supplying openai-codex auth
  --pi-command <path>             Pi executable (default: PI_E2E_COMMAND or pi)
  --extension <path>              extension entry to evaluate (default: current worktree)
`);
}

function prepareAuthDirectory(sourceAgentDir, agentDir) {
  const sourcePath = path.join(sourceAgentDir, "auth.json");
  let sourceAuth;
  try {
    sourceAuth = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!sourceAuth?.["openai-codex"] || typeof sourceAuth["openai-codex"] !== "object") {
    throw new Error(`openai-codex auth is missing from ${sourcePath}; run /login for ChatGPT Plus/Pro first`);
  }
  mkdirSync(path.join(agentDir, "subagents"), { recursive: true });
  chmodSync(agentDir, 0o700);
  writeFileSync(
    path.join(agentDir, "auth.json"),
    `${JSON.stringify({ "openai-codex": sourceAuth["openai-codex"] }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

function prepareRun(root, authAgentDir) {
  const fixture = path.join(root, "fixture");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  mkdirSync(fixture, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });
  prepareAuthDirectory(authAgentDir, agentDir);
  writeFileSync(
    path.join(fixture, "package.json"),
    `${JSON.stringify({ name: expectedPackageName, version: expectedPackageVersion }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    path.join(agentDir, "subagents", "idle-reviewer.md"),
    `---
description: Delayed read-only package reviewer used only when explicitly requested.
backend: pi
model: ${subagentModel}
thinking: ${subagentThinking}
tools: read, bash
---

Before reviewing any files, run \`sleep ${childDelaySeconds}\` with Bash. Then inspect the requested file and report its package name and version.
`,
    "utf8",
  );
  return { fixture, agentDir, sessionDir };
}

function parseEnvelope(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function assistantText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((item) => item?.type === "text")
    .map((item) => String(item.text ?? ""))
    .filter(Boolean)
    .join("\n");
}

function activeTaskIds(acceptedTasks, notifications) {
  const completed = new Set(notifications.map((notification) => notification.task_id));
  return acceptedTasks.map((task) => task.task_id).filter((taskId) => !completed.has(taskId));
}

function summarizeRun(repetition, acceptedTasks, notifications, bashCalls, responses, settled) {
  const activeBashCalls = bashCalls.filter((call) => call.activeTaskIds.length > 0);
  const finalText = responses
    .filter((response) => response.notificationCount > 0)
    .map((response) => response.text)
    .join("\n");
  const violations = [];
  if (acceptedTasks.length !== 1) violations.push(`expected 1 accepted task, observed ${acceptedTasks.length}`);
  if (notifications.length !== 1) violations.push(`expected 1 terminal notification, observed ${notifications.length}`);
  if (
    acceptedTasks.length === 1
    && notifications.length === 1
    && acceptedTasks[0].task_id !== notifications[0].task_id
  ) {
    violations.push("terminal notification task_id did not match the accepted task");
  }
  if (notifications.length === 1 && notifications[0].status !== "completed") {
    violations.push(`expected completed notification, observed ${notifications[0].status ?? "unknown"}`);
  }
  if (activeBashCalls.length > 0) {
    violations.push(`${activeBashCalls.length} foreground Bash call(s) ran while a background task was active`);
  }
  if (!finalText.includes(expectedPackageName) || !finalText.includes(expectedPackageVersion)) {
    violations.push("final response did not include the delegated package name and version");
  }
  return {
    repetition,
    acceptedTasks,
    notifications,
    foregroundBashCalls: bashCalls,
    activeForegroundBashCalls: activeBashCalls,
    responses,
    settled,
    violations,
  };
}

async function runOnce(options, runRoot, repetition) {
  const root = path.join(runRoot, `run-${repetition}`);
  const { fixture, agentDir, sessionDir } = prepareRun(root, options.authAgentDir);
  const environment = prepareDeepseekClaudeE2EEnv(process.env, {
    apiKeyEnv: options.deepseekApiKeyEnv,
    runtimeDir: path.join(root, "claude-runtime"),
  });
  environment.PI_CODING_AGENT_DIR = agentDir;
  environment.PI_SKIP_VERSION_CHECK = "1";

  const child = spawn(options.piCommand, [
    "--mode", "rpc",
    "--model", rootModel,
    "--thinking", rootThinking,
    "--session-dir", sessionDir,
    "--no-extensions",
    "--extension", options.extension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--tools", "bash,run_agent",
    "--approve",
  ], { cwd: fixture, env: environment, stdio: ["pipe", "pipe", "pipe"] });

  const acceptedTasks = [];
  const notifications = [];
  const bashCalls = [];
  const responses = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let stderr = "";
  let settled = 0;
  let done = false;
  let summary;

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => finish(new Error(`run ${repetition} timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (!error) {
        summary = summarizeRun(repetition, acceptedTasks, notifications, bashCalls, responses, settled);
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      if (error) {
        reject(new Error(
          `${error.message}: accepted=${acceptedTasks.length} notifications=${notifications.length} bashCalls=${bashCalls.length}\n${stderr}`,
        ));
      }
    }

    function handleLine(line) {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "tool_execution_start" && event.toolName === "bash") {
        const command = typeof event.args?.command === "string"
          ? event.args.command
          : JSON.stringify(event.args ?? null);
        const call = {
          command,
          acceptedCount: acceptedTasks.length,
          notificationCount: notifications.length,
          activeTaskIds: activeTaskIds(acceptedTasks, notifications),
        };
        bashCalls.push(call);
        console.log(`[run ${repetition}] foreground bash=${JSON.stringify(call)}`);
      }
      if (event.type === "tool_execution_end" && event.toolName === "run_agent") {
        const envelope = parseEnvelope(event.result?.details);
        if (envelope?.status === "accepted" && typeof envelope.task_id === "string") {
          acceptedTasks.push({ task_id: envelope.task_id, session_key: envelope.session_key ?? null });
        }
      }
      if (event.type === "message_end") {
        const message = event.message;
        if (message?.role === "custom" && message.customType === "pi-flow-task-notification") {
          const envelope = parseEnvelope(message.details) ?? parseEnvelope(message.content?.[0]?.text);
          if (envelope && typeof envelope.task_id === "string") {
            notifications.push({ task_id: envelope.task_id, status: envelope.status ?? null });
            console.log(`[run ${repetition}] notification=${JSON.stringify(notifications.at(-1))}`);
          }
        }
        if (message?.role === "assistant") {
          const text = assistantText(message);
          if (text) {
            const response = { notificationCount: notifications.length, text };
            responses.push(response);
            console.log(`[run ${repetition}] response=${JSON.stringify(response)}`);
          }
        }
      }
      if (event.type === "agent_settled") {
        settled += 1;
        if (acceptedTasks.length > 0 && notifications.length >= acceptedTasks.length) {
          setTimeout(() => finish(), 300);
        }
      }
    }

    child.stdout.on("data", (chunk) => {
      pending += decoder.write(chunk);
      while (true) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        let line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        handleLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1024 * 1024);
    });
    child.once("error", finish);
    child.once("close", (code, signal) => {
      if (summary) resolve(summary);
      else if (!done) reject(new Error(`run ${repetition} closed early: code=${code} signal=${signal}\n${stderr}`));
    });

    child.stdin.write(`${JSON.stringify({
      id: "prompt",
      type: "prompt",
      message: `Use exactly one idle-reviewer subagent to inspect package.json and report its package name and version. Do not inspect files in the foreground and do not modify anything.`,
    })}\n`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runRoot = mkdtempSync(path.join(tmpdir(), "pi-flow-background-idle-e2e-"));
  try {
    console.log("pi-flow background-idle E2E");
    console.log(`  foreground: ${rootModel} (${rootThinking})`);
    console.log(`  subagent: ${subagentModel} (${subagentThinking})`);
    console.log(`  repetitions: ${options.repetitions}`);
    console.log(`  child delay: ${childDelaySeconds}s`);
    console.log(`  working directory: temporary fixture`);
    console.log(`  Claude Code provider guard: DeepSeek (${DEEPSEEK_ANTHROPIC_BASE_URL})`);

    const results = [];
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      results.push(await runOnce(options, runRoot, repetition));
    }
    const violationCount = results.reduce((total, result) => total + result.violations.length, 0);
    const report = {
      purpose: "Assert that the foreground makes no Bash calls solely to wait for an accepted background task.",
      rootModel,
      rootThinking,
      subagentModel,
      subagentThinking,
      childDelaySeconds,
      repetitions: options.repetitions,
      violationCount,
      results,
    };
    console.log(`\n${JSON.stringify(report, null, 2)}`);
    if (violationCount > 0) throw new Error(`background-idle E2E observed ${violationCount} behavioral violation(s)`);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`background-idle E2E error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
