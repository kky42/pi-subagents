#!/usr/bin/env node
// Real end-to-end smoke for pi-flow session_key continuation.
//
// Each selected backend starts a subagent without a session_key, then resumes
// it with the generated key returned by the first synchronous Tool result. The first
// child reads a secret file in a way that leaves the
// value in the child session transcript, then deletes it; the second child must
// recall the deleted secret from its continued child session. A fresh child
// cannot read the file after the first turn, so the final token proves resume
// semantics at the backend boundary.

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  unlinkSync,
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
const BACKENDS = ["pi", "codex", "claude"];

function parseArgs(argv) {
  const options = {
    backend: "all",
    rootModel: "deepseek/deepseek-v4-flash",
    rootThinking: "high",
    codexModel: "gpt-5.4-mini",
    codexThinking: "medium",
    claudeModel: "haiku",
    claudeThinking: "medium",
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    agentDir: process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"),
    runRoot: undefined,
    keep: false,
    timeoutMs: 300_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    if (arg === "--backend") options.backend = value();
    else if (arg === "--root-model") options.rootModel = value();
    else if (arg === "--root-thinking") options.rootThinking = value();
    else if (arg === "--codex-model") options.codexModel = value();
    else if (arg === "--codex-thinking") options.codexThinking = value();
    else if (arg === "--claude-model") options.claudeModel = value();
    else if (arg === "--claude-thinking") options.claudeThinking = value();
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = value();
    else if (arg === "--agent-dir") options.agentDir = path.resolve(value());
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.backend !== "all" && !BACKENDS.includes(options.backend)) {
    throw new Error(`--backend must be one of all, ${BACKENDS.join(", ")}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/e2e/session-key-resume.mjs [options]\n\nOptions:\n  --backend <all|pi|codex|claude>  backend(s) to test (default: all)\n  --root-model <provider/model>    pi root model (default: deepseek/deepseek-v4-flash)\n  --root-thinking <level>          pi root thinking level (default: high)\n  --codex-model <model>            Codex subagent model (default: gpt-5.4-mini)\n  --codex-thinking <level>         Codex subagent thinking (default: medium)\n  --claude-model <model>           Claude Code alias mapped to DeepSeek (default: haiku)\n  --claude-thinking <level>        Claude Code subagent thinking (default: medium)\n  --deepseek-api-key-env <name>    preferred DeepSeek credential env var (fallback: DEEPSEEK_API_KEY, DEEPSEEK_API_TOKEN)\n  --agent-dir <dir>                pi agent dir (default: PI_CODING_AGENT_DIR or ~/.pi/agent)\n  --run-root <dir>                 temp run root\n  --timeout-ms <ms>                per-backend pi timeout (default: 300000)\n  --keep                           keep temp run root and temporary profiles\n`);
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function shell(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", ...options });
}

function listFilesRecursive(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function readAllTextUnder(root) {
  return listFilesRecursive(root)
    .map((file) => {
      try {
        return `\n--- ${file} ---\n${readFileSync(file, "utf8")}`;
      } catch {
        return "";
      }
    })
    .join("\n");
}

function parseEnvelope(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function persistedRecordTimestampMs(record) {
  const value = record?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function analyzeTaskMessages(root) {
  const calls = [];
  const callsById = new Map();
  const terminal = [];
  let customTaskNotificationCount = 0;
  for (const file of listFilesRecursive(root).filter((candidate) => candidate.endsWith(".jsonl"))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const message = record.message;
      const recordTimestampMs = persistedRecordTimestampMs(record);
      for (const item of Array.isArray(message?.content) ? message.content : []) {
        if (item?.type === "toolCall" && item.name === "run_agent") {
          const call = {
            ...(item.arguments ?? {}),
            toolCallId: item.id,
            toolCallRecordAtMs: recordTimestampMs,
          };
          calls.push(call);
          if (typeof item.id === "string") callsById.set(item.id, call);
        }
      }
      if (message?.role === "toolResult" && message.toolName === "run_agent") {
        const envelope = parseEnvelope(message.content?.[0]?.text);
        if (
          envelope?.task_type === "agent"
          && (envelope.status === "completed" || envelope.status === "failed")
          && typeof envelope.task_id === "string"
        ) {
          const call = callsById.get(message.toolCallId);
          terminal.push({
            toolCallId: message.toolCallId,
            taskId: envelope.task_id,
            sessionKey: typeof envelope.session_key === "string" ? envelope.session_key : undefined,
            envelope,
            details: message.details && typeof message.details === "object" ? message.details : undefined,
            toolCallRecordAtMs: call?.toolCallRecordAtMs,
            toolResultRecordAtMs: recordTimestampMs,
            toolRecordIntervalMs: typeof call?.toolCallRecordAtMs === "number" && typeof recordTimestampMs === "number"
              ? Math.max(0, recordTimestampMs - call.toolCallRecordAtMs)
              : undefined,
            usage: message.usage,
          });
        }
      }
      const custom = record.type === "custom_message" ? record : message?.role === "custom" ? message : undefined;
      if (custom?.customType === "pi-flow-task-notification") customTaskNotificationCount += 1;
    }
  }
  return { calls, terminal, customTaskNotificationCount };
}

function runPi({ command, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, error, timedOut, durationMs: Date.now() - startedAt });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeFixture(runRoot, backend) {
  const fixture = path.join(runRoot, backend, "fixture");
  ensureDir(fixture);
  writeFileSync(path.join(fixture, "README.md"), `# ${backend} session_key E2E\n\nThe child agent must read and delete an untracked e2e-secret.txt, then recall it from session memory.\n`, "utf8");
  assert(shell("git", ["init", "-q"], { cwd: fixture }).status === 0, `[${backend}] could not initialize fixture Git repository`);
  assert(shell("git", ["add", "."], { cwd: fixture }).status === 0, `[${backend}] could not stage ordinary fixture`);
  assert(
    shell("git", ["-c", "user.name=pi-flow-e2e", "-c", "user.email=pi-flow-e2e@example.invalid", "commit", "-qm", "fixture"], { cwd: fixture }).status === 0,
    `[${backend}] could not commit ordinary fixture`,
  );

  const secret = `${backend.toUpperCase()}_SESSION_KEY_SECRET_${Date.now()}`;
  writeFileSync(path.join(fixture, "e2e-secret.txt"), `${secret}\n`, "utf8");
  assert(
    shell("git", ["ls-files", "--error-unmatch", "e2e-secret.txt"], { cwd: fixture }).status !== 0,
    `[${backend}] secret file unexpectedly became tracked`,
  );
  return { fixture, secret };
}

function profileBody(backend, profileName, options) {
  if (backend === "pi") {
    return `---\ndescription: E2E pi session_key resume profile.\nbackend: pi\ntools: read, bash\n---\n\nYou are a pi-flow session_key E2E child. Follow the prompt exactly.\n`;
  }
  if (backend === "codex") {
    return `---\ndescription: E2E Codex session_key resume profile.\nbackend: codex\nmodel: ${options.codexModel}\nthinking: ${options.codexThinking}\n---\n\nYou are a pi-flow session_key E2E Codex child. Follow the prompt exactly.\n`;
  }
  return `---\ndescription: E2E Claude session_key resume profile.\nbackend: claude\nmodel: ${options.claudeModel}\nthinking: ${options.claudeThinking}\n---\n\nYou are a pi-flow session_key E2E Claude child. Follow the prompt exactly.\n`;
}

function writePrompt(runRoot, backend, profileName, expectedPrefix) {
  const promptPath = path.join(runRoot, backend, "prompt.md");
  ensureDir(path.dirname(promptPath));
  const firstPrompt = "Read e2e-secret.txt in a way that leaves its exact trimmed content visible in this subagent session's tool transcript, remember that exact content, delete e2e-secret.txt, and then reply exactly STEP1_DONE.";
  const secondPrompt = `Using only the prior conversation in this same subagent session, reply exactly ${expectedPrefix}:<remembered secret>. Do not read files.`;
  writeFileSync(promptPath, `You are testing pi-flow generated session_key continuation for backend ${backend}.\n\nYou MUST call the run_agent tool exactly twice, sequentially, with profile "${profileName}". Do not pass session_key on the first call. When its synchronous Tool result returns, copy the returned terminal envelope's session_key exactly and pass that key on the second call. Do not invent or preselect a key.\n\nFirst run_agent call:\n- label: "${backend} remember secret"\n- prompt exactly:\n${firstPrompt}\n\nSecond run_agent call after the first terminal Tool result:\n- label: "${backend} recall secret"\n- session_key: the exact generated session_key returned by the first run_agent Tool result\n- prompt exactly:\n${secondPrompt}\n\nAfter the second terminal Tool result returns, reply with exactly the second subagent's token line and nothing else.\n`, "utf8");
  return promptPath;
}

async function runBackend(options, backend) {
  const profileName = `zz-e2e-${backend}-session-key-${Date.now()}-${process.pid}`;
  const subagentsDir = path.join(options.agentDir, "subagents");
  const profilePath = path.join(subagentsDir, `${profileName}.md`);
  ensureDir(subagentsDir);
  const backendRoot = path.join(options.runRoot, backend);
  ensureDir(backendRoot);
  const backendEnv = prepareDeepseekClaudeE2EEnv(process.env, {
    apiKeyEnv: options.deepseekApiKeyEnv,
    runtimeDir: path.join(backendRoot, "claude-runtime"),
  });
  const { fixture, secret } = writeFixture(options.runRoot, backend);
  const expectedPrefix = `${backend.toUpperCase()}_SESSION_KEY_OK`;
  const expected = `${expectedPrefix}:${secret}`;
  let run;
  let observation;
  try {
    writeFileSync(profilePath, profileBody(backend, profileName, options), "utf8");
    const promptPath = writePrompt(options.runRoot, backend, profileName, expectedPrefix);
    const sessionDir = path.join(backendRoot, "sessions");
    ensureDir(sessionDir);

    const command = [
      "pi",
      "-p",
      "--mode", "json",
      "--model", options.rootModel,
      "--thinking", options.rootThinking,
      "--session-dir", sessionDir,
      "--no-extensions",
      "--extension", extensionPath,
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--tools", "run_agent",
      "--approve",
      `@${promptPath}`,
    ];

    console.log(`\n[${backend}] Running: ${command.join(" ")}`);
    console.log(`[${backend}] Fixture: ${fixture}`);
    console.log(`[${backend}] Session dir: ${sessionDir}`);
    console.log(`[${backend}] Profile: ${profilePath}`);

    console.log(`[${backend}] Claude Code provider guard: DeepSeek (${DEEPSEEK_ANTHROPIC_BASE_URL})`);

    run = await runPi({
      command,
      cwd: fixture,
      env: { ...backendEnv, PI_CODING_AGENT_DIR: options.agentDir },
      timeoutMs: options.timeoutMs,
    });
    const transcriptText = `${run.stdout}\n${run.stderr}\n${readAllTextUnder(sessionDir)}`;
    const tasks = analyzeTaskMessages(sessionDir);
    observation = {
      backend,
      process: {
        code: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        durationMs: run.durationMs,
      },
      terminalToolResults: tasks.terminal,
      customTaskNotificationCount: tasks.customTaskNotificationCount,
    };
    writeFileSync(path.join(backendRoot, "analysis.json"), `${JSON.stringify(observation, null, 2)}\n`, "utf8");

    assert(!run.timedOut, `[${backend}] pi timed out after ${options.timeoutMs}ms`);
    assert(run.code === 0, `[${backend}] pi exited with ${run.code}${run.signal ? ` (${run.signal})` : ""}\nSTDOUT:\n${run.stdout}\nSTDERR:\n${run.stderr}`);
    assert(transcriptText.includes(profileName), `[${backend}] session/output did not mention profile ${profileName}`);
    assert(tasks.calls.length === 2, `[${backend}] expected exactly two run_agent calls, observed ${tasks.calls.length}`);
    assert(tasks.calls.every((call) => call.profile === profileName), `[${backend}] run_agent calls did not select profile ${profileName}`);
    assert(tasks.calls[0].session_key === undefined, `[${backend}] first run_agent call must omit session_key`);
    assert(tasks.terminal.length === 2, `[${backend}] expected two terminal run_agent Tool results, observed ${tasks.terminal.length}`);
    assert(tasks.terminal.every((item) => item.envelope.task_type === "agent"), `[${backend}] terminal task_type was not agent`);
    assert(tasks.terminal.every((item) => item.envelope.status === "completed"), `[${backend}] a run_agent terminal envelope was not completed`);
    assert(tasks.terminal.every((item) => item.details?.status === "done"), `[${backend}] rich agent details were not done`);
    assert(tasks.terminal.every((item) => item.details?.taskId === item.taskId), `[${backend}] rich details taskId did not match terminal task_id`);
    assert(tasks.terminal.every((item) => item.details?.sessionKey === item.sessionKey), `[${backend}] rich details sessionKey did not match terminal session_key`);
    assert(tasks.terminal.every((item) => Number.isFinite(item.toolRecordIntervalMs)), `[${backend}] persisted Tool call-to-result record interval was not recorded`);
    assert(tasks.customTaskNotificationCount === 0, `[${backend}] observed ${tasks.customTaskNotificationCount} unexpected custom task notification(s)`);
    const generatedKey = tasks.terminal[0].sessionKey;
    assert(/^session_[a-f0-9]{32}$/.test(generatedKey ?? ""), `[${backend}] first run_agent did not return a generated session_key`);
    assert(tasks.calls[1].session_key === generatedKey, `[${backend}] second run_agent call did not reuse the generated session_key`);
    assert(tasks.terminal[1].sessionKey === generatedKey, `[${backend}] second terminal result changed session_key`);
    assert(new Set(tasks.terminal.map((item) => item.taskId)).size === 2, `[${backend}] terminal task_id values were not distinct`);
    assert(transcriptText.includes("STEP1_DONE"), `[${backend}] first child result was not observed`);
    assert(transcriptText.includes(expected), `[${backend}] expected resumed token not found: ${expected}`);
    assert(!existsSync(path.join(fixture, "e2e-secret.txt")), `[${backend}] first child did not delete e2e-secret.txt`);
    const committedSecretSearch = shell("git", ["grep", "-F", secret, ...shell("git", ["rev-list", "--all"], { cwd: fixture }).stdout.trim().split(/\s+/).filter(Boolean)], { cwd: fixture });
    assert(committedSecretSearch.status === 1 && committedSecretSearch.stdout === "", `[${backend}] secret was recoverable from committed Git content`);
    assert(shell("git", ["status", "--porcelain"], { cwd: fixture }).stdout === "", `[${backend}] fixture did not return to its committed state after secret deletion`);
    assert(!readAllTextUnder(fixture).includes(secret), `[${backend}] secret remained in a persistent fixture file after deletion`);
    console.log(`[${backend}] PASS session_key resume E2E`);
    console.log(`[${backend}] Observed token: ${expected}`);
    console.log(`[${backend}] Terminal Tool results: ${JSON.stringify(tasks.terminal.map((item) => ({ task_id: item.taskId, session_key: item.sessionKey, status: item.envelope.status, detailsStatus: item.details?.status, toolCallRecordAtMs: item.toolCallRecordAtMs, toolResultRecordAtMs: item.toolResultRecordAtMs, toolRecordIntervalMs: item.toolRecordIntervalMs, usage: item.usage ?? null })))}`);
  } finally {
    if (!options.keep) {
      try { unlinkSync(profilePath); } catch {}
    } else {
      console.log(`[${backend}] Kept profile: ${profilePath}`);
      if (run) {
        writeFileSync(path.join(backendRoot, "stdout.jsonl"), run.stdout ?? "", "utf8");
        writeFileSync(path.join(backendRoot, "stderr.log"), run.stderr ?? "", "utf8");
      }
    }
  }
  return observation;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const backends = options.backend === "all" ? BACKENDS : [options.backend];
  buildDeepseekClaudeEnv(process.env, { apiKeyEnv: options.deepseekApiKeyEnv });
  if (!options.runRoot) {
    options.runRoot = mkdtempSync(path.join(tmpdir(), "pi-flow-session-key-e2e-"));
  }
  ensureDir(options.runRoot);
  console.log(`Session root: ${options.runRoot}`);
  let completedSuccessfully = false;
  try {
    const results = [];
    for (const backend of backends) {
      results.push(await runBackend(options, backend));
    }
    const reportPath = path.join(options.runRoot, "report.json");
    writeFileSync(reportPath, `${JSON.stringify({ options, results }, null, 2)}\n`, "utf8");
    console.log(`Session-key report: ${reportPath}`);
    completedSuccessfully = true;
  } finally {
    if (completedSuccessfully && !options.keep) {
      rmSync(options.runRoot, { recursive: true, force: true });
    } else {
      console.log(`Session artifacts kept at: ${options.runRoot}`);
    }
  }
}

main().catch((error) => {
  console.error(`FAIL session_key resume E2E: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exitCode = 1;
});
