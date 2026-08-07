#!/usr/bin/env node
// Real-model E2E for the Claude cost-estimate fallback. Two real Claude Code
// turns run through the production spawn path; a wrapper strips only the
// CLI-computed cost fields so the catalog estimate path is exercised. The
// resumed turn must read a big cache prefix and the estimate must price the
// disjoint Anthropic usage buckets at Pi catalog rates.

import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { calculateCost } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { spawnClaudeSubagent } from "../../src/core/claude.ts";
import { loadDotEnv, prepareDeepseekClaudeE2EEnv } from "./lib/deepseek-claude-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
loadDotEnv(path.join(repoRoot, ".env"));

function parseArgs(argv) {
  const options = {
    model: "claude-sonnet-4-5",
    thinking: "medium",
    deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
    runRoot: path.join(tmpdir(), `pi-flow-claude-cost-e2e-${Date.now()}`),
    timeoutMs: 180_000,
    keep: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[i + 1];
      if (!next) throw new Error(`${arg} requires a value`);
      i += 1;
      return next;
    };
    if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--deepseek-api-key-env") options.deepseekApiKeyEnv = value();
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node scripts/e2e/claude-cost-fallback.mjs [options]

Options:
  --model <id>                catalog model for the estimate (default: claude-sonnet-4-5)
  --thinking <level>          Claude Code thinking level (default: medium)
  --deepseek-api-key-env <n>  preferred DeepSeek credential env var
  --run-root <dir>            artifact root (default: OS temp directory)
  --timeout-ms <ms>           timeout per turn (default: 180000)
  --keep                      keep artifacts after a passing run
  -h, --help                  show this help
`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive number");
  return options;
}

const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  })]);

const oldBuggyCost = (usage, cost) => {
  const read = Math.min(usage.input, usage.cacheRead);
  const write = Math.min(usage.input - read, usage.cacheWrite);
  return ((usage.input - read - write) * cost.input + read * cost.cacheRead + write * cost.cacheWrite + usage.output * cost.output) / 1e6;
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  mkdirSync(options.runRoot, { recursive: true });
  const runtimeDir = path.join(options.runRoot, "claude-cost-fallback");
  const binDir = path.join(runtimeDir, "bin");
  const configDir = path.join(runtimeDir, "config");
  const fixtureDir = path.join(runtimeDir, "fixture");
  for (const dir of [binDir, configDir, fixtureDir]) mkdirSync(dir, { recursive: true });

  const realClaude = spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim();
  if (!realClaude) throw new Error("Claude Code E2E requires claude on PATH.");
  const versionRun = spawnSync(realClaude, ["--version"], { encoding: "utf8" });
  const claudeVersion = (versionRun.stdout || versionRun.stderr || "").trim() || undefined;

  const catalogModel = getBuiltinModel("anthropic", options.model);
  if (!catalogModel) throw new Error(`--model ${options.model} is not in Pi's Anthropic catalog; the estimate fallback cannot resolve it.`);

  // Install the standard guard (isolated CLAUDE_CONFIG_DIR, PATH wrapper, DeepSeek
  // routing, fail-fast without a credential), then overwrite the wrapper with the
  // cost-stripping Node wrapper below, which keeps --setting-sources "".
  const preparedEnv = prepareDeepseekClaudeE2EEnv(process.env, {
    apiKeyEnv: options.deepseekApiKeyEnv,
    runtimeDir,
  });

  const wrapperPath = path.join(binDir, "claude");
  writeFileSync(wrapperPath, `#!/usr/bin/env node
import { spawn } from "node:child_process";
const child = spawn(${JSON.stringify(realClaude)}, [...process.argv.slice(2), "--setting-sources", ""], { stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) { process.stdout.write(line + "\\n"); continue; }
    let event;
    try { event = JSON.parse(line); } catch { process.stdout.write(line + "\\n"); continue; }
    if (event && typeof event === "object") {
      delete event.total_cost_usd;
      for (const item of Object.values(event.modelUsage ?? {})) if (item) delete item.costUSD;
    }
    process.stdout.write(JSON.stringify(event) + "\\n");
  }
});
child.stdout.on("end", () => { if (buffer.trim()) process.stdout.write(buffer + "\\n"); });
child.on("close", (code) => process.exit(code ?? 1));
`, "utf8");
  chmodSync(wrapperPath, 0o755);

  Object.assign(process.env, preparedEnv, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });

  const profile = { name: "claude-cost-fallback", description: "Claude cost fallback E2E profile.", backend: "claude", model: options.model };
  const ctx = { cwd: fixtureDir };
  const common = { profile, thinkingLevel: options.thinking, ctx, signal: undefined, progressEnabled: false, onProgress: undefined, onUsage: () => {}, persistSession: true };

  const first = await withTimeout(spawnClaudeSubagent({ label: "Cost fallback turn 1", prompt: "Reply with exactly: COST_FALLBACK_FIRST_OK", ...common }), options.timeoutMs, "turn 1");
  const second = await withTimeout(spawnClaudeSubagent({ label: "Cost fallback turn 2", prompt: "Reply with exactly: COST_FALLBACK_SECOND_OK", ...common, sessionId: first.details.sessionId }), options.timeoutMs, "turn 2");

  const disjointTotal = (u) => u.input + u.cacheRead + u.cacheWrite + u.output;
  const catalogCost = (usage) => calculateCost(catalogModel, {
    input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
  const costMatches = [first, second].map((t) => Math.abs(t.usage.cost.total - catalogCost(t.usage)) <= 1e-9);

  const checks = {
    turnsDone: first.details.status === "done" && second.details.status === "done",
    sameSession: Boolean(first.details.sessionId && first.details.sessionId === second.details.sessionId),
    cacheReadDominates: second.usage.cacheRead > second.usage.input,
    totalTokensDisjoint: [first, second].every((t) => t.usage.totalTokens === disjointTotal(t.usage)),
    estimatePath: [first, second].every((t) => t.details.telemetry?.costEstimated === true && t.details.telemetry?.costKnown === true),
    costMatchesCatalog: costMatches.every(Boolean),
  };
  const pass = Object.values(checks).every(Boolean);

  const secondTurn = {
    estimated: second.usage.cost.total,
    expected: catalogCost(second.usage),
    oldBuggyFormula: oldBuggyCost(second.usage, catalogModel.cost),
  };
  const report = {
    claudeVersion,
    model: options.model,
    turns: [first, second].map((t) => ({ status: t.details.status, sessionId: t.details.sessionId, usage: t.usage })),
    checks,
    secondTurn: { ...secondTurn, undercountRatio: secondTurn.expected / secondTurn.oldBuggyFormula },
  };
  writeFileSync(path.join(options.runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  const usageDisplay = `↑${Math.round(second.usage.input / 1000)}k ↓${second.usage.output} R${Math.round(second.usage.cacheRead / 1000)}k W${second.usage.cacheWrite} $${second.usage.cost.total.toFixed(4)}`;
  console.log(`[${pass ? "PASS" : "FAIL"}] claude-cost-fallback | ${claudeVersion ?? "unknown"} | ${options.model} | ${usageDisplay}`);
  console.log(`Report: ${path.join(options.runRoot, "report.json")}`);

  if (!pass) console.error(JSON.stringify(report, null, 2));
  if (!options.keep) rmSync(options.runRoot, { recursive: true, force: true });
  if (!pass) process.exit(1);
}

main().catch((error) => {
  console.error(`claude-cost-fallback E2E failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
