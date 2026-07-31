#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
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
import { tmpdir } from "node:os";
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
    model: undefined,
    thinking: undefined,
    repetitions: 2,
    timeoutMs: 300_000,
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    runRoot: path.join(tmpdir(), `pi-flow-prompt-routing-${Date.now()}`),
    agentDir: undefined,
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
    if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--repetitions") options.repetitions = Number(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = value();
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--pi-command") options.piCommand = value();
    else if (arg === "--extension") options.extension = path.resolve(value());
    else if (arg === "--only") options.only = value().split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.help && (!options.model || !options.thinking)) {
    throw new Error("--model and --thinking are required; this E2E intentionally has no encoded model defaults");
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
  console.log(`Usage: node scripts/e2e/prompt-routing.mjs --model <provider/model> --thinking <level> [options]

Runs privacy-safe real-Pi routing scenarios against the current extension prompt.
No profile name, child model, or specialist choice is asserted.

Options:
  --model <provider/model>        required root model
  --thinking <level>              required root thinking level
  --repetitions <1-5>             repetitions per scenario (default: 2)
  --only <key,...>                direct, focused, flat, continuation, staged
  --timeout-ms <ms>               timeout per root run (default: 300000)
  --deepseek-api-key-env <name>   preferred DeepSeek credential variable
  --run-root <dir>                artifact root
  --agent-dir <dir>               isolated Pi agent directory (default: under run root)
  --pi-command <path>             Pi executable (default: PI_E2E_COMMAND or pi)
  --extension <path>              extension entry to evaluate (default: current worktree)
  --keep                          keep artifacts after a passing run
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

function analyzeJsonl(text) {
  const analysis = {
    malformedLines: 0,
    toolCounts: {},
    agentCalls: [],
    workflowCalls: [],
    agentResults: [],
    workflowResults: [],
    rootUsage: {},
    childUsage: {},
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
    if (event.type === "tool_execution_end") {
      if (event.toolName === "Agent" || event.toolName === "workflow") {
        addUsage(analysis.childUsage, event.result?.usage);
      }
      continue;
    }
    if (event.type !== "message_end") continue;
    const message = event.message ?? {};
    if (message.role === "assistant") {
      addUsage(analysis.rootUsage, message.usage);
      const calls = (message.content ?? []).filter((item) => item?.type === "toolCall");
      if (calls.length > 0) group += 1;
      for (const call of calls) {
        analysis.toolCounts[call.name] = (analysis.toolCounts[call.name] ?? 0) + 1;
        const input = call.arguments ?? {};
        if (call.name === "Agent") {
          analysis.agentCalls.push({ group, sessionKey: typeof input.session_key === "string" ? input.session_key : "" });
        } else if (call.name === "workflow") {
          const script = typeof input.script === "string" ? input.script : "";
          analysis.workflowCalls.push({
            group,
            source: script ? "inline" : input.name ? "saved" : "path",
            pipeline: script.includes("pipeline("),
            parallel: script.includes("parallel("),
            schema: /\bschema\s*:/.test(script),
            agentExpressions: (script.match(/\bagent\s*\(/g) ?? []).length,
          });
        }
      }
      if (message.stopReason === "stop") analysis.finalStop = true;
    } else if (message.role === "toolResult") {
      if (message.toolName !== "Agent" && message.toolName !== "workflow") continue;
      const details = message.details ?? {};
      if (message.toolName === "Agent") {
        analysis.agentResults.push({ status: details.status });
      } else {
        analysis.workflowResults.push({
          status: details.status,
          agentCount: details.agentCount,
          childStatuses: Array.isArray(details.agents) ? details.agents.map((agent) => agent.status) : [],
        });
      }
    }
  }
  return analysis;
}

function check(label, ok, info = "", soft = false) {
  return { label, status: ok ? "PASS" : soft ? "INCONCLUSIVE" : "FAIL", info };
}

function commonChecks(run, analysis) {
  return [
    check("Pi process completed", run.code === 0 && !run.timedOut, `code=${run.code} timedOut=${run.timedOut}`),
    check("output stayed within capture bounds", run.captureError === undefined, run.captureError ?? ""),
    check("JSON event stream parsed", analysis.malformedLines === 0, `malformed=${analysis.malformedLines}`),
    check("root produced a final response", analysis.finalStop),
    check("fixture stayed unchanged", run.changed.length === 0, run.changed.join(",")),
  ];
}

function validateDirect(run, analysis) {
  const delegated = analysis.agentCalls.length + analysis.workflowCalls.length;
  const inspected = (analysis.toolCounts.read ?? 0) + (analysis.toolCounts.bash ?? 0);
  return [
    ...commonChecks(run, analysis),
    check("narrow lookup stayed in the root", delegated === 0, `Agent=${analysis.agentCalls.length} workflow=${analysis.workflowCalls.length}`),
    check("root inspected the fixture", inspected > 0, `readOrBash=${inspected}`),
  ];
}

function validateFocused(run, analysis) {
  const routeAllowed = analysis.workflowCalls.length === 0 && analysis.agentCalls.length <= 1;
  const didWork = analysis.agentCalls.length === 1 || (analysis.toolCounts.read ?? 0) + (analysis.toolCounts.bash ?? 0) > 0;
  return [
    ...commonChecks(run, analysis),
    check("focused map used root or one Agent, never workflow", routeAllowed, `Agent=${analysis.agentCalls.length} workflow=${analysis.workflowCalls.length}`),
    check("focused map performed an investigation", didWork),
    check("focused map delegated once", analysis.agentCalls.length === 1, `Agent=${analysis.agentCalls.length}`, true),
  ];
}

function validateFlat(run, analysis) {
  const callsByGroup = new Map();
  for (const call of analysis.agentCalls) callsByGroup.set(call.group, (callsByGroup.get(call.group) ?? 0) + 1);
  const maxParallelGroup = Math.max(0, ...callsByGroup.values());
  const fresh = analysis.agentCalls.every((call) => call.sessionKey === "");
  const done = analysis.agentResults.length === analysis.agentCalls.length && analysis.agentResults.every((result) => result.status === "done");
  return [
    ...commonChecks(run, analysis),
    check("small flat fan-out used direct Agent calls", analysis.agentCalls.length >= 2 && analysis.workflowCalls.length === 0, `Agent=${analysis.agentCalls.length} workflow=${analysis.workflowCalls.length}`),
    check("independent Agent calls were issued together", maxParallelGroup >= 2, `maxGroup=${maxParallelGroup}`),
    check("independent work stayed fresh", fresh),
    check("all direct Agent calls completed", done),
  ];
}

function validateContinuation(run, analysis) {
  const keys = analysis.agentCalls.map((call) => call.sessionKey);
  const groups = new Set(analysis.agentCalls.map((call) => call.group));
  const sameNonEmptyKey = keys.length === 2 && keys[0].length > 0 && keys[0] === keys[1];
  const done = analysis.agentResults.length === 2 && analysis.agentResults.every((result) => result.status === "done");
  return [
    ...commonChecks(run, analysis),
    check("continuation used exactly two Agent calls", analysis.agentCalls.length === 2 && analysis.workflowCalls.length === 0, `Agent=${analysis.agentCalls.length} workflow=${analysis.workflowCalls.length}`),
    check("same logical child reused one non-empty session key", sameNonEmptyKey),
    check("continuation calls were sequential", groups.size === 2, `groups=${groups.size}`),
    check("both continuation calls completed", done),
  ];
}

function validateStaged(run, analysis) {
  const workflow = analysis.workflowCalls.at(-1);
  const result = analysis.workflowResults.at(-1);
  const completedResults = analysis.workflowResults.filter((item) => item.status === "completed");
  const childrenDone = result?.childStatuses.length >= 6 && result.childStatuses.every((status) => status === "done");
  return [
    ...commonChecks(run, analysis),
    check("staged structured task used workflow", analysis.workflowCalls.length >= 1 && analysis.agentCalls.length === 0, `workflow=${analysis.workflowCalls.length} Agent=${analysis.agentCalls.length}`),
    check("successful workflow encoded dependent pipeline stages and schemas", Boolean(workflow?.pipeline && workflow?.schema && workflow?.agentExpressions >= 2), JSON.stringify(workflow ?? {})),
    check("workflow completed at least six child calls", result?.status === "completed" && result?.agentCount >= 6, JSON.stringify(result ?? {})),
    check("all staged children completed", childrenDone),
    check("workflow avoided duplicate successful execution", completedResults.length === 1, `completed=${completedResults.length}`, true),
  ];
}

const SCENARIOS = [
  {
    key: "direct",
    prompt: "Read package.json directly with the root file tools and report only the package name. This is a narrow local lookup; do not delegate it and do not modify files.",
    validate: validateDirect,
  },
  {
    key: "focused",
    prompt: "Map this repository's purpose, key files, runtime flow, and tests. Keep the investigation read-only and give a concise evidence-based summary.",
    validate: validateFocused,
  },
  {
    key: "flat",
    prompt: "Review this repository across three independent dimensions: source correctness, tests and coverage, and documentation and package configuration. Keep this as a small flat fan-out, make no file changes, and synthesize a concise final assessment.",
    validate: validateFlat,
  },
  {
    key: "continuation",
    prompt: "Use one subagent in two sequential turns. First ask it to read src/cli.js and src/report.js, remember the exported function and command-line argument flow, and reply with STEP1_DONE. Then ask that same continuing child, without re-reading files and without copying its first result into the second prompt, to recall the function and flow. Use pi-flow's child-conversation continuation feature, report the second result, and do not modify files.",
    validate: validateContinuation,
  },
  {
    key: "staged",
    prompt: "For each of package.json, src/cli.js, and test/report.test.js, first classify it as config, entry, or test using a strict machine-readable result. Then dispatch a classification-specific follow-up that states its role in one sentence. Different files may proceed concurrently, but each file's classify step must precede its follow-up. Return one object containing all classifications and follow-ups. Keep this read-only.",
    validate: validateStaged,
  },
];

function runPi({ options, fixture, scenario, repetition, environment, redactions }) {
  const runDir = path.join(options.runRoot, "runs", `${scenario.key}-${repetition}`);
  ensureDir(runDir);
  const args = [
    "-p",
    "--mode", "json",
    "--model", options.model,
    "--thinking", options.thinking,
    "--no-session",
    "--no-extensions",
    "--extension", options.extension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--tools", "read,bash,Agent,workflow",
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
        if (event.type === "message_end" || event.type === "tool_execution_end") {
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
        stdout = redactSecrets(stdout, redactions);
        stderr = redactSecrets(stderr, redactions);
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
  const keys = analysis.agentCalls.map((call) => call.sessionKey).filter(Boolean);
  return {
    toolCounts: analysis.toolCounts,
    agentCallCount: analysis.agentCalls.length,
    agentCallGroups: analysis.agentCalls.map((call) => call.group),
    sessionKeyState: keys.length === 0 ? "none" : new Set(keys).size === 1 ? "same" : "different",
    workflowCalls: analysis.workflowCalls,
    agentResults: analysis.agentResults,
    workflowResults: analysis.workflowResults,
    rootUsage: analysis.rootUsage,
    childUsage: analysis.childUsage,
  };
}

function printRun(result) {
  const failed = result.checks.filter((item) => item.status === "FAIL").length;
  const inconclusive = result.checks.filter((item) => item.status === "INCONCLUSIVE").length;
  const status = failed > 0 ? "FAIL" : inconclusive > 0 ? "INCONCLUSIVE" : "PASS";
  console.log(`\n[${status}] ${result.scenario} repetition ${result.repetition} (${(result.durationMs / 1000).toFixed(1)}s)`);
  for (const item of result.checks) {
    const marker = item.status === "PASS" ? "✓" : item.status === "FAIL" ? "✗" : "•";
    console.log(`  ${marker} ${item.label}${item.info ? ` (${item.info})` : ""}`);
  }
  console.log(`  tools=${JSON.stringify(result.analysis.toolCounts)} usage=${JSON.stringify({ root: result.analysis.rootUsage, child: result.analysis.childUsage })}`);
  return { failed, inconclusive };
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
    ensureDir(options.agentDir);
    const fixture = createFixture(options.runRoot);
    const environment = prepareDeepseekClaudeE2EEnv(
      minimalE2EEnvironment(process.env, credential),
      {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        runtimeDir: path.join(options.runRoot, "claude-runtime"),
      },
    );
    const credentialValues = deepseekCredentialEnvNames(options.deepseekApiKeyEnv)
      .map((name) => process.env[name])
      .filter((value) => typeof value === "string" && value.length > 0);
    const redactions = [...new Set([
      credential,
      ...credentialValues,
      options.runRoot,
      canonicalPotentialPath(options.runRoot),
      options.agentDir,
      canonicalPotentialPath(options.agentDir),
      options.extension,
      realpathSync(options.extension),
      findPackageRoot(options.extension),
      repoRoot,
      process.env.HOME,
    ].filter((value) => typeof value === "string" && value.length > 0))];
    const selected = SCENARIOS.filter((scenario) => !options.only || options.only.includes(scenario.key));
    console.log("pi-flow prompt-routing E2E");
    console.log(`  model: ${options.model}`);
    console.log(`  thinking: ${options.thinking}`);
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
        const checks = scenario.validate(run, analysis);
        const result = {
          scenario: scenario.key,
          repetition,
          durationMs: run.durationMs,
          checks,
          analysis: summarizedAnalysis(analysis),
        };
        results.push(result);
        printRun(result);
      }
    }
    const failedChecks = results.flatMap((result) => result.checks).filter((item) => item.status === "FAIL").length;
    const inconclusiveChecks = results.flatMap((result) => result.checks).filter((item) => item.status === "INCONCLUSIVE").length;
    const report = {
      model: options.model,
      thinking: options.thinking,
      repetitions: options.repetitions,
      scenarios: selected.map((scenario) => scenario.key),
      failedChecks,
      inconclusiveChecks,
      results,
    };
    writeFileSync(path.join(options.runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(`\nSummary: ${results.length} run(s), ${failedChecks} failed check(s), ${inconclusiveChecks} inconclusive check(s).`);
    if (failedChecks > 0) throw new Error("prompt-routing E2E failed");
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
  console.error(`FAIL prompt-routing E2E: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
