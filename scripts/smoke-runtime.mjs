// Plain-node smoke test for the compiled runtime entry (dist/runtime.js).
//
// Run via `npm run smoke:runtime` (which builds dist first). No TypeScript
// loader is involved: this exercises exactly what an external plain-JS
// consumer gets from `@kky42/pi-flow/runtime`, including the worker-thread
// script host, parallel/pipeline/phase/log globals, and the shared limiter.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

for (const path of [
  "../dist/src/core/agent-values.js",
  "../dist/src/core/agent-values.d.ts",
  "../dist/src/workflow/agent-runner.js",
  "../dist/src/workflow/agent-runner.d.ts",
]) {
  assert.equal(existsSync(new URL(path, import.meta.url)), false, `obsolete build output remains: ${path}`);
}

const direct = await import(new URL("../dist/runtime.js", import.meta.url));
const profilesModule = await import(new URL("../dist/src/profiles.js", import.meta.url));
const { ConcurrencyLimiter, runWorkflow, parseWorkflowScript, isWorkflowAbortError, WorkflowAbortError } = direct;

// The package export map must resolve the same compiled module (node package
// self-reference exercises the "./runtime" exports entry).
const viaExports = await import("@kky42/pi-flow/runtime");
assert.equal(viaExports.runWorkflow, runWorkflow, "exports map must resolve dist/runtime.js");

assert.equal(typeof runWorkflow, "function");
assert.equal(typeof parseWorkflowScript, "function");
assert.equal(typeof isWorkflowAbortError, "function");
assert.equal(typeof WorkflowAbortError, "function");
assert.ok(isWorkflowAbortError(new WorkflowAbortError("smoke")), "exported class must satisfy its own guard");
assert.deepEqual([...profilesModule.loadBuiltinSubagentProfiles().keys()], ["general-purpose"]);

const script = `export const meta = { name: "smoke-runtime", description: "compiled runtime smoke test" };
phase("fan-out");
const [alpha] = await parallel([() => run_agent("Return the word alpha.", { label: "alpha" })]);
phase("pipe");
const piped = await pipeline(["beta"], (item) => run_agent("Return the word " + item + ".", { label: item }));
log("alpha=" + alpha + " beta=" + piped[0]);
return { alpha, beta: piped[0], args };`;

assert.equal(parseWorkflowScript(script).meta.name, "smoke-runtime");

const limiter = new ConcurrencyLimiter(2);
const seenCalls = [];
const result = await runWorkflow(script, {
  cwd: process.cwd(),
  args: { run: "smoke" },
  limiter,
  runSubagent: async (call, signal) => {
    assert.ok(signal instanceof AbortSignal, "runSubagent must receive an AbortSignal");
    seenCalls.push({ label: call.label, phase: call.phase, profile: call.profile });
    return `result:${call.label}`;
  },
});

assert.deepEqual(result.result, {
  alpha: "result:alpha",
  beta: "result:beta",
  args: { run: "smoke" },
});
assert.equal(result.meta.name, "smoke-runtime");
assert.equal(result.subagentCount, 2);
assert.deepEqual(result.phases, ["fan-out", "pipe"]);
assert.deepEqual(result.logs, ["alpha=result:alpha beta=result:beta"]);
assert.deepEqual(seenCalls, [
  { label: "alpha", phase: "fan-out", profile: "general-purpose" },
  { label: "beta", phase: "pipe", profile: "general-purpose" },
]);
assert.equal(limiter.activeCount, 0, "all limiter slots must be released");
assert.equal(limiter.pendingCount, 0);

const abortController = new AbortController();
abortController.abort();
const aborted = await runWorkflow(script, {
  cwd: process.cwd(),
  limiter,
  signal: abortController.signal,
  runSubagent: async () => "unreachable",
}).then(
  () => {
    throw new Error("aborted workflow must reject");
  },
  (error) => error,
);
assert.ok(isWorkflowAbortError(aborted), `expected WorkflowAbortError, got: ${aborted}`);

console.log("smoke:runtime OK - compiled dist/runtime.js ran a workflow on plain node");
