#!/usr/bin/env node
// The run uses the caller's real ~/.pi/agent config (so provider/model resolution
// and saved-workflow roots match production). It writes a temp fixture + sessions
// under an OS temp dir and prints PASS/FAIL/INCONCLUSIVE per check.

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  buildDeepseekClaudeEnv,
  loadDotEnv,
  prepareDeepseekClaudeE2EEnv,
} from "./lib/deepseek-claude-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = path.join(repoRoot, "index.ts");

loadDotEnv(path.join(repoRoot, ".env"));

function parseArgs(argv) {
  const options = {
    model: "deepseek/deepseek-v4-flash",
    thinking: "high",
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    sessionRoot: path.join(tmpdir(), `pi-wf-features-${Date.now()}`),
    agentDir: process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = value();
    else if (arg === "--session-root") options.sessionRoot = path.resolve(value());
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--only") options.only = value();
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function slug(text) {
  return text.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "model";
}

function createFixture(root) {
  const fx = path.join(root, "fixture");
  ensureDir(path.join(fx, "src"));
  ensureDir(path.join(fx, "test"));
  ensureDir(path.join(fx, "scripts"));
  const files = {
    "package.json": JSON.stringify(
      {
        name: "widget-cli",
        version: "0.2.0",
        description: "A tiny CLI that formats widget reports.",
        type: "module",
        bin: { widget: "./src/cli.js" },
        scripts: { build: "node scripts/build.js", test: "node --test" },
        dependencies: { kleur: "^4.1.5" },
      },
      null,
      2,
    ),
    "README.md": "# widget-cli\n\nFormats widget reports from a JSON file.\n",
    "src/cli.js":
      'import { formatReport } from "./report.js";\nimport { loadWidgets } from "./store.js";\nconst widgets = loadWidgets(process.argv[2]);\nprocess.stdout.write(formatReport(widgets));\n',
    "src/report.js":
      'import kleur from "kleur";\nexport function formatReport(widgets) {\n  return widgets.map((w) => `${kleur.bold(w.name)}: ${w.score}`).join("\\n") + "\\n";\n}\n',
    "src/store.js":
      'import { readFileSync } from "node:fs";\nexport function loadWidgets(path) {\n  if (!path) return [];\n  return JSON.parse(readFileSync(path, "utf8"));\n}\n',
    "test/report.test.js":
      'import { test } from "node:test";\nimport assert from "node:assert";\nimport { formatReport } from "../src/report.js";\ntest("formats", () => { assert.ok(formatReport([{ name: "a", score: 1 }]).includes("a")); });\n',
    "scripts/build.js": 'console.log("nothing to build");\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    writeFileSync(path.join(fx, rel), content);
  }
  return fx;
}

// Avoid backticks so these verbatim workflow scripts embed cleanly in prompts.
const KITCHEN_SINK = `export const meta = {
  name: "feature_probe",
  description: "Probe parallel, pipeline, phase, log, args, cwd, structured output, and plain-text agents.",
  phases: [{ title: "collect" }, { title: "refine" }]
};
log("probe-args:" + JSON.stringify(args));
log("probe-cwd:" + cwd);
phase("collect");
const targets = args.files;
const analyzed = await parallel(targets.map(function (f) {
  return function () {
    return agent("Read the file " + f + " in this repository and analyze it. Report the file path and the number of exported symbols.", {
      label: "analyze:" + f,
      phase: "collect",
      schema: { type: "object", additionalProperties: false, required: ["file", "exportCount"], properties: { file: { type: "string" }, exportCount: { type: "number" } } }
    });
  };
}));
phase("refine");
const refined = await pipeline(analyzed,
  function (a, original, i) {
    return agent("In one short sentence, describe what the file " + (a && a.file) + " does. Plain text only, no preamble.", { label: "describe:" + i, phase: "refine" });
  },
  function (sentence, original) {
    return { file: original.file, exportCount: original.exportCount, sentence: String(sentence).trim() };
  }
);
return { repo: args.repo, cwd: cwd, count: refined.length, items: refined };`;

const KITCHEN_SINK_ARGS = { repo: "widget-cli", files: ["src/report.js", "src/store.js"] };

const CONCURRENCY_PROBE = `export const meta = { name: "concurrency_probe", description: "Spawn more agents than the shared concurrency cap to verify queue-and-drain." };
const out = await parallel([0, 1, 2, 3].map(function (n) {
  return function () {
    return agent("Reply with exactly this text and nothing else: token-" + n, { label: "slot:" + n });
  };
}));
return { count: out.filter(function (x) { return x !== null; }).length, tokens: out };`;

const NONDET_PROBE = `export const meta = { name: "nondet_probe", description: "Intentionally nondeterministic; must be rejected before any subagent runs." };
const stamp = Date.now();
const reply = await agent("say hi", { label: "greet" });
return { stamp: stamp, reply: reply };`;

const SAVED_WORKFLOW = `export const meta = { name: "zz_e2e_saved_probe", description: "E2E saved-workflow probe: greet via one subagent and echo a token." };
const reply = await agent("Reply with exactly this text and nothing else: saved-workflow-ok", { label: "greet" });
return { reply: String(reply).trim() };`;

const SAVED_WORKFLOW_NAME = "zz_e2e_saved_probe";

// Control-flow scripts: the script BRANCHES on a structured (schema-validated)
// result, so these test structured output as control flow, not just a return
// type. Branches are gated on an unambiguous fixture fact (does the file import
// kleur?) so the taken branch is deterministic despite model nondeterminism:
//   src/report.js -> imports kleur (true);  src/store.js, src/cli.js -> false.
const BRANCH_PROBE = `export const meta = { name: "branch_probe", description: "Per-file structured boolean gates a conditional deep-dive subagent." };
const files = args.files;
const flags = await parallel(files.map(function (f) {
  return function () {
    return agent("Does the file " + f + " import the 'kleur' package? Answer strictly from its source.", {
      label: "flag:" + f,
      schema: { type: "object", additionalProperties: false, required: ["file", "importsKleur"], properties: { file: { type: "string" }, importsKleur: { type: "boolean" } } }
    });
  };
}));
const deepDived = [];
for (const r of flags) {
  if (r && r.importsKleur === true) {
    const note = await agent("In one short sentence, say what " + r.file + " uses kleur for. Plain text only.", { label: "deep:" + r.file });
    deepDived.push({ file: r.file, note: String(note).trim() });
  }
}
return { flags: flags, deepDived: deepDived.map(function (d) { return d.file; }), deep: deepDived };`;

const GATE_PROBE = `export const meta = { name: "gate_probe", description: "Filter files by a structured boolean; gate or early-exit on the survivor set." };
const files = args.files;
const flags = await parallel(files.map(function (f) {
  return function () {
    return agent("Does " + f + " import the 'kleur' package? Answer strictly from its source.", {
      label: "scan:" + f,
      schema: { type: "object", additionalProperties: false, required: ["file", "importsKleur"], properties: { file: { type: "string" }, importsKleur: { type: "boolean" } } }
    });
  };
}));
const survivors = flags.filter(function (r) { return r && r.importsKleur === true; });
if (survivors.length === 0) {
  log("gate: zero survivors, early exit");
  return { survivors: [], summarized: 0, earlyExit: true };
}
const summaries = await parallel(survivors.map(function (r) {
  return function () { return agent("One short sentence describing " + r.file + ". Plain text only.", { label: "sum:" + r.file }); };
}));
return { survivors: survivors.map(function (r) { return r.file; }), summarized: summaries.filter(Boolean).length, earlyExit: false };`;

const ROUTE_PROBE = `export const meta = { name: "route_probe", description: "Classify a file into an enum, then dispatch to a kind-specific follow-up." };
const target = args.file;
const c = await agent("Classify " + target + " as exactly one of: entry (a CLI entry point, e.g. reads process.argv or is declared as a bin), lib (an imported helper module), or test (a test file). Judge strictly from its source and role.", {
  label: "classify",
  schema: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: ["entry", "lib", "test"] } } }
});
let follow;
if (c && c.kind === "entry") follow = await agent("List the command-line argument(s) " + target + " reads. Plain text only.", { label: "route:entry" });
else if (c && c.kind === "lib") follow = await agent("Name the function(s) " + target + " exports. Plain text only.", { label: "route:lib" });
else follow = await agent("Name the test runner " + target + " uses. Plain text only.", { label: "route:test" });
return { kind: c && c.kind, follow: String(follow).trim() };`;

// Discoverability: a natural-language task that REQUIRES branching on a typed
// per-file boolean, with NO mention of schema/structured_output. If the model
// reaches for agent({ schema }) on its own, the per-file scan agents return
// objects in the journal; if it hand-parses text, they return strings.
const DISCOVERABILITY_PROMPT = [
  "Use the workflow tool to orchestrate this. For each source file in src/ (src/cli.js, src/report.js, src/store.js),",
  "determine whether the file imports the \"kleur\" package. Then, ONLY for the files that DO import kleur, fan out a",
  "follow-up subagent that explains in one sentence how kleur is used there. Finally return an object listing which",
  "files imported kleur and the follow-up explanations. The script must decide which follow-ups to spawn based on the",
  "per-file import result. Do not change any files.",
].join(" ");

// Per-session wall-clock cap. Upstream providers occasionally stall on first
// token; a stuck session must not block the whole suite, so we SIGTERM/SIGKILL
// and let the scenario assert on whatever was persisted (usually nothing -> a
// clean FAIL on "model invoked the workflow tool" rather than a hang).
const DEFAULT_PI_TIMEOUT_MS = 8 * 60 * 1000;

function runPi({ model, thinking, deepseekApiKeyEnv, agentDir, cwd, sessionDir, sessionId, prompt, extension, timeoutMs = DEFAULT_PI_TIMEOUT_MS }) {
  ensureDir(sessionDir);
  const promptPath = path.join(sessionDir, "prompt.md");
  writeFileSync(promptPath, `${prompt}\n`);
  const args = [
    "-p",
    "--mode",
    "json",
    "--model",
    model,
    "--thinking",
    thinking,
    "--session-dir",
    sessionDir,
    "--session-id",
    sessionId,
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-skills",
    "--no-extensions",
    "--extension",
    extension,
    `@${promptPath}`,
  ];
  const stdoutPath = path.join(sessionDir, "stdout.txt");
  const stderrPath = path.join(sessionDir, "stderr.txt");
  return new Promise((resolve, reject) => {
    const out = createWriteStream(stdoutPath, { flags: "a" });
    const err = createWriteStream(stderrPath, { flags: "a" });
    const e2eEnv = prepareDeepseekClaudeE2EEnv(process.env, {
      apiKeyEnv: deepseekApiKeyEnv,
      runtimeDir: path.join(sessionDir, "claude-runtime"),
    });
    const child = spawn("pi", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...e2eEnv, PI_CODING_AGENT_DIR: agentDir },
    });
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    let timedOut = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (c) => out.write(c));
    child.stderr.on("data", (c) => err.write(c));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      out.end();
      err.end();
      rmSync(path.join(sessionDir, "claude-runtime"), { recursive: true, force: true });
      const outcome = { exitCode, stdoutPath, stderrPath, timedOut };
      if (spawnError) {
        reject(new Error(`pi session ${sessionId} failed to start: ${spawnError.message}; stdout=${stdoutPath}; stderr=${stderrPath}`));
        return;
      }
      if (timedOut) {
        reject(new Error(`pi session ${sessionId} timed out after ${Math.round(timeoutMs / 1000)}s; stdout=${stdoutPath}; stderr=${stderrPath}`));
        return;
      }
      if (exitCode !== 0) {
        reject(new Error(`pi session ${sessionId} exited with code ${exitCode}; stdout=${stdoutPath}; stderr=${stderrPath}`));
        return;
      }
      resolve(outcome);
    });
  });
}

