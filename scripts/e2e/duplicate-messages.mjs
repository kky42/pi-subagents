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
const linkCount = 12;
const factsPerLink = 160;

loadDotEnv(path.join(repoRoot, ".env"));

function parseArgs(argv) {
  const options = {
    repetitions: 3,
    timeoutMs: 420_000,
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
  console.log(`Usage: node scripts/e2e/duplicate-messages.mjs [options]

Runs the real foreground Pi and background PiFlow run_agent scenario that originally exposed repeated
commentary/final-answer text blocks. Message block shapes and exact duplicates are observations only.
Only process, timeout, and incomplete background-task delivery failures make the command fail.

Models:
  foreground: ${rootModel} (${rootThinking})
  subagents:  ${subagentModel} (${subagentThinking})

Options:
  --repetitions <1-10>            sequential observations (default: 3)
  --timeout-ms <ms>               timeout per observation (default: 420000)
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

function signaturePhase(signature) {
  if (signature && typeof signature === "object") return signature.phase ?? null;
  if (typeof signature !== "string") return null;
  try {
    const parsed = JSON.parse(signature);
    return parsed && typeof parsed === "object" ? parsed.phase ?? null : null;
  } catch {
    return null;
  }
}

function textBlocks(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((item) => item?.type === "text")
    .map((item) => ({
      text: String(item.text ?? ""),
      phase: signaturePhase(item.textSignature),
    }));
}

function hasExactDuplicate(blocks) {
  const texts = blocks.map((block) => block.text).filter(Boolean);
  return new Set(texts).size < texts.length;
}

function prepareFixture(root) {
  const fixture = path.join(root, "fixture");
  const chainDir = path.join(fixture, "chain");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  mkdirSync(chainDir, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  const names = Array.from({ length: linkCount }, (_, index) =>
    index === 0
      ? "start.txt"
      : `link-${String(index).padStart(2, "0")}-${((index + 17) * 2654435761 >>> 0).toString(16)}.txt`);
  for (let index = 0; index < names.length; index += 1) {
    const next = index + 1 < names.length ? `chain/${names[index + 1]}` : "END";
    const facts = Array.from({ length: factsPerLink }, (_, fact) =>
      `FACT ${index + 1}.${fact + 1}: component-${index + 1}-${fact + 1} uses protocol-v3 and reports compatibility-ok.`).join("\n");
    writeFileSync(
      path.join(chainDir, names[index]),
      `LINK ${index + 1} OF ${linkCount}\n${facts}\nNEXT: ${next}\n`,
      "utf8",
    );
  }

  writeFileSync(path.join(fixture, "README.md"), "# Three repository compatibility fixture\n", "utf8");
  writeFileSync(path.join(fixture, "AGENTS.md"), `# Fixture review protocol

For a comprehensive review of repo-a, repo-b, and repo-c:

- Delegate each repository review and the cross-repository compatibility review to independent expert run_agent tasks using the expert profile.
- While those background reviews run, independently inspect the evidence chain starting at chain/start.txt.
- Each chain file reveals the next path in its NEXT field. Read every link in order with the read tool until NEXT: END.
- The foreground chain and all delegated reviews are required evidence for the final answer.
- Keep the review read-only.
`, "utf8");
  for (const repository of ["repo-a", "repo-b", "repo-c"]) {
    mkdirSync(path.join(fixture, repository), { recursive: true });
    writeFileSync(path.join(fixture, repository, "package.json"), `${JSON.stringify({
      name: repository,
      version: "1.0.0",
      peerDependencies: { pi: "^0.83.0" },
    }, null, 2)}\n`, "utf8");
  }

  return { fixture, agentDir, sessionDir };
}

function writeExpertProfile(agentDir) {
  writeFileSync(path.join(agentDir, "subagents", "expert.md"), `---
description: 负责高复杂度仓库审查和跨仓兼容性分析。
backend: pi
model: ${subagentModel}
thinking: ${subagentThinking}
tools: bash
---

Before doing any task work, run sleep 120 with bash. After it returns, complete the assigned review.
`, "utf8");
}

async function runOnce(options, runRoot, repetition) {
  const root = path.join(runRoot, `run-${repetition}`);
  const { fixture, agentDir, sessionDir } = prepareFixture(root);
  prepareAuthDirectory(options.authAgentDir, agentDir);
  writeExpertProfile(agentDir);
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
    "--tools", "read,run_agent",
    "--approve",
  ], { cwd: fixture, env: environment, stdio: ["pipe", "pipe", "pipe"] });

  const responses = [];
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let stderr = "";
  let accepted = 0;
  let notifications = 0;
  let reads = 0;
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
        summary = {
          repetition,
          accepted,
          notifications,
          reads,
          settled,
          responses,
          multiBlockResponses: responses.filter((response) => response.blocks.length > 1).length,
          nonEmptyMultiBlockResponses: responses.filter(
            (response) => response.blocks.filter((block) => block.text).length > 1,
          ).length,
          exactDuplicateResponses: responses.filter((response) => hasExactDuplicate(response.blocks)).length,
          exactDuplicatesBeforeFirstNotification: responses.filter(
            (response) => response.beforeFirstNotification && hasExactDuplicate(response.blocks),
          ).length,
        };
      }
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      if (error) {
        reject(new Error(
          `${error.message}: accepted=${accepted} notifications=${notifications} reads=${reads}\n${stderr}`,
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
      if (event.type === "tool_execution_end") {
        if (event.toolName === "run_agent" && event.result?.details?.status === "accepted") accepted += 1;
        if (event.toolName === "read" && !event.isError) reads += 1;
      }
      if (event.type === "message_end") {
        const message = event.message;
        if (message?.role === "custom" && message.customType === "pi-flow-task-notification") {
          notifications += 1;
        }
        if (message?.role === "assistant") {
          const blocks = textBlocks(message);
          if (blocks.length > 0) {
            const response = {
              beforeFirstNotification: notifications === 0,
              notificationCount: notifications,
              responseId: message.responseId ?? null,
              stopReason: message.stopReason ?? null,
              blocks,
            };
            responses.push(response);
            console.log(
              `[run ${repetition}] notifications=${notifications} blocks=${JSON.stringify(blocks.map((block) => ({
                phase: block.phase,
                preview: block.text.replace(/\s+/g, " ").slice(0, 180),
              })))}`,
            );
          }
        }
      }
      if (event.type === "agent_settled") {
        settled += 1;
        if (notifications >= accepted) setTimeout(() => finish(), 300);
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
      message: "repo-a, repo-b, repo-c 我希望你全面审查一下这3个仓库的兼容性，以及它们各自有没有严重的bug。不要做任何修改，采用非常简要的方式回答。",
    })}\n`);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const runRoot = mkdtempSync(path.join(tmpdir(), "pi-flow-duplicate-messages-e2e-"));
  try {
    console.log("pi-flow duplicate-message E2E observations");
    console.log(`  foreground: ${rootModel} (${rootThinking})`);
    console.log(`  subagents: ${subagentModel} (${subagentThinking})`);
    console.log(`  repetitions: ${options.repetitions}`);
    console.log(`  Claude Code provider guard: DeepSeek (${DEEPSEEK_ANTHROPIC_BASE_URL})`);

    const results = [];
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      results.push(await runOnce(options, runRoot, repetition));
    }
    const report = {
      purpose: "Observation only. Message block counts and duplicate text do not affect exit status.",
      rootModel,
      rootThinking,
      subagentModel,
      subagentThinking,
      repetitions: options.repetitions,
      runsWithAnyMultiBlock: results.filter((run) => run.multiBlockResponses > 0).length,
      runsWithNonEmptyMultiBlock: results.filter((run) => run.nonEmptyMultiBlockResponses > 0).length,
      runsWithExactDuplicate: results.filter((run) => run.exactDuplicateResponses > 0).length,
      runsWithExactDuplicateBeforeFirstNotification: results.filter(
        (run) => run.exactDuplicatesBeforeFirstNotification > 0,
      ).length,
      results,
    };
    console.log(`\n${JSON.stringify(report, null, 2)}`);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`duplicate-message E2E error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
