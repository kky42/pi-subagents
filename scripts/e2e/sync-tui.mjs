#!/usr/bin/env node
// Real interactive-mode (tmux) UI E2E for pi-flow's synchronous TUI surface.
//
// Launches the worktree's pi-flow extension inside a real `pi` TUI in a tmux
// pane and verifies, from captured frames:
//   1. a direct run_agent Tool row goes live with an animated spinner
//      (distinct frames observed while the child runs);
//   2. a run_workflow row renders a live phase tree with an animated spinner;
//   3. the bottom `pi-flow ↑in ↓out ...` summary widget appears after the
//      tasks complete;
//   4. pi's own footer still shows session tokens (child usage folded in).
// Uses the real deepseek provider; fails fast without DEEPSEEK_API_KEY and on
// any process/harness failure. Retains raw capture artifacts on failure or
// with --keep.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, resolveDeepseekApiKey } from "./lib/deepseek-claude-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const extensionPath = repoRoot;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const AGENT_ROW = /Pi Agent|Codex Agent|Claude Agent|Agent\(/;
const WORKFLOW_ROW = /Workflow\(/;
const WIDGET_LINE = /pi-flow ↑/;

loadDotEnv(path.join(repoRoot, ".env"));

const options = {
  model: "deepseek/deepseek-v4-flash",
  thinking: "high",
  keep: false,
  timeoutMs: 420_000,
};
for (let i = 0; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  const value = () => {
    const v = process.argv[i + 1];
    if (v === undefined) throw new Error(`${arg} requires a value`);
    i += 1;
    return v;
  };
  if (arg === "--model") options.model = value();
  else if (arg === "--thinking") options.thinking = value();
  else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
  else if (arg === "--keep") options.keep = true;
  else if (arg === "--help" || arg === "-h") {
    console.log("Usage: node scripts/e2e/sync-tui.mjs [--model <id>] [--thinking <level>] [--keep]");
    process.exit(0);
  }
}

if (!resolveDeepseekApiKey(process.env)) {
  console.error("sync-tui: DEEPSEEK_API_KEY is required (set it or add it to .env)");
  process.exit(1);
}
for (const bin of ["tmux", "pi"]) {
  const probe = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (probe.error) {
    console.error(`sync-tui: ${bin} is not available on PATH`);
    process.exit(1);
  }
}

const projectDir = mkdtempSync(path.join(tmpdir(), "pi-flow-sync-tui-"));
const workflowsDir = path.join(projectDir, ".pi", "workflows");
mkdirSync(workflowsDir, { recursive: true });
writeFileSync(
  path.join(workflowsDir, "ui_check.js"),
  [
    "export const meta = { name: 'ui_check', description: 'Run two waiting subagents to exercise the TUI' };",
    "const runOne = (label, marker) => run_agent(`Use the bash tool to wait 5 seconds, then reply with exactly: ${marker}`, { label, profile: 'general-purpose' });",
    "const results = await parallel([() => runOne('w1', 'W1_DONE'), () => runOne('w2', 'W2_DONE')]);",
    "return { w1: results[0], w2: results[1] };",
    "",
  ].join("\n"),
);

const sessionName = `pi-flow-sync-tui-${process.pid}`;
const artifactDir = path.join(repoRoot, "scripts", "e2e", "artifacts", `sync-tui-${Date.now()}`);
const captures = [];
const log = (message) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${message}`;
  console.log(line);
  captures.push(line);
};

function tmux(args) {
  return execFileSync("tmux", args, { encoding: "utf8" });
}

function capturePane() {
  return tmux(["capture-pane", "-t", sessionName, "-p", "-J"]);
}

function sendKeys(text) {
  tmux(["send-keys", "-t", sessionName, "-l", text]);
}

function sendEnter() {
  tmux(["send-keys", "-t", sessionName, "Enter"]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(description, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";
  while (Date.now() < deadline) {
    lastPane = capturePane();
    captures.push(lastPane);
    if (predicate(lastPane)) {
      return lastPane;
    }
    await sleep(40);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

function spinnerFrames(pane, rowPattern) {
  const row = pane.split("\n").find((line) => rowPattern.test(line));
  if (!row) {
    return new Set();
  }
  return new Set([...row].filter((char) => SPINNER_FRAMES.includes(char)));
}

function workflowSpinnerFrames(pane) {
  const lines = pane.split("\n");
  const start = lines.findIndex((line) => WORKFLOW_ROW.test(line));
  if (start === -1) {
    return new Set();
  }
  const frames = new Set();
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("────────────")) {
      break;
    }
    for (const char of line) {
      if (SPINNER_FRAMES.includes(char)) {
        frames.add(char);
      }
    }
  }
  return frames;
}

function teardown(failed) {
  try {
    tmux(["kill-session", "-t", sessionName]);
  } catch {
    // Session already gone.
  }
  const retain = failed || options.keep;
  if (retain) {
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(path.join(artifactDir, "captures.txt"), captures.join("\n--- frame ---\n"));
    writeFileSync(path.join(artifactDir, "project-dir.txt"), projectDir);
    log(`artifacts retained: ${artifactDir}`);
    if (options.keep) {
      log(`tmux session kept as ${sessionName} (run 'tmux attach -t ${sessionName}')`);
      return;
    }
  }
  rmSync(projectDir, { recursive: true, force: true });
}

async function main() {
  log(`project: ${projectDir}`);
  log(`extension: ${extensionPath}`);
  log(`model: ${options.model} (thinking ${options.thinking})`);
  tmux(["new-session", "-d", "-s", sessionName, "-x", "240", "-y", "64", "-c", projectDir]);
  const piArgs = [
    "--no-extensions",
    "--extension", extensionPath,
    "--provider", "deepseek",
    "--model", options.model,
    "--thinking", options.thinking,
    "--no-skills",
    "--no-themes",
    "--no-prompt-templates",
    "--no-context-files",
    "-a",
  ];
  sendKeys(`TERM=xterm-256color pi ${piArgs.join(" ")}`);
  sendEnter();

  let failed = false;
  try {
    const [providerName, modelName] = options.model.split("/");
    const footerPattern = new RegExp(`\\(${providerName}\\) ${modelName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    log("waiting for the TUI to boot");
    // The footer only exists once the interactive editor is attached; the echoed
    // command line also contains the model name, so require the footer shape.
    await waitFor("TUI boot (footer shows the model)", (pane) => footerPattern.test(pane), 60_000);
    // Let the editor finish attaching so Enter in the input box submits instead
    // of being consumed during startup.
    await sleep(2_000);

    log("prompting for a direct run_agent task");
    sendKeys(
      "Use the run_agent tool to delegate: a subagent should use the bash tool to wait 5 seconds, then reply with exactly: AGENT_DONE. Call run_agent once, do nothing else, then report its result.",
    );
    sendEnter();

    log("waiting for the live run_agent row");
    await waitFor("live run_agent row with spinner", (pane) => spinnerFrames(pane, AGENT_ROW).size >= 1, 90_000);
    const agentFrames = new Set();
    let agentCompleted = false;
    const agentDeadline = Date.now() + 150_000;
    while (Date.now() < agentDeadline) {
      const pane = capturePane();
      captures.push(pane);
      const frames = spinnerFrames(pane, AGENT_ROW);
      for (const frame of frames) {
        agentFrames.add(frame);
      }
      if (/✓ (?:Pi|Codex|Claude) Agent/.test(pane)) {
        agentCompleted = true;
        break;
      }
      await sleep(40);
    }
    if (!agentCompleted) {
      throw new Error("run_agent row never reached the completed state");
    }
    if (agentFrames.size < 2) {
      throw new Error(`run_agent row did not animate (${agentFrames.size} distinct spinner frame(s) seen)`);
    }
    log(`run_agent row animated with ${agentFrames.size} distinct spinner frames`);
    // The prompt itself contains the marker, so only accept it outside the user
    // message line. The root's report is natural language; log a warning rather
    // than failing the UI assertions when it paraphrases without the marker.
    try {
      await waitFor("root report of AGENT_DONE", (pane) =>
        pane.split("\n").some((line) => line.includes("AGENT_DONE") && !line.includes("reply with exactly")),
      45_000);
    } catch (error) {
      log(`warning: ${error instanceof Error ? error.message : String(error)}`);
    }

    log("waiting for the bottom usage widget after the agent task");
    await waitFor("bottom pi-flow widget with cumulative usage", (pane) => WIDGET_LINE.test(pane), 30_000);

    log("prompting for the saved ui_check workflow");
    sendKeys("Run the saved workflow named ui_check. Report its result.");
    sendEnter();

    log("waiting for the live workflow row");
    await waitFor("live workflow row with spinner", (pane) => {
      const frames = workflowSpinnerFrames(pane);
      return frames.size >= 1;
    }, 90_000);
    const workflowFrames = new Set();
    const workflowDeadline = Date.now() + 180_000;
    while (Date.now() < workflowDeadline) {
      const pane = capturePane();
      captures.push(pane);
      const frames = workflowSpinnerFrames(pane);
      for (const frame of frames) {
        workflowFrames.add(frame);
      }
      if (/Workflow\([^)]*\) completed/.test(pane)) {
        break;
      }
      await sleep(40);
    }
    if (workflowFrames.size < 2) {
      throw new Error(`workflow row did not animate (${workflowFrames.size} distinct spinner frame(s) seen)`);
    }
    log(`workflow row animated with ${workflowFrames.size} distinct spinner frames`);
    try {
      await waitFor("root report of W1_DONE and W2_DONE", (pane) => /W1_DONE/.test(pane) && /W2_DONE/.test(pane), 45_000);
    } catch (error) {
      log(`warning: ${error instanceof Error ? error.message : String(error)}`);
    }

    const finalPane = await waitFor("bottom widget still visible after the workflow", (pane) => WIDGET_LINE.test(pane), 30_000);
    const lines = finalPane.split("\n").filter((line) => line.trim().length > 0);
    const widgetIndex = lines.findIndex((line) => WIDGET_LINE.test(line));
    if (widgetIndex === -1) {
      throw new Error("pi-flow widget line vanished after the workflow");
    }
    if (widgetIndex === lines.length - 1) {
      throw new Error("pi-flow widget must sit above pi's own footer");
    }
    const footer = lines[lines.length - 1];
    if (!/↑/.test(footer)) {
      throw new Error(`pi footer missing session tokens: ${footer}`);
    }
    log(`widget: ${lines[widgetIndex]}`);
    log(`footer: ${footer}`);

    log("PASS: live rows animated, workflow phase tree rendered, bottom usage widget visible");
  } catch (error) {
    failed = true;
    log(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    teardown(failed);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