function findNewestJsonl(dir) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f))
    .sort();
  return files.at(-1);
}

function readJsonlRecords(filePath) {
  if (!filePath || !existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

const EDIT_TOOLS = new Set(["edit", "write", "apply_patch", "multiedit"]);

function parseEnvelope(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function analyzeSession(sessionDir) {
  const file = findNewestJsonl(sessionDir);
  const toolCalls = {};
  let fileEdits = 0;
  const accepted = [];
  const notifications = [];
  for (const r of readJsonlRecords(file)) {
    const m = r.message ?? (r.type === "custom_message" ? { role: "custom", ...r } : undefined);
    const content = Array.isArray(m?.content) ? m.content : [];
    for (const it of content) {
      if (it?.type === "toolCall" && typeof it.name === "string") {
        toolCalls[it.name] = (toolCalls[it.name] ?? 0) + 1;
        if (EDIT_TOOLS.has(it.name)) fileEdits += 1;
      }
    }
    if (m?.role === "toolResult" && m.toolName === "workflow") {
      const envelope = parseEnvelope(m.details) ?? parseEnvelope(m.content?.[0]?.text);
      if (envelope?.task_type === "workflow" && envelope.status === "accepted") accepted.push(envelope);
    }
    if (m?.role === "custom" && m.customType === "pi-flow-task-notification") {
      const envelope = parseEnvelope(m.details) ?? parseEnvelope(m.content);
      if (envelope?.task_type === "workflow") notifications.push(envelope);
    }
  }
  const launch = accepted.at(-1);
  const terminal = launch && notifications.find((item) => item.task_id === launch.task_id);
  return { sessionFile: file, toolCalls, fileEdits, workflow: launch ? { accepted: launch, terminal } : undefined };
}

function workflowDirForSessionFile(sessionFile) {
  if (!sessionFile) return undefined;
  return path.join(path.dirname(sessionFile), `${path.basename(sessionFile, path.extname(sessionFile))}.workflows`);
}

function journalPathFor(sessionFile, taskId) {
  const dir = workflowDirForSessionFile(sessionFile);
  return dir && taskId ? path.join(dir, `task-${taskId}.jsonl`) : undefined;
}

function readJournal(sessionFile, taskId) {
  const journalPath = journalPathFor(sessionFile, taskId);
  if (!journalPath || !existsSync(journalPath)) return undefined;
  const agentResults = [];
  let taskComplete;
  let taskError;
  let taskStart;
  for (const entry of readJsonlRecords(journalPath)) {
    if (entry.type === "task_start") taskStart = entry;
    else if (entry.type === "agent_result") agentResults[entry.index - 1] = entry;
    else if (entry.type === "task_complete") taskComplete = entry;
    else if (entry.type === "task_error") taskError = entry;
  }
  return { path: journalPath, taskStart, agentResults: agentResults.filter(Boolean), taskComplete, taskError };
}

function resultFromNotification(notification) {
  if (!notification || typeof notification.content !== "string") return undefined;
  try {
    return JSON.parse(notification.content);
  } catch {
    return notification.content;
  }
}

function observeWorkflow(s, session) {
  const accepted = session.workflow?.accepted;
  const terminal = session.workflow?.terminal;
  if (!accepted) {
    s.check("workflow accepted result present", false, "no accepted workflow toolResult");
    return undefined;
  }
  s.check(
    "accepted envelope is compact",
    JSON.stringify(Object.keys(accepted).sort()) === JSON.stringify(["name", "status", "task_id", "task_type"]),
    JSON.stringify(accepted),
  );
  s.check("status === accepted", accepted.status === "accepted", `status=${accepted.status}`);
  s.check(
    "terminal notification correlates by task_id",
    terminal?.task_id === accepted.task_id && terminal?.task_type === "workflow",
    JSON.stringify(terminal),
  );
  s.check(
    "terminal envelope is compact",
    JSON.stringify(Object.keys(terminal ?? {}).sort()) === JSON.stringify(["content", "name", "status", "task_id", "task_type"]),
    JSON.stringify(terminal),
  );
  return {
    accepted,
    terminal,
    journal: readJournal(session.sessionFile, accepted.task_id),
    result: resultFromNotification(terminal),
  };
}

function inlinePrompt(script, args) {
  return [
    "Use the workflow tool now. Call it with the `script` parameter set to EXACTLY the following JavaScript, verbatim - do not modify it, do not wrap it in markdown fences.",
    args ? `Also set the tool's \`args\` parameter to this JSON value: ${JSON.stringify(args)}` : "",
    "Do not change any files in the repository.",
    "",
    "script:",
    script,
  ]
    .filter(Boolean)
    .join("\n");
}

function savedNamePrompt(name) {
  return [
    `Use the workflow tool to run the saved workflow named "${name}".`,
    `Call the workflow tool with { name: "${name}" } and no other source.`,
    "Then report the result it returns.",
  ].join("\n");
}

function resumePrompt(taskId, args) {
  return [
    "Replay the feature_probe workflow from its persisted task journal and reuse its cached results.",
    "Call the workflow tool with these exact parameters and no scriptPath:",
    `- resumeFromTaskId: "${taskId}"`,
    `- args: ${JSON.stringify(args)}`,
    "Wait for the matching terminal task notification, then report its result.",
  ].join("\n");
}

function makeScenario(name) {
  const checks = [];
  return {
    name,
    checks,
    check(label, ok, info = "") {
      checks.push({ label, status: ok ? "PASS" : "FAIL", info });
    },
    soft(label, ok, info = "") {
      checks.push({ label, status: ok ? "PASS" : "INCONCLUSIVE", info });
    },
  };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

async function scenarioKitchenSink(ctx) {
  const s = makeScenario("kitchen-sink (parallel + pipeline + schema + plain-text + globals + persistence)");
  const sessionDir = path.join(ctx.sessionRoot, "kitchen-sink");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-kitchen`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(KITCHEN_SINK, KITCHEN_SINK_ARGS),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  s.check("no files were edited", a.fileEdits === 0, `edits=${a.fileEdits}`);
  const wf = observeWorkflow(s, a);
  if (!wf) return { scenario: s };
  s.check("status === completed", wf.terminal?.status === "completed", `status=${wf.terminal?.status}`);
  s.check("terminal name === feature_probe (script ran verbatim)", wf.terminal?.name === "feature_probe", `name=${wf.terminal?.name}`);
  s.check("task journal exists", Boolean(wf.journal), wf.journal?.path ?? "missing");
  s.check("journal task_start correlates with accepted task", wf.journal?.taskStart?.taskId === wf.accepted.task_id, JSON.stringify(wf.journal?.taskStart));
  s.check("persisted script exists", isNonEmptyString(wf.journal?.taskStart?.scriptPath) && existsSync(wf.journal.taskStart.scriptPath), wf.journal?.taskStart?.scriptPath ?? "");
  s.check("journal records task_complete", Boolean(wf.journal?.taskComplete) && !wf.journal?.taskError, JSON.stringify(wf.journal?.taskError));
  s.check("journal records 4 agent results", wf.journal?.agentResults.length === 4, `agentResults=${wf.journal?.agentResults.length}`);

  const collect = (wf.journal?.agentResults ?? []).filter((r) => r.phase === "collect");
  const structuredOk = collect.some(
    (r) => r.result && typeof r.result === "object" && typeof r.result.exportCount === "number",
  );
  s.check("structured output validated + captured (numeric exportCount)", structuredOk, JSON.stringify(collect.map((r) => r.result)));
  const result = wf.result;
  const items = Array.isArray(result?.items) ? result.items : [];
  s.check(
    "terminal result preserves args and cwd globals",
    result?.repo === "widget-cli" && path.basename(result?.cwd ?? "") === path.basename(ctx.fixture),
    JSON.stringify({ repo: result?.repo, cwd: result?.cwd }),
  );
  s.check("pipeline produced items with plain-text sentences", items.length >= 1 && items.every((it) => isNonEmptyString(it.sentence)), JSON.stringify(items));
  s.check("return value synthesized (count matches items)", result?.count === items.length && items.length >= 1, JSON.stringify({ count: result?.count, items: items.length }));

  ctx.kitchen = { sessionDir, sessionId: `${ctx.idBase}-kitchen`, taskId: wf.accepted.task_id, result };
  return { scenario: s };
}

async function scenarioConcurrency(ctx) {
  const s = makeScenario("concurrency queue-and-drain (fan-out 4 under cap 2)");
  const sessionDir = path.join(ctx.sessionRoot, "concurrency");
  // Wrapper extension pins the shared cap to 2 so a 4-wide fan-out must queue.
  const wrapper = path.join(ctx.sessionRoot, "low-concurrency-extension.ts");
  writeFileSync(
    wrapper,
    `import { createSubagentExtension } from ${JSON.stringify(extensionPath)};\nexport default createSubagentExtension({ maxConcurrentSubagents: 2 });\n`,
  );
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-concurrency`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(CONCURRENCY_PROBE, undefined),
    extension: wrapper,
  });
  const a = analyzeSession(sessionDir);
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  const wf = observeWorkflow(s, a);
  if (!wf) return { scenario: s };
  s.check("status === completed", wf.terminal?.status === "completed", `status=${wf.terminal?.status}`);
  s.check("journal records all 4 queued agents", wf.journal?.agentResults.length === 4, `agentResults=${wf.journal?.agentResults.length}`);
  s.check("journal records task_complete", Boolean(wf.journal?.taskComplete), JSON.stringify(wf.journal?.taskError));
  s.check("terminal result.count === 4", wf.result?.count === 4, JSON.stringify(wf.result));
  return { scenario: s };
}

async function scenarioDeterminism(ctx) {
  const s = makeScenario("determinism rejection (Date.now() refused at parse)");
  const sessionDir = path.join(ctx.sessionRoot, "determinism");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-determinism`,
    cwd: ctx.fixture,
    prompt: `${inlinePrompt(NONDET_PROBE, undefined)}\n\nIf the tool rejects the script, just report the exact error message it returned.`,
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  if (!a.workflow) {
    s.soft("workflow tool was invoked with the verbatim script", false, "model may have refused to run a nondeterministic script");
    return { scenario: s };
  }
  const wf = observeWorkflow(s, a);
  if (!wf) return { scenario: s };
  if (wf.terminal?.status === "completed") {
    s.soft("script ran verbatim (Date.now preserved)", false, "model likely sanitized Date.now(); cannot assert rejection");
    return { scenario: s };
  }
  s.check("status === failed", wf.terminal?.status === "failed", `status=${wf.terminal?.status}`);
  s.check("failure content names determinism", /deterministic|Date\.now|Math\.random/i.test(wf.terminal?.content ?? ""), wf.terminal?.content ?? "");
  s.check("no task journal was started before parse rejection", wf.journal === undefined, wf.journal?.path ?? "unexpected journal");
  return { scenario: s };
}

async function scenarioSavedName(ctx) {
  const s = makeScenario("saved-workflow registry via { name }");
  const workflowsDir = path.join(ctx.agentDir, "workflows");
  const savedFile = path.join(workflowsDir, `${SAVED_WORKFLOW_NAME}.js`);
  const dirPreexisted = existsSync(workflowsDir);
  const filePreexisted = existsSync(savedFile);
  if (filePreexisted) {
    s.soft("saved-workflow fixture slot is free", false, `refusing to overwrite existing ${savedFile}`);
    return { scenario: s };
  }
  ensureDir(workflowsDir);
  writeFileSync(savedFile, SAVED_WORKFLOW);
  try {
    const sessionDir = path.join(ctx.sessionRoot, "saved-name");
    await runPi({
      ...ctx.run,
      sessionDir,
      sessionId: `${ctx.idBase}-saved`,
      cwd: ctx.fixture,
      prompt: savedNamePrompt(SAVED_WORKFLOW_NAME),
      extension: extensionPath,
    });
    const a = analyzeSession(sessionDir);
    s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
    const wf = observeWorkflow(s, a);
    if (!wf) return { scenario: s };
    s.check("status === completed", wf.terminal?.status === "completed", `status=${wf.terminal?.status}`);
    s.check("journal source === saved (loaded from registry)", wf.journal?.taskStart?.source === "saved", `source=${wf.journal?.taskStart?.source}`);
    s.check("name === zz_e2e_saved_probe", wf.terminal?.name === SAVED_WORKFLOW_NAME, `name=${wf.terminal?.name}`);
    s.check("journal records one agent result", wf.journal?.agentResults.length === 1, `agentResults=${wf.journal?.agentResults.length}`);
    s.check("result.reply echoes saved-workflow-ok", isNonEmptyString(wf.result?.reply) && wf.result.reply.includes("saved-workflow-ok"), JSON.stringify(wf.result));
    return { scenario: s };
  } finally {
    rmSync(savedFile, { force: true });
    if (!dirPreexisted) rmSync(workflowsDir, { recursive: true, force: true });
  }
}

async function scenarioResume(ctx) {
  const s = makeScenario("resume-by-replay via { resumeFromTaskId }");
  if (!ctx.kitchen) {
    s.check("kitchen-sink task available to resume", false, "kitchen-sink scenario did not persist a task");
    return { scenario: s };
  }
  const sessionDir = ctx.kitchen.sessionDir;
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: ctx.kitchen.sessionId,
    cwd: ctx.fixture,
    prompt: resumePrompt(ctx.kitchen.taskId, KITCHEN_SINK_ARGS),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  s.check("model invoked the workflow tool for resume", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  const wf = observeWorkflow(s, a);
  if (!wf) return { scenario: s };
  s.check("status === completed", wf.terminal?.status === "completed", `status=${wf.terminal?.status}`);
  s.check("journal links resumeFromTaskId", wf.journal?.taskStart?.resumeFromTaskId === ctx.kitchen.taskId, JSON.stringify(wf.journal?.taskStart));
  const cachedAll = (wf.journal?.agentResults ?? []).length === 4 && wf.journal.agentResults.every((r) => r.cached === true);
  s.check("journal marks every agent_result cached", cachedAll, JSON.stringify((wf.journal?.agentResults ?? []).map((r) => r.cached)));
  s.check(
    "replayed terminal result equals original run",
    JSON.stringify(wf.result) === JSON.stringify(ctx.kitchen.result),
    `replayed=${JSON.stringify(wf.result)?.slice(0, 160)}`,
  );
  return { scenario: s };
}

// Conditional branch: a structured boolean per file gates a deep-dive subagent.
// Assertions verify the script's control flow is INTERNALLY CONSISTENT with its
// own structured data (branch follows the flags it captured), independent of the
// model's classification accuracy (checked softly).
async function scenarioBranch(ctx) {
  const s = makeScenario("conditional branch on structured output (deep-dive only when flag is true)");
  const sessionDir = path.join(ctx.sessionRoot, "branch");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-branch`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(BRANCH_PROBE, { files: ["src/report.js", "src/store.js"] }),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  const wf = observeWorkflow(s, a);
  if (!wf) return { scenario: s };
  s.check("status === completed", wf.terminal?.status === "completed", `status=${wf.terminal?.status}`);
  const labels = (wf.journal?.agentResults ?? []).map((r) => r.label);
  const result = wf.result;
  const flags = Array.isArray(result?.flags) ? result.flags : [];
  s.check("per-file results are schema objects with boolean importsKleur", flags.length === 2 && flags.every((f) => f && typeof f.importsKleur === "boolean"), JSON.stringify(flags));
  const expectedDeep = flags.filter((f) => f && f.importsKleur === true).map((f) => f.file);
  const deepDived = Array.isArray(result?.deepDived) ? result.deepDived : [];
  s.check(
    "branch followed the structured flags (deepDived === files flagged true)",
    JSON.stringify([...deepDived].sort()) === JSON.stringify([...expectedDeep].sort()),
    JSON.stringify({ deepDived, expectedDeep }),
  );
  s.check(
    "journal count === 2 scans + 1-per-true-flag deep-dive",
    wf.journal?.agentResults.length === 2 + expectedDeep.length,
    `agentResults=${wf.journal?.agentResults.length} expected=${2 + expectedDeep.length}`,
  );
  s.check(
    "deep-dive labels exist only for flagged files",
    expectedDeep.every((file) => labels.some((l) => l.startsWith("deep:") && l.includes(path.basename(file)))) &&
      labels.filter((l) => l.startsWith("deep:")).length === expectedDeep.length,
    JSON.stringify(labels),
  );
  const reportFlag = flags.find((f) => String(f?.file).includes("report.js"));
  const storeFlag = flags.find((f) => String(f?.file).includes("store.js"));
  s.soft("model classified the fixture correctly (report=true, store=false)", reportFlag?.importsKleur === true && storeFlag?.importsKleur === false, JSON.stringify({ reportFlag, storeFlag }));
  return { scenario: s };
}

async function scenarioGate(ctx) {
  const s = makeScenario("filter/gate on structured output + zero-count early exit");

  const sessionA = path.join(ctx.sessionRoot, "gate-survivors");
  await runPi({
    ...ctx.run,
    sessionDir: sessionA,
    sessionId: `${ctx.idBase}-gate-a`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(GATE_PROBE, { files: ["src/cli.js", "src/report.js", "src/store.js"] }),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionA);
  const wfA = observeWorkflow(s, a);
  if (wfA) {
    s.check("[survivors] status === completed", wfA.terminal?.status === "completed", `status=${wfA.terminal?.status}`);
    const resA = wfA.result;
    const survivors = Array.isArray(resA?.survivors) ? resA.survivors : [];
    s.check(
      "[survivors] gate kept exactly the flagged files; summarized count matches",
      resA?.earlyExit === false && resA?.summarized === survivors.length && survivors.length >= 1,
      JSON.stringify(resA),
    );
    s.check(
      "[survivors] journal count === 3 scans + 1 per survivor",
      wfA.journal?.agentResults.length === 3 + survivors.length,
      `agentResults=${wfA.journal?.agentResults.length} survivors=${survivors.length}`,
    );
    s.soft("[survivors] survivor set includes report.js", survivors.some((f) => String(f).includes("report.js")), JSON.stringify(survivors));
  }

  const sessionB = path.join(ctx.sessionRoot, "gate-empty");
  await runPi({
    ...ctx.run,
    sessionDir: sessionB,
    sessionId: `${ctx.idBase}-gate-b`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(GATE_PROBE, { files: ["src/store.js"] }),
    extension: extensionPath,
  });
  const b = analyzeSession(sessionB);
  const wfB = observeWorkflow(s, b);
  if (wfB) {
    s.check("[empty] status === completed", wfB.terminal?.status === "completed", `status=${wfB.terminal?.status}`);
    const resB = wfB.result;
    if (resB?.earlyExit === true) {
      s.check("[empty] early-exit path: 0 summarized, only the scan agent ran", resB.summarized === 0 && wfB.journal?.agentResults.length === 1, JSON.stringify({ res: resB, agentResults: wfB.journal?.agentResults.length }));
    } else {
      s.soft("[empty] expected zero survivors but model flagged store.js as importing kleur", false, JSON.stringify(resB));
    }
  }
  return { scenario: s };
}

async function scenarioRoute(ctx) {
  const s = makeScenario("route/dispatch on a structured enum");
  const sessionDir = path.join(ctx.sessionRoot, "route");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-route`,
    cwd: ctx.fixture,
    prompt: inlinePrompt(ROUTE_PROBE, { file: "src/cli.js" }),
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  const wf = observeWorkflow(s, a);
  if (!wf) return { scenario: s };
  s.check("status === completed", wf.terminal?.status === "completed", `status=${wf.terminal?.status}`);
  const labels = (wf.journal?.agentResults ?? []).map((r) => r.label);
  const result = wf.result;
  s.check("classified kind is in the enum", ["entry", "lib", "test"].includes(result?.kind), `kind=${result?.kind}`);
  const ranRoutes = labels.filter((l) => l.startsWith("route:"));
  s.check(
    "dispatched to exactly the classified kind (one route taken)",
    ranRoutes.length === 1 && ranRoutes[0] === `route:${result?.kind}`,
    JSON.stringify({ kind: result?.kind, ranRoutes }),
  );
  s.check("journal records classify + one follow-up", wf.journal?.agentResults.length === 2, `agentResults=${wf.journal?.agentResults.length}`);
  s.soft("classified src/cli.js as entry", result?.kind === "entry", `kind=${result?.kind}`);
  return { scenario: s };
}

// Discoverability: natural language, NO schema hint. Detects whether the model
// reached for agent({ schema }) by checking if per-file decisions came back as
// structured objects (vs hand-parsed text) in the journal. Soft by design.
async function scenarioDiscoverability(ctx) {
  const s = makeScenario("schema discoverability from natural language (no hint)");
  const sessionDir = path.join(ctx.sessionRoot, "discoverability");
  await runPi({
    ...ctx.run,
    sessionDir,
    sessionId: `${ctx.idBase}-discover`,
    cwd: ctx.fixture,
    prompt: DISCOVERABILITY_PROMPT,
    extension: extensionPath,
  });
  const a = analyzeSession(sessionDir);
  s.check("model invoked the workflow tool", (a.toolCalls.workflow ?? 0) >= 1, JSON.stringify(a.toolCalls));
  const wf = observeWorkflow(s, a);
  if (!wf || wf.terminal?.status !== "completed") {
    s.soft("workflow completed", false, `status=${wf?.terminal?.status ?? "none"} content=${wf?.terminal?.content ?? ""}`);
    return { scenario: s };
  }
  const agentResults = wf.journal?.agentResults ?? [];
  const usedSchema = agentResults.some((r) => r.result && typeof r.result === "object" && !Array.isArray(r.result));
  s.soft(
    "model reached for agent({ schema }) on its own (structured result objects in journal)",
    usedSchema,
    JSON.stringify(agentResults.map((r) => ({ label: r.label, resultType: Array.isArray(r.result) ? "array" : typeof r.result }))),
  );
  return { scenario: s };
}

function printScenario(result) {
  const { scenario } = result;
  const failed = scenario.checks.filter((c) => c.status === "FAIL").length;
  const inconclusive = scenario.checks.filter((c) => c.status === "INCONCLUSIVE").length;
  const header = failed ? "FAIL" : inconclusive ? "INCONCLUSIVE" : "PASS";
  console.log(`\n[${header}] ${scenario.name}`);
  for (const c of scenario.checks) {
    const info = c.info ? `  (${String(c.info).slice(0, 200)})` : "";
    console.log(`  ${c.status === "PASS" ? "✓" : c.status === "FAIL" ? "✗" : "•"} ${c.label}${info}`);
  }
  return { failed, inconclusive };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("node scripts/e2e/workflow-features.mjs --model <id> [--thinking high] [--deepseek-api-key-env <name>] [--session-root <dir>] [--agent-dir <dir>] [--keep]");
    return;
  }
  buildDeepseekClaudeEnv(process.env, { apiKeyEnv: options.deepseekApiKeyEnv });
  ensureDir(options.sessionRoot);
  const fixture = createFixture(options.sessionRoot);
  const ctx = {
    run: {
      model: options.model,
      thinking: options.thinking,
      deepseekApiKeyEnv: options.deepseekApiKeyEnv,
      agentDir: options.agentDir,
    },
    sessionRoot: options.sessionRoot,
    agentDir: options.agentDir,
    fixture,
    idBase: `wff-${slug(options.model)}`,
  };

  console.log(`workflow-features e2e`);
  console.log(`  model:       ${options.model} (thinking=${options.thinking})`);
  console.log(`  Claude Code: DeepSeek (${DEEPSEEK_ANTHROPIC_BASE_URL})`);
  console.log(`  extension:   ${extensionPath}`);
  console.log(`  fixture:     ${fixture}`);
  console.log(`  sessionRoot: ${options.sessionRoot}`);
  console.log(`  agentDir:    ${options.agentDir}`);

  // kitchen-sink first (resume depends on its persisted run); rest are independent.
  const registry = [
    ["kitchen", scenarioKitchenSink],
    ["resume", scenarioResume],
    ["branch", scenarioBranch],
    ["gate", scenarioGate],
    ["route", scenarioRoute],
    ["concurrency", scenarioConcurrency],
    ["determinism", scenarioDeterminism],
    ["saved", scenarioSavedName],
    ["discoverability", scenarioDiscoverability],
  ];
  // --only resume implies --only kitchen (resume reuses kitchen's persisted run).
  const want = options.only ? options.only.toLowerCase() : undefined;
  const selected = registry.filter(([key]) => {
    if (!want) return true;
    if (key.includes(want)) return true;
    return want.includes("resume") && key === "kitchen";
  });

  const results = [];
  for (const [, fn] of selected) {
    results.push(await fn(ctx));
  }

  let totalFailed = 0;
  let totalInconclusive = 0;
  for (const r of results) {
    const { failed, inconclusive } = printScenario(r);
    totalFailed += failed;
    totalInconclusive += inconclusive;
  }

  const reportPath = path.join(options.sessionRoot, "report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      { options, scenarios: results.map((r) => ({ name: r.scenario.name, checks: r.scenario.checks })) },
      null,
      2,
    )}\n`,
  );

  console.log(`\n${"=".repeat(72)}`);
  console.log(
    `Summary [${options.model}]: ${results.length} scenarios, ${totalFailed} failed check(s), ${totalInconclusive} inconclusive.`,
  );
  console.log(`report=${reportPath}`);
  if (!options.keep) {
    // Keep artifacts only on failure for debugging; clean on green.
    if (totalFailed === 0) rmSync(options.sessionRoot, { recursive: true, force: true });
    else console.log(`(artifacts kept for debugging: ${options.sessionRoot})`);
  }
  if (totalFailed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
