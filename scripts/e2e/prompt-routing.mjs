#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  deepseekCredentialEnvNames,
  loadDotEnv,
  prepareDeepseekClaudeE2EEnv,
  resolveDeepseekApiKey,
} from "./lib/deepseek-claude-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(repoRoot, "index.ts");
const ROOT_MODEL = "openai-codex/gpt-5.6-luna";
const ROOT_THINKING = "xhigh";
const MAX_CAPTURE_CHARS = 16 * 1024 * 1024;
const MAX_STDOUT_LINE_CHARS = 8 * 1024 * 1024;
const SCENARIO_KEYS = ["direct", "focused", "flat", "continuation", "staged"];
const RUN_ROOT_MARKER = ".pi-flow-prompt-routing-owned";
const SAFE_ENV_NAMES = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "CI",
  "NO_COLOR",
  "FORCE_COLOR",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
];

loadDotEnv(path.join(repoRoot, ".env"));

function parseArgs(argv) {
  const options = {
    repetitions: 2,
    timeoutMs: 300_000,
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    runRoot: path.join(tmpdir(), `pi-flow-prompt-routing-${Date.now()}`),
    agentDir: undefined,
    authAgentDir: path.resolve(process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent")),
    piCommand: process.env.PI_E2E_COMMAND || "pi",
    extension: extensionPath,
    only: undefined,
    keep: false,
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
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--auth-agent-dir") options.authAgentDir = path.resolve(value());
    else if (arg === "--pi-command") options.piCommand = value();
    else if (arg === "--extension") options.extension = path.resolve(value());
    else if (arg === "--only") options.only = value().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || options.repetitions > 5) {
    throw new Error("--repetitions must be an integer from 1 to 5");
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be positive");
  }
  const unknown = (options.only ?? []).filter((key) => !SCENARIO_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  options.ownsAgentDir = options.agentDir === undefined;
  options.agentDir ??= path.join(options.runRoot, "agent");
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/e2e/prompt-routing.mjs [options]

Runs observation-only real-Pi routing scenarios against the current extension prompt.
The root is pinned to ${ROOT_MODEL} with ${ROOT_THINKING} thinking. Routing choices are recorded, never asserted.

Options:
  --repetitions <1-5>             repetitions per scenario (default: 2)
  --only <key,...>                direct, focused, flat, continuation, staged
  --timeout-ms <ms>               timeout per root run (default: 300000)
  --deepseek-api-key-env <name>   preferred DeepSeek credential variable for the Claude safety guard
  --run-root <dir>                artifact root
  --agent-dir <dir>               preconfigured isolated Pi agent directory (default: under run root)
  --auth-agent-dir <dir>          Pi agent directory supplying openai-codex auth to the isolated default
  --pi-command <path>             Pi executable (default: PI_E2E_COMMAND or pi)
  --extension <path>              extension entry to evaluate (default: current worktree)
  --keep                          keep sanitized observation artifacts
`);
}

function ensureDir(directory) {
  mkdirSync(directory, { recursive: true });
}

function canonicalPotentialPath(target) {
  let existing = target;
  const missing = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}

function isInside(parent, candidate) {
  const relativePath = path.relative(parent, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function assertAgentDirOwnership(options) {
  if (options.ownsAgentDir) return;
  const runRoot = canonicalPotentialPath(options.runRoot);
  const agentDir = canonicalPotentialPath(options.agentDir);
  if (isInside(runRoot, agentDir)) {
    throw new Error("an explicit --agent-dir must be outside --run-root; omit it to use the isolated default");
  }
}

function readAuthFile(authPath) {
  if (!existsSync(authPath)) {
    throw new Error(`auth file not found: ${authPath}`);
  }
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) throw new Error("root value must be an object");
    return auth;
  } catch (error) {
    throw new Error(`could not read auth file ${authPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function credentialValues(value, key = "") {
  if (typeof value === "string") return key !== "type" && value.length > 0 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => credentialValues(item));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([childKey, child]) => credentialValues(child, childKey));
}

function agentCredentialValues(agentDir) {
  return credentialValues(readAuthFile(path.join(agentDir, "auth.json")));
}

function prepareAgentDirectory(options) {
  ensureDir(options.agentDir);
  const sourceAuthPath = path.join(options.ownsAgentDir ? options.authAgentDir : options.agentDir, "auth.json");
  const sourceAuth = readAuthFile(sourceAuthPath);
  const openaiCodexAuth = sourceAuth["openai-codex"];
  if (!openaiCodexAuth || typeof openaiCodexAuth !== "object" || Array.isArray(openaiCodexAuth)) {
    throw new Error(`openai-codex auth is missing from ${sourceAuthPath}; run /login for ChatGPT Plus/Pro first`);
  }

  if (!options.ownsAgentDir) return credentialValues(sourceAuth);

  chmodSync(options.agentDir, 0o700);
  const isolatedAuth = { "openai-codex": openaiCodexAuth };
  writeFileSync(
    path.join(options.agentDir, "auth.json"),
    `${JSON.stringify(isolatedAuth, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return credentialValues(isolatedAuth);
}

function findPackageRoot(entry) {
  let directory = path.dirname(realpathSync(entry));
  while (true) {
    if (existsSync(path.join(directory, "package.json"))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return path.dirname(realpathSync(entry));
    directory = parent;
  }
}

function prepareRunRoot(directory) {
  if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || readdirSync(directory).length > 0)) {
    throw new Error("--run-root must not exist or must be an empty real directory");
  }
  ensureDir(directory);
  writeFileSync(path.join(directory, RUN_ROOT_MARKER), "pi-flow prompt-routing E2E\n", "utf8");
}

function removeOwnedRunRoot(directory) {
  if (!existsSync(path.join(directory, RUN_ROOT_MARKER))) {
    throw new Error("refusing to remove an artifact root without the pi-flow ownership marker");
  }
  rmSync(directory, { recursive: true, force: true });
}

function minimalE2EEnvironment(baseEnv, credential) {
  const environment = {};
  for (const name of SAFE_ENV_NAMES) {
    if (typeof baseEnv[name] === "string") environment[name] = baseEnv[name];
  }
  environment.DEEPSEEK_API_KEY = credential;
  return environment;
}

function redactSecrets(text, secrets) {
  let redacted = text;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted;
}

function createFixture(root) {
  const fixture = path.join(root, "fixture");
  ensureDir(path.join(fixture, "src"));
  ensureDir(path.join(fixture, "test"));
  const files = {
    "package.json": `${JSON.stringify({ name: "routing-fixture", type: "module", scripts: { test: "node --test" } }, null, 2)}\n`,
    "README.md": "# Routing fixture\n\nA tiny command-line report formatter.\n",
    "src/cli.js": "import { formatReport } from './report.js';\nprocess.stdout.write(formatReport(process.argv[2] ?? 'sample'));\n",
    "src/report.js": "export function formatReport(name) { return `Report: ${name}\\n`; }\n",
    "test/report.test.js": "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { formatReport } from '../src/report.js';\ntest('formats', () => assert.equal(formatReport('a'), 'Report: a\\n'));\n",
  };
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(path.join(fixture, relativePath), content, "utf8");
  }
  return fixture;
}

function snapshotFiles(root) {
  const snapshot = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const filePath = path.join(directory, entry);
      if (statSync(filePath).isDirectory()) walk(filePath);
      else snapshot.set(path.relative(root, filePath), readFileSync(filePath, "utf8"));
    }
  };
  walk(root);
  return snapshot;
}

function changedFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((key) => before.get(key) !== after.get(key))
    .sort();
}

function addUsage(total, usage) {
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    if (typeof usage?.[field] === "number") total[field] = (total[field] ?? 0) + usage[field];
  }
  if (typeof usage?.cost?.total === "number") total.cost = (total.cost ?? 0) + usage.cost.total;
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

function messageEnvelope(message) {
  return parseEnvelope(message.details) ?? parseEnvelope(message.content?.[0]?.text) ?? parseEnvelope(message.content);
}

function analyzeJsonl(text) {
  const analysis = {
    malformedLines: 0,
    toolCounts: {},
    subagentCalls: [],
    workflowCalls: [],
    acceptedTasks: [],
    notifications: [],
    rootUsage: {},
    rootModels: [],
    finalStop: false,
  };
  let group = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      analysis.malformedLines += 1;
      continue;
    }
    if (event.type !== "message_end") continue;
    const message = event.message ?? {};
    if (message.role === "assistant") {
      addUsage(analysis.rootUsage, message.usage);
      const rootModel = typeof message.provider === "string" && typeof message.model === "string"
        ? `${message.provider}/${message.model}`
        : undefined;
      if (rootModel && !analysis.rootModels.includes(rootModel)) analysis.rootModels.push(rootModel);
      const calls = (message.content ?? []).filter((item) => item?.type === "toolCall");
      if (calls.length > 0) group += 1;
      for (const call of calls) {
        analysis.toolCounts[call.name] = (analysis.toolCounts[call.name] ?? 0) + 1;
        const input = call.arguments ?? {};
        if (call.name === "run_subagent") {
          analysis.subagentCalls.push({ group, sessionKey: typeof input.session_key === "string" ? input.session_key : "" });
        } else if (call.name === "run_workflow") {
          const script = typeof input.script === "string" ? input.script : "";
          analysis.workflowCalls.push({
            group,
            source: script
              ? "inline"
              : typeof input.script_path === "string"
                ? "path"
                : typeof input.resume_from_task_id === "string"
                  ? "replay"
                  : "saved",
            pipeline: script.includes("pipeline("),
            parallel: script.includes("parallel("),
            schema: /\bschema\s*:/.test(script),
            sessionKeyExpressions: (script.match(/\bsession_key\s*:/g) ?? []).length,
            subagentExpressions: (script.match(/\brun_subagent\s*\(/g) ?? []).length,
          });
        }
      }
      if (message.stopReason === "stop") analysis.finalStop = true;
    } else if (message.role === "toolResult") {
      if (message.toolName !== "run_subagent" && message.toolName !== "run_workflow") continue;
      const envelope = messageEnvelope(message);
      const taskType = message.toolName === "run_subagent" ? "subagent" : "workflow";
      if (envelope?.task_type === taskType && envelope.status === "accepted" && typeof envelope.task_id === "string") {
        analysis.acceptedTasks.push({
          taskId: envelope.task_id,
          taskType,
          sessionKey: taskType === "subagent" && typeof envelope.session_key === "string" ? envelope.session_key : undefined,
        });
      }
    } else if (message.role === "custom" && message.customType === "pi-flow-task-notification-v2") {
      const envelope = messageEnvelope(message);
      if (
        (envelope?.task_type === "subagent" || envelope?.task_type === "workflow")
        && (envelope.status === "completed" || envelope.status === "failed")
        && typeof envelope.task_id === "string"
      ) {
        analysis.notifications.push({
          taskId: envelope.task_id,
          taskType: envelope.task_type,
          status: envelope.status,
          sessionKey: envelope.task_type === "subagent" && typeof envelope.session_key === "string"
            ? envelope.session_key
            : undefined,
        });
      }
    }
  }
  return analysis;
}

const SCENARIOS = [
  {
    key: "direct",
    prompt: "Read package.json directly with the root file tools and report only the package name. This is a narrow local lookup; do not delegate it and do not modify files.",
  },
  {
    key: "focused",
    prompt: "Map this repository's purpose, key files, runtime flow, and tests. Keep the investigation read-only and give a concise evidence-based summary.",
  },
  {
    key: "flat",
    prompt: "Review this repository across three independent dimensions: source correctness, tests and coverage, and documentation and package configuration. Keep this as a small flat fan-out, make no file changes, and synthesize a concise final assessment.",
  },
  {
    key: "continuation",
    prompt: "Use one subagent in two sequential turns. First ask it to read src/cli.js and src/report.js, remember the exported function and command-line argument flow, and reply with STEP1_DONE. Then ask that same continuing child, without re-reading files and without copying its first result into the second prompt, to recall the function and flow. Use pi-flow's child-conversation continuation feature, report the second result, and do not modify files.",
  },
  {
    key: "staged",
    prompt: "For each of package.json, src/cli.js, and test/report.test.js, first classify it as config, entry, or test using a strict machine-readable result. Then dispatch a classification-specific follow-up that states its role in one sentence. Different files may proceed concurrently, but each file's classify step must precede its follow-up. Return one object containing all classifications and follow-ups. Keep this read-only.",
  },
];

function infrastructureIssues(run, analysis) {
  const issues = [];
  if (run.code !== 0 || run.timedOut) issues.push(`Pi process code=${run.code} timedOut=${run.timedOut}`);
  if (run.captureError) issues.push(run.captureError);
  if (analysis.malformedLines > 0) issues.push(`retained JSONL has ${analysis.malformedLines} malformed line(s)`);
  if (!analysis.finalStop) issues.push("root produced no terminal assistant response");
  if (!analysis.rootModels.includes(ROOT_MODEL)) {
    issues.push(`expected root model ${ROOT_MODEL}; observed ${analysis.rootModels.join(", ") || "none"}`);
  }
  return issues;
}

function runPi({ options, fixture, scenario, repetition, environment, redactions }) {
  const runDir = path.join(options.runRoot, "runs", `${scenario.key}-${repetition}`);
  ensureDir(runDir);
  const args = [
    "-p",
    "--mode", "json",
    "--model", ROOT_MODEL,
    "--thinking", ROOT_THINKING,
    "--no-session",
    "--no-extensions",
    "--extension", options.extension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "read,bash,run_subagent,run_workflow",
    "--approve",
    scenario.prompt,
  ];
  return new Promise((resolve, reject) => {
    const before = snapshotFiles(fixture);
    const startedAt = Date.now();
    const child = spawn(options.piCommand, args, {
      cwd: fixture,
      env: {
        ...environment,
        PI_CODING_AGENT_DIR: options.agentDir,
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutPending = "";
    let stderr = "";
    let timedOut = false;
    let captureError;
    let killTimer;
    const terminate = () => {
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        killTimer.unref();
      }
    };
    const append = (current, chunk, stream) => {
      const next = current + String(chunk);
      if (next.length > MAX_CAPTURE_CHARS && !captureError) {
        captureError = `${stream} exceeded ${MAX_CAPTURE_CHARS} retained characters`;
        terminate();
      }
      return next.slice(0, MAX_CAPTURE_CHARS);
    };
    const retainStdoutLine = (line) => {
      if (!line.trim()) return;
      if (line.length > MAX_STDOUT_LINE_CHARS) {
        captureError ??= `stdout line exceeded ${MAX_STDOUT_LINE_CHARS} characters`;
        terminate();
        return;
      }
      try {
        const event = JSON.parse(line);
        if (event.type === "message_end") {
          stdout = append(stdout, `${line}\n`, "stdout");
        }
      } catch {
        stdout = append(stdout, `${line}\n`, "stdout");
      }
    };
    const consumeStdout = (chunk) => {
      stdoutPending += String(chunk);
      let newline = stdoutPending.indexOf("\n");
      while (newline !== -1) {
        retainStdoutLine(stdoutPending.slice(0, newline));
        stdoutPending = stdoutPending.slice(newline + 1);
        newline = stdoutPending.indexOf("\n");
      }
      if (stdoutPending.length > MAX_STDOUT_LINE_CHARS) {
        captureError ??= `stdout line exceeded ${MAX_STDOUT_LINE_CHARS} characters`;
        stdoutPending = "";
        terminate();
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk, "stderr"); });
    child.once("error", (error) => {
      stderr = append(stderr, `\nspawn error: ${error.message}`, "stderr");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      try {
        if (stdoutPending && !captureError) retainStdoutLine(stdoutPending);
        const after = snapshotFiles(fixture);
        const currentRedactions = [...redactions, ...agentCredentialValues(options.agentDir)];
        stdout = redactSecrets(stdout, currentRedactions);
        stderr = redactSecrets(stderr, currentRedactions);
        writeFileSync(path.join(runDir, "stdout.jsonl"), stdout, "utf8");
        writeFileSync(path.join(runDir, "stderr.log"), stderr, "utf8");
        resolve({
          code,
          signal,
          timedOut,
          captureError,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          changed: changedFiles(before, after),
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

function summarizedAnalysis(analysis) {
  const keyIds = new Map();
  const subagentTasks = analysis.acceptedTasks.filter((task) => task.taskType === "subagent");
  const sessionKeyPattern = subagentTasks.map((task) => {
    if (!task.sessionKey) return "missing";
    if (!keyIds.has(task.sessionKey)) keyIds.set(task.sessionKey, `key-${keyIds.size + 1}`);
    return keyIds.get(task.sessionKey);
  });
  const sessionKeyState = subagentTasks.length === 0
    ? "no-subagent-tasks"
    : sessionKeyPattern.includes("missing")
      ? "missing"
      : keyIds.size === 1
        ? "same"
        : "different";
  const tasks = analysis.acceptedTasks.map((accepted) => {
    const terminal = analysis.notifications.find((notification) =>
      notification.taskId === accepted.taskId && notification.taskType === accepted.taskType);
    return {
      taskId: accepted.taskId,
      taskType: accepted.taskType,
      acceptedStatus: "accepted",
      outcome: terminal?.status ?? "pending",
      ...(accepted.taskType === "subagent"
        ? {
            sessionKey: accepted.sessionKey ? keyIds.get(accepted.sessionKey) : null,
            terminalSessionKeyMatches: terminal ? terminal.sessionKey === accepted.sessionKey : null,
          }
        : {}),
    };
  });
  const taskOutcomes = {
    accepted: tasks.length,
    completed: tasks.filter((task) => task.outcome === "completed").length,
    failed: tasks.filter((task) => task.outcome === "failed").length,
    pending: tasks.filter((task) => task.outcome === "pending").length,
    unmatchedNotifications: analysis.notifications.filter((notification) =>
      !analysis.acceptedTasks.some((accepted) =>
        accepted.taskId === notification.taskId && accepted.taskType === notification.taskType)).length,
  };
  return {
    rootModels: analysis.rootModels,
    toolCounts: analysis.toolCounts,
    subagentCallCount: analysis.subagentCalls.length,
    subagentCallGroups: analysis.subagentCalls.map((call) => call.group),
    requestedSessionKeys: analysis.subagentCalls.map((call) =>
      call.sessionKey ? keyIds.get(call.sessionKey) ?? "provided-unmatched" : "fresh"),
    sessionKeyState,
    sessionKeyPattern,
    workflowCalls: analysis.workflowCalls,
    tasks,
    taskOutcomes,
    rootUsage: analysis.rootUsage,
  };
}

function printRun(result) {
  const status = result.infrastructureIssues.length > 0 ? "INFRA FAILURE" : "OBSERVED";
  console.log(`\n[${status}] ${result.scenario} repetition ${result.repetition} (${(result.durationMs / 1000).toFixed(1)}s)`);
  for (const issue of result.infrastructureIssues) console.log(`  infrastructure: ${issue}`);
  console.log(`  process=${JSON.stringify(result.process)} changedFiles=${JSON.stringify(result.changedFiles)}`);
  console.log(`  observations=${JSON.stringify(result.analysis)}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const credential = resolveDeepseekApiKey(process.env, options.deepseekApiKeyEnv);
  if (!credential) {
    throw new Error(`missing DeepSeek credential in ${deepseekCredentialEnvNames(options.deepseekApiKeyEnv).join(", ")}`);
  }

  let runRootPrepared = false;
  let completedSuccessfully = false;
  try {
    prepareRunRoot(options.runRoot);
    runRootPrepared = true;
    assertAgentDirOwnership(options);
    const openaiCredentialValues = prepareAgentDirectory(options);
    const fixture = createFixture(options.runRoot);
    const environment = prepareDeepseekClaudeE2EEnv(
      minimalE2EEnvironment(process.env, credential),
      {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        runtimeDir: path.join(options.runRoot, "claude-runtime"),
      },
    );
    const deepseekCredentialValues = deepseekCredentialEnvNames(options.deepseekApiKeyEnv)
      .map((name) => process.env[name])
      .filter((value) => typeof value === "string" && value.length > 0);
    const redactions = [...new Set([
      credential,
      ...deepseekCredentialValues,
      ...openaiCredentialValues,
      options.runRoot,
      canonicalPotentialPath(options.runRoot),
      options.agentDir,
      canonicalPotentialPath(options.agentDir),
      options.authAgentDir,
      canonicalPotentialPath(options.authAgentDir),
      options.extension,
      realpathSync(options.extension),
      findPackageRoot(options.extension),
      repoRoot,
      process.env.HOME,
    ].filter((value) => typeof value === "string" && value.length > 0))];
    const selected = SCENARIOS.filter((scenario) => !options.only || options.only.includes(scenario.key));
    console.log("pi-flow prompt-routing E2E observations");
    console.log(`  model: ${ROOT_MODEL}`);
    console.log(`  thinking: ${ROOT_THINKING}`);
    console.log(`  repetitions: ${options.repetitions}`);
    console.log(`  Claude Code provider guard: DeepSeek (${DEEPSEEK_ANTHROPIC_BASE_URL})`);

    const results = [];
    for (const scenario of selected) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        const run = await runPi({
          options,
          fixture,
          scenario,
          repetition,
          environment,
          redactions,
        });
        const analysis = analyzeJsonl(run.stdout);
        const result = {
          scenario: scenario.key,
          repetition,
          durationMs: run.durationMs,
          infrastructureIssues: infrastructureIssues(run, analysis),
          process: {
            code: run.code,
            signal: run.signal,
            timedOut: run.timedOut,
            captureError: run.captureError,
          },
          changedFiles: run.changed,
          analysis: summarizedAnalysis(analysis),
        };
        results.push(result);
        printRun(result);
      }
    }
    const infrastructureFailureCount = results.filter((result) => result.infrastructureIssues.length > 0).length;
    const report = {
      purpose: "Observation only. Routing choices and fixture changes do not affect exit status.",
      model: ROOT_MODEL,
      thinking: ROOT_THINKING,
      repetitions: options.repetitions,
      scenarios: selected.map((scenario) => scenario.key),
      infrastructureFailureCount,
      results,
    };
    writeFileSync(path.join(options.runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nSummary: ${results.length} observation(s), ${infrastructureFailureCount} infrastructure failure(s).`);
    if (infrastructureFailureCount > 0) throw new Error("prompt-routing E2E infrastructure failed");
    completedSuccessfully = true;
  } finally {
    if (runRootPrepared) {
      rmSync(path.join(options.runRoot, "claude-runtime"), { recursive: true, force: true });
      if (options.ownsAgentDir) {
        rmSync(options.agentDir, { recursive: true, force: true });
      }
      if (completedSuccessfully && !options.keep) removeOwnedRunRoot(options.runRoot);
      else if (existsSync(options.runRoot)) console.log("Artifacts kept under the requested run root.");
    }
  }
}

main().catch((error) => {
  console.error(`prompt-routing E2E error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
