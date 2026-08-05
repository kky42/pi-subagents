import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";
import { SessionKeyLocks } from "../src/core/session-key.ts";
import { SynchronousTaskManager } from "../src/core/task-manager.ts";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { createRunWorkflowTool } from "../src/pi-workflow.ts";
import { INLINE_WORKFLOW_EXAMPLE } from "../src/prompts.ts";
import {
  parseWorkflowScript,
  runWorkflow,
  type WorkflowSubagentResultEvent,
  type WorkflowSubagentRunner,
} from "../src/workflow/runtime.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "../src/workflow/registry.ts";
import { loadWorkflowJournal, persistWorkflowScript } from "../src/workflow/journal.ts";
import { createStructuredOutputTool, type StructuredOutputCapture } from "../src/workflow/structured-output.ts";

const META = "export const meta = { name: 'wf', description: 'a workflow' };\n";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("condition was not met before timeout");
    }
    await delay(1);
  }
}

function makeMockTheme(): Theme {
  const theme = Object.create(Theme.prototype) as Theme;
  theme.fg = (_color, text) => text;
  theme.bold = (text) => text;
  return theme;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderToText(component: { render: (width: number) => string[] }): string {
  return stripAnsi(component.render(200).join("\n"));
}

describe("parseWorkflowScript", () => {
  it("extracts meta and strips the export from the body", () => {
    const { meta, body } = parseWorkflowScript(`${META}return await run_agent('hi');`);
    expect(meta).toMatchObject({ name: "wf", description: "a workflow" });
    expect(body).not.toContain("export const meta");
    expect(body).toContain("run_agent('hi')");
  });

  it("requires the meta export as the first statement", () => {
    expect(() => parseWorkflowScript("const x = 1;\n")).toThrow(/export const meta/);
  });

  it("requires non-empty name and description", () => {
    expect(() => parseWorkflowScript("export const meta = { name: 'x' };\n")).toThrow(/description/);
    expect(() => parseWorkflowScript("export const meta = { description: 'y' };\n")).toThrow(/name/);
  });

  it("rejects non-deterministic time/random APIs", () => {
    expect(() => parseWorkflowScript(`${META}const t = Date.now();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const r = Math.random();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const d = new Date();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const now = Date.now; now();`)).toThrow(/deterministic|Date/i);
    expect(() => parseWorkflowScript(`${META}const D = Date; new D();`)).toThrow(/deterministic|Date/i);
    expect(() => parseWorkflowScript(`${META}const { random } = Math; random();`)).toThrow(/deterministic|Math\.random/i);
    expect(() => parseWorkflowScript(`${META}const M = Math; M.random();`)).toThrow(/deterministic|Math\.random/i);
  });

  it("allows deterministic Math aliases", () => {
    expect(() => parseWorkflowScript(`${META}const M = Math; const x = M.max(1, 2); return await run_agent(String(x));`)).not.toThrow();
  });

  it("allows Date as a deterministic data field name", () => {
    expect(() => parseWorkflowScript(`${META}const schema = { type: 'object', additionalProperties: false, required: ['Date'], properties: { Date: { type: 'string' } } };\nreturn await run_agent('x', { schema });`)).not.toThrow();
  });

  it("preflights static structured output schemas", () => {
    const valid = `${META}const schema = {
  type: 'object', additionalProperties: false, required: ['items'], properties: {
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' } } } }
  }
};\nreturn await run_agent('x', { schema });`;
    expect(() => parseWorkflowScript(valid)).not.toThrow();

    const missingAdditionalProperties = `${META}const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };\nreturn await run_agent('x', { schema });`;
    expect(() => parseWorkflowScript(missingAdditionalProperties)).toThrow(/preflight.*\$\.additionalProperties.*must be false/i);

    const missingRequiredProperty = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string' }, note: { type: ['string', 'null'] } } } });`;
    expect(() => parseWorkflowScript(missingRequiredProperty)).toThrow(/\$\.required.*missing: note/i);

    const invalidNestedObject = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['item'], properties: { item: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } } });`;
    expect(() => parseWorkflowScript(invalidNestedObject)).toThrow(/\$\.properties\.item\.additionalProperties.*must be false/i);

    const dataNamedProperties = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['properties', 'metadata'], properties: { properties: { type: 'string' }, metadata: { type: 'object', additionalProperties: false, required: ['value'], properties: { value: { type: 'string', enum: [{ type: 'object' }] } } } } } });`;
    expect(() => parseWorkflowScript(dataNamedProperties)).not.toThrow();

    const invalidPropertySchema = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: 42 } } });`;
    expect(() => parseWorkflowScript(invalidPropertySchema)).toThrow(/properties\.answer.*schema object/i);

    const invalidType = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'wat' } } } });`;
    expect(() => parseWorkflowScript(invalidType)).toThrow(/properties\.answer\.type.*valid JSON Schema type/i);

    const allOfAtRoot = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['x'], properties: { x: { type: 'string' } }, allOf: [{ type: 'object' }] } });`;
    expect(() => parseWorkflowScript(allOfAtRoot)).toThrow(/\$\.allOf.*allOf is not supported/i);

    const oneOfAtRoot = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['x'], properties: { x: { type: 'string' } }, oneOf: [{ type: 'object', additionalProperties: false, required: [], properties: {} }] } });`;
    expect(() => parseWorkflowScript(oneOfAtRoot)).toThrow(/\$\.oneOf.*oneOf is not supported/i);

    const allOfNested = `${META}return await run_agent('x', { schema: { type: 'object', additionalProperties: false, required: ['item'], properties: { item: { type: 'object', additionalProperties: false, required: ['val'], properties: { val: { type: 'string' } }, allOf: [] } } } });`;
    expect(() => parseWorkflowScript(allOfNested)).toThrow(/\$\.properties\.item\.allOf.*allOf is not supported/i);
  });

  it("requires schemas to be statically available during preflight", () => {
    expect(() => parseWorkflowScript(`${META}return await run_agent('x', { schema: args.schema });`)).toThrow(/static object literal|top-level const/i);
  });

  it("rejects non-literal meta", () => {
    expect(() => parseWorkflowScript("export const meta = buildMeta();\n")).toThrow();
  });
});

describe("runWorkflow", () => {
  const echo: WorkflowSubagentRunner = async (call) => call.prompt;

  it("runs a single agent and returns its result", async () => {
    const result = await runWorkflow(`${META}return await run_agent('hello', { label: 'greet' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: echo,
    });
    expect(result.result).toBe("hello");
    expect(result.meta.name).toBe("wf");
    expect(result.subagentCount).toBe(1);
  });

  it("keeps the inline workflow example executable", async () => {
    const calls: Array<{ label: string; sessionKey?: string; profile: string }> = [];
    const result = await runWorkflow(INLINE_WORKFLOW_EXAMPLE, {
      args: { items: ["source", "tests"] },
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: async (call) => {
        calls.push({ label: call.label, sessionKey: call.sessionKey, profile: call.profile });
        return { text: call.label };
      },
    });

    expect(calls.map((call) => `${call.label}:${call.sessionKey}:${call.profile}`).sort()).toEqual([
      "followup-0:item-0:general-purpose",
      "followup-1:item-1:general-purpose",
      "inspect-0:item-0:general-purpose",
      "inspect-1:item-1:general-purpose",
    ]);
    expect(result.result).toEqual({
      results: [
        { item: "source", first: "inspect-0", followup: "followup-0" },
        { item: "tests", first: "inspect-1", followup: "followup-1" },
      ],
    });
  });

  it("rejects invalid schemas before launching any agent", async () => {
    let calls = 0;
    const runSubagent: WorkflowSubagentRunner = async () => {
      calls += 1;
      return {};
    };
    await expect(
      runWorkflow(`${META}await run_agent('first');
return await run_agent('second', { schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } });`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent,
      }),
    ).rejects.toThrow(/schema preflight.*additionalProperties/i);
    expect(calls).toBe(0);
  });

  it("validates dynamic schema options before launching the requested agent", async () => {
    let calls = 0;
    const runSubagent: WorkflowSubagentRunner = async () => {
      calls += 1;
      return {};
    };
    await expect(
      runWorkflow(`${META}return await run_agent('x', args.options);`, {
        args: {
          options: {
            schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } },
          },
        },
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent,
      }),
    ).rejects.toThrow(/schema validation failed.*additionalProperties/i);
    expect(calls).toBe(0);
  });

  it("requires at least one subagent call", async () => {
    await expect(
      runWorkflow(`${META}return 'no subagents';`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent: echo,
      }),
    ).rejects.toThrow(/must call run_agent/i);
  });

  it("allows idiomatic computed member access (obj[key], arr[i], { [k]: v })", async () => {
    // The node:vm is explicitly not a security boundary (workflow subagents run
    // with full tools), so the former "dynamic code / constructor escape"
    // hardening was dropped. Its unavoidable side effect was banning all computed
    // access with a non-literal key, which broke ordinary data-shaping scripts
    // that models reach for constantly. Those must now parse and run.
    const result = await runWorkflow(
      `${META}const files = ['a', 'b'];\n` +
        `const out = {};\n` +
        `for (let i = 0; i < files.length; i++) {\n` +
        `  const r = await run_agent('x:' + files[i], { label: 'a' + i });\n` +
        `  out[files[i]] = r;\n` +
        `}\n` +
        `const dyn = { [files[0]]: out[files[0]] };\n` +
        `return { out, dyn, first: out[files[0]] };`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runSubagent: echo },
    );
    expect(result.subagentCount).toBe(2);
    expect(result.result).toEqual({
      out: { a: "x:a", b: "x:b" },
      dyn: { a: "x:a" },
      first: "x:a",
    });
  });

  it("still rejects nondeterminism reached through computed/aliased forms", () => {
    expect(() => parseWorkflowScript(`${META}const r = Math.random();`)).toThrow(/deterministic/);
    expect(() => parseWorkflowScript(`${META}const d = new Date();`)).toThrow(/deterministic|Date/i);
  });

  it("waits for started but unawaited subagent calls before failing", async () => {
    let completed = false;
    await expect(
      runWorkflow(`${META}run_agent('slow', { label: 'late' }).then(() => log('late done'));\nreturn 'early';`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent: async () => {
          await delay(5);
          completed = true;
          return "late";
        },
      }),
    ).rejects.toThrow(/awaited before the workflow returns/);
    expect(completed).toBe(true);
  });

  it("does not allow promise reactions to start new subagents after return", async () => {
    const completed: string[] = [];
    await expect(
      runWorkflow(
        `${META}run_agent('a', { label: 'a' }).then(() => run_agent('b', { label: 'b' }).then(() => log('b done'))).catch(() => {});\nreturn 'early';`,
        {
          cwd: "/tmp",
          limiter: new ConcurrencyLimiter(4),
          runSubagent: async (call) => {
            completed.push(call.label);
            return call.label;
          },
        },
      ),
    ).rejects.toThrow(/awaited before the workflow returns|cannot be called after the workflow body has returned/);
    expect(completed).toEqual(["a"]);
  });


  it("normalizes labels and profile before applying defaults", async () => {
    const seen: Array<{ label: string; profile: string }> = [];
    const runSubagent: WorkflowSubagentRunner = async (call) => {
      seen.push({ label: call.label, profile: call.profile });
      return call.label;
    };
    await runWorkflow(
      `${META}await run_agent('a', { label: ' one ', profile: ' custom-agent ' });\nawait run_agent('b', { label: '   ', profile: '   ' });\nreturn null;`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runSubagent },
    );
    expect(seen).toEqual([
      { label: "one", profile: "custom-agent" },
      { label: "subagent 2", profile: "general-purpose" },
    ]);
  });

  it("passes normalized workflow subagent session_key through to the shared subagent runner", async () => {
    const seen: Array<string | undefined> = [];
    const runSubagent: WorkflowSubagentRunner = async (call) => {
      seen.push(call.sessionKey);
      return call.label;
    };
    await runWorkflow(
      `${META}await run_agent('a', { label: 'worker-1', session_key: ' worker ' });\nawait run_agent('b', { label: 'worker-2', session_key: '   ' });\nreturn null;`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runSubagent },
    );
    expect(seen).toEqual(["worker", undefined]);
  });

  it("serializes workflow session_key calls before acquiring global limiter slots", async () => {
    const locks = new SessionKeyLocks();
    const events: string[] = [];
    let releaseA: (() => void) | undefined;
    const runSubagent: WorkflowSubagentRunner = async (call) => {
      events.push(`start:${call.label}`);
      if (call.label === "a") {
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
      }
      events.push(`end:${call.label}`);
      return call.label;
    };

    const run = runWorkflow(
      `${META}return await parallel([\n  () => run_agent('a', { label: 'a', session_key: 'shared' }),\n  () => run_agent('b', { label: 'b', session_key: 'shared' }),\n  () => run_agent('c', { label: 'c', session_key: 'other' }),\n]);`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        serializeSubagent: (sessionKey, task) => locks.run(sessionKey, task),
        runSubagent,
      },
    );

    await waitUntil(() => events.includes("start:c"));
    expect(events).not.toContain("end:a");
    releaseA?.();
    await expect(run).resolves.toMatchObject({ result: ["a", "b", "c"] });
  });

  it("exposes args to the script", async () => {
    const result = await runWorkflow(`${META}return await run_agent('use ' + args.topic, { label: 'x' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runSubagent: echo,
      args: { topic: "auth" },
    });
    expect(result.result).toBe("use auth");
  });

  it("caps concurrent subagents at the shared limiter max", async () => {
    let current = 0;
    let peak = 0;
    const runSubagent: WorkflowSubagentRunner = async () => {
      current++;
      peak = Math.max(peak, current);
      await delay(5);
      current--;
      return "done";
    };
    const result = await runWorkflow(
      `${META}return await parallel([1, 2, 3, 4, 5].map((i) => () => run_agent('t' + i, { label: 'a' + i })));`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(2), runSubagent },
    );
    const values = result.result as string[];
    expect(values).toHaveLength(5);
    expect(values.every((value) => value === "done")).toBe(true);
    expect(peak).toBe(2);
    expect(result.subagentCount).toBe(5);
  });

  it("pipelines each item through stages while items run concurrently", async () => {
    const upper: WorkflowSubagentRunner = async (call) => call.prompt.toUpperCase();
    const result = await runWorkflow(
      `${META}return await pipeline(['a', 'b'], (item) => run_agent(item, { label: 's1-' + item }), (prev, item) => run_agent(prev + '-' + item, { label: 's2-' + item }));`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runSubagent: upper },
    );
    expect(result.result).toEqual(["A-A", "B-B"]);
  });

  it("returns null and logs when an agent fails", async () => {
    const logs: string[] = [];
    const subagentResults: WorkflowSubagentResultEvent[] = [];
    const result = await runWorkflow(`${META}return await run_agent('x', { label: 'boom' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: async () => {
        throw new Error("kaboom");
      },
      onLog: (message) => logs.push(message),
      onSubagentResult: (event) => { subagentResults.push(event); },
    });
    expect(result.result).toBeNull();
    expect(logs.some((line) => line.includes("boom") && line.includes("kaboom"))).toBe(true);
    expect(subagentResults).toEqual([
      expect.objectContaining({ label: "boom", result: null, failed: true, error: "kaboom" }),
    ]);
  });

  it("does not treat a successful null subagent result as a failed subagent", async () => {
    const ended: Array<{ result: unknown; failed?: boolean }> = [];
    const result = await runWorkflow(`${META}return await run_agent('x', { label: 'nullable' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: async () => null,
      onSubagentEnd: (event) => ended.push({ result: event.result, failed: event.failed }),
    });
    expect(result.result).toBeNull();
    expect(ended).toEqual([{ result: null, failed: false }]);
  });

  it("isolates a failing parallel branch without sinking the others", async () => {
    const runSubagent: WorkflowSubagentRunner = async (call) => {
      if (call.label === "bad") {
        throw new Error("nope");
      }
      return call.label;
    };
    const result = await runWorkflow(
      `${META}return await parallel([
        () => run_agent('1', { label: 'ok1' }),
        () => run_agent('2', { label: 'bad' }),
        () => run_agent('3', { label: 'ok2' }),
      ]);`,
      { cwd: "/tmp", limiter: new ConcurrencyLimiter(4), runSubagent },
    );
    expect(result.result).toEqual(["ok1", null, "ok2"]);
  });

  it("propagates abort raised mid-run", async () => {
    const controller = new AbortController();
    const runSubagent: WorkflowSubagentRunner = async () => {
      controller.abort();
      return "late";
    };
    await expect(
      runWorkflow(`${META}return await run_agent('x', { label: 'a' });`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("pairs queue and end callbacks for successful and nonfatal calls", async () => {
    const queued: number[] = [];
    const ended: Array<{ index: number; failed?: boolean }> = [];
    const result = await runWorkflow(
      `${META}return await parallel([() => run_agent('ok', { label: 'ok' }), () => run_agent('bad', { label: 'bad' })]);`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runSubagent: async (call) => {
          if (call.label === "bad") {
            throw new Error("expected failure");
          }
          return "ok";
        },
        onSubagentQueued: (event) => queued.push(event.index),
        onSubagentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
      },
    );

    expect(result.result).toEqual(["ok", null]);
    expect(queued.sort()).toEqual([1, 2]);
    expect(ended.sort((left, right) => left.index - right.index)).toEqual([
      { index: 1, failed: false },
      { index: 2, failed: true },
    ]);
  });

  it("ends a queued call exactly once when the workflow aborts", async () => {
    const controller = new AbortController();
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const queued: number[] = [];
    const started: number[] = [];
    const ended: Array<{ index: number; failed?: boolean }> = [];
    const run = runWorkflow(`${META}return await run_agent('x', { label: 'queued' });`, {
      cwd: "/tmp",
      limiter,
      runSubagent: echo,
      signal: controller.signal,
      onSubagentQueued: (event) => queued.push(event.index),
      onSubagentStart: (event) => started.push(event.index),
      onSubagentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
    });

    await waitUntil(() => limiter.pendingCount === 1);
    controller.abort();
    release();
    await expect(run).rejects.toThrow(/abort/i);
    expect(queued).toEqual([1]);
    expect(started).toEqual([]);
    expect(ended).toEqual([{ index: 1, failed: true }]);
  });

  it("ends an in-flight call exactly once when the workflow aborts", async () => {
    const controller = new AbortController();
    const queued: number[] = [];
    const started: number[] = [];
    const ended: Array<{ index: number; failed?: boolean }> = [];

    await expect(
      runWorkflow(`${META}return await run_agent('x', { label: 'running' });`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: async () => {
          controller.abort();
          return "late";
        },
        signal: controller.signal,
        onSubagentQueued: (event) => queued.push(event.index),
        onSubagentStart: (event) => started.push(event.index),
        onSubagentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
      }),
    ).rejects.toThrow(/abort/i);

    expect(queued).toEqual([1]);
    expect(started).toEqual([1]);
    expect(ended).toEqual([{ index: 1, failed: true }]);
  });

  it("ends a queued call exactly once when the workflow fails fatally", async () => {
    const queued: number[] = [];
    const ended: Array<{ index: number; failed?: boolean }> = [];

    await expect(
      runWorkflow(`${META}return await parallel([() => run_agent('first'), () => run_agent('over-limit')]);`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: async (_call, signal) => {
          await new Promise<void>((resolve) => {
            if (!signal || signal.aborted) {
              resolve();
              return;
            }
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          return "late";
        },
        limits: { maxSubagentCalls: 1 },
        onSubagentQueued: (event) => queued.push(event.index),
        onSubagentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
      }),
    ).rejects.toThrow(/maximum workflow run_agent calls exceeded/);

    expect(queued).toEqual([1]);
    expect(ended).toEqual([{ index: 1, failed: true }]);
  });

  it("does not settle an aborted workflow before active subagents release limiter slots", async () => {
    const controller = new AbortController();
    const limiter = new ConcurrencyLimiter(1);
    let childSettled = false;
    await expect(
      runWorkflow(`${META}return await run_agent('x', { label: 'a' });`, {
        cwd: "/tmp",
        limiter,
        runSubagent: async () => {
          controller.abort();
          await delay(40);
          childSettled = true;
          return "late";
        },
        signal: controller.signal,
        limits: { abortGraceMs: 5 },
      }),
    ).rejects.toThrow(/abort/i);

    expect(childSettled).toBe(true);
    expect(limiter.activeCount).toBe(0);
  });

  it("does not let scripts swallow abort and report success", async () => {
    const controller = new AbortController();
    await expect(
      runWorkflow(`${META}try { await run_agent('x', { label: 'a' }); } catch { return 'ignored abort'; }`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: async () => {
          controller.abort();
          return "late";
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
  });

  it("terminates an async script worker that stalls after an await", async () => {
    await expect(
      runWorkflow(`${META}await Promise.resolve();\nwhile (true) {}`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: echo,
        limits: { workerHeartbeatIntervalMs: 10, workerStallTimeoutMs: 50, abortGraceMs: 10 },
      }),
    ).rejects.toThrow(/stalled/i);
  });

  it("terminates a responsive script worker that stops making workflow progress", async () => {
    await expect(
      runWorkflow(`${META}await new Promise(() => {});`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: echo,
        limits: { workerHeartbeatIntervalMs: 10, workerStallTimeoutMs: 1_000, workerIdleTimeoutMs: 50 },
      }),
    ).rejects.toThrow(/no progress/i);
  });

  it("enforces a maximum number of workflow subagent calls", async () => {
    await expect(
      runWorkflow(`${META}return await parallel([1, 2, 3].map((i) => () => run_agent('x' + i, { label: 'a' + i })));`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(2),
        runSubagent: echo,
        limits: { maxSubagentCalls: 2 },
      }),
    ).rejects.toThrow(/maximum workflow run_agent calls/i);
  });

  it("requires workflow limits to be positive integers", async () => {
    await expect(
      runWorkflow(`${META}return await run_agent('x');`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: echo,
        limits: { maxSubagentCalls: 0.5 },
      }),
    ).rejects.toThrow(/positive integer/i);
  });

  it("rejects workflow results that cannot be represented as JSON", async () => {
    await expect(
      runWorkflow(`${META}await run_agent('x', { label: 'a' });\nreturn 1n;`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: echo,
      }),
    ).rejects.toThrow(/JSON-serializable/i);
  });

  it("rejects class instances in workflow results instead of flattening them", async () => {
    await expect(
      runWorkflow(`${META}await run_agent('x', { label: 'a' });\nclass Box { constructor() { this.value = 1; } }\nreturn new Box();`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: echo,
      }),
    ).rejects.toThrow(/non-plain object Box/i);
  });

  it("rejects class instances returned by subagents instead of flattening them", async () => {
    class Box {
      value = 1;
    }
    const logs: string[] = [];
    const result = await runWorkflow(`${META}return await run_agent('x', { label: 'a' });`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runSubagent: async () => new Box(),
      onLog: (message) => logs.push(message),
    });

    expect(result.result).toBeNull();
    expect(logs.some((line) => /non-plain object Box/i.test(line))).toBe(true);
  });

  it("normalizes JSON-like workflow results to canonical JSON", async () => {
    const result = await runWorkflow(`${META}await run_agent('x', { label: 'a' });\nreturn { ok: true, omitted: undefined, bad: NaN, list: [undefined, Infinity, 'x'] };`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(1),
      runSubagent: echo,
    });
    expect(result.result).toEqual({ ok: true, bad: null, list: [null, null, "x"] });
  });

  it("requires every subagent call to be awaited or returned", async () => {
    await expect(
      runWorkflow(`${META}return { pending: run_agent('x', { label: 'a' }) };`, {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(1),
        runSubagent: echo,
      }),
    ).rejects.toThrow(/awaited or returned/);
  });

  it("logs agent-result hook failures without aborting sibling work", async () => {
    let completed = 0;
    const logs: string[] = [];
    const result = await runWorkflow(`${META}return await parallel([\n() => run_agent('fast', { label: 'fast' }),\n() => run_agent('slow', { label: 'slow' })\n]);`, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: async (call) => {
        if (call.label === "slow") await delay(5);
        completed++;
        return call.label;
      },
      onSubagentResult: (event) => {
        if (event.label === "fast") {
          throw new Error("journal full");
        }
      },
      onLog: (message) => logs.push(message),
    });
    expect(result.result).toEqual(["fast", "slow"]);
    expect(completed).toBe(2);
    expect(logs.some((line) => line.includes("journal full"))).toBe(true);
  });

  it("reuses cached subagent results for the longest unchanged prefix on resume", async () => {
    const firstRunEvents: any[] = [];
    const firstRun = await runWorkflow(
      `${META}const a = await run_agent('first', { label: 'one' });\nconst b = await run_agent('second', { label: 'two' });\nreturn [a, b];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent: async (call) => `${call.prompt}:live1`,
        onSubagentResult: (event) => {
          firstRunEvents.push(event);
        },
      },
    );
    expect(firstRun.result).toEqual(["first:live1", "second:live1"]);

    const secondRunEvents: any[] = [];
    const livePrompts: string[] = [];
    const queued: number[] = [];
    const ended: Array<{ index: number; cached?: boolean }> = [];
    const secondRun = await runWorkflow(
      `${META}const a = await run_agent('first', { label: 'one' });\nconst b = await run_agent('second changed', { label: 'two' });\nreturn [a, b];`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent: async (call) => {
          livePrompts.push(call.prompt);
          return `${call.prompt}:live2`;
        },
        resumeSubagentResults: firstRunEvents.map(({ index, fingerprint, result }) => ({ index, fingerprint, result })),
        onSubagentResult: (event) => {
          secondRunEvents.push(event);
        },
        onSubagentQueued: (event) => queued.push(event.index),
        onSubagentEnd: (event) => ended.push({ index: event.index, cached: event.cached }),
      },
    );

    expect(secondRun.result).toEqual(["first:live1", "second changed:live2"]);
    expect(livePrompts).toEqual(["second changed"]);
    expect(secondRunEvents.map((event) => event.cached)).toEqual([true, false]);
    expect(queued).toEqual([1, 2]);
    expect(ended).toEqual([
      { index: 1, cached: true },
      { index: 2, cached: false },
    ]);
  });

  it("does not replay cached failed subagent results on resume", async () => {
    const firstRunEvents: any[] = [];
    const script = `${META}const a = await run_agent('first', { label: 'one' });\nconst b = await run_agent('second', { label: 'two' });\nreturn [a, b];`;
    await runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: async (call) => {
        if (call.label === "two") throw new Error("transient");
        return `${call.prompt}:live1`;
      },
      onSubagentResult: (event) => {
        firstRunEvents.push(event);
      },
    });

    const liveLabels: string[] = [];
    const secondRunEvents: any[] = [];
    const second = await runWorkflow(script, {
      cwd: "/tmp",
      limiter: new ConcurrencyLimiter(4),
      runSubagent: async (call) => {
        liveLabels.push(call.label);
        return `${call.prompt}:live2`;
      },
      resumeSubagentResults: firstRunEvents.map(({ index, fingerprint, result, failed }) => ({ index, fingerprint, result, failed })),
      onSubagentResult: (event) => {
        secondRunEvents.push(event);
      },
    });

    expect(second.result).toEqual(["first:live1", "second:live2"]);
    expect(liveLabels).toEqual(["two"]);
    expect(secondRunEvents.map((event) => event.cached)).toEqual([true, false]);
  });

  it("emits phase, agent start/end, and failure-log progress events in order", async () => {
    const events: string[] = [];
    const runSubagent: WorkflowSubagentRunner = async (call) => {
      if (call.label === "boom") {
        throw new Error("kaboom");
      }
      return call.label;
    };
    await runWorkflow(
      `${META}phase('scan');\nawait run_agent('a', { label: 'ok' });\nawait run_agent('b', { label: 'boom' });\nreturn null;`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent,
        onPhase: (title) => events.push(`phase:${title}`),
        onSubagentStart: (event) => events.push(`start:${event.label}`),
        onSubagentEnd: (event) => events.push(`end:${event.label}:${event.result === null ? "fail" : "ok"}`),
        onLog: () => events.push("log"),
      },
    );
    expect(events).toContain("phase:scan");
    expect(events).toContain("start:ok");
    expect(events).toContain("end:ok:ok");
    expect(events).toContain("start:boom");
    expect(events).toContain("end:boom:fail");
    expect(events).toContain("log");
    expect(events.indexOf("phase:scan")).toBeLessThan(events.indexOf("start:ok"));
    expect(events.indexOf("start:ok")).toBeLessThan(events.indexOf("end:ok:ok"));
  });

  it("assigns each agent a distinct index even when labels collide", async () => {
    const ended: Array<{ index: number; failed?: boolean }> = [];
    const runSubagent: WorkflowSubagentRunner = async (call) => {
      if (call.prompt === "boom") throw new Error("kaboom");
      return call.label;
    };
    await runWorkflow(
      `${META}await parallel([\n() => run_agent('ok', { label: 'dup' }),\n() => run_agent('boom', { label: 'dup' }),\n]);\nreturn null;`,
      {
        cwd: "/tmp",
        limiter: new ConcurrencyLimiter(4),
        runSubagent,
        onSubagentEnd: (event) => ended.push({ index: event.index, failed: event.failed }),
      },
    );
    // Same label, distinct indices: the UI keys on index so the failure mark lands on the right row.
    expect(ended.map((event) => event.index).sort()).toEqual([1, 2]);
    const byIndex = new Map(ended.map((event) => [event.index, event.failed]));
    expect(byIndex.get(1)).toBe(false);
    expect(byIndex.get(2)).toBe(true);
  });
});

describe("structured output capture", () => {
  it("captures the first successful call and ignores duplicate calls", async () => {
    const capture: StructuredOutputCapture = { value: undefined, called: false, count: 0, duplicateCall: false };
    const tool = createStructuredOutputTool({ type: "object" }, capture) as unknown as {
      execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; terminate?: boolean }>;
    };

    const first = await tool.execute("c1", { kind: "first" });
    expect(capture.value).toEqual({ kind: "first" });
    expect(capture.called).toBe(true);
    expect(first.terminate).toBe(true);
    expect(first.content[0].text).toContain("received");

    const second = await tool.execute("c2", { kind: "second" });
    expect(capture.value).toEqual({ kind: "first" });
    expect(capture.count).toBe(2);
    expect(capture.duplicateCall).toBe(true);
    expect(second.content[0].text).toContain("ignoring duplicate");
  });
});

describe("saved workflow registry", () => {
  function withTempDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      return fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  function workflowScript(name: string, description = "saved workflow"): string {
    return `export const meta = { name: '${name}', description: '${description}' };\nreturn await run_agent('hello');`;
  }

  it("loads global saved workflows from the agent dir", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      writeFileSync(join(agentDir, "workflows", "audit.js"), workflowScript("audit-todos", "Audit TODOs"));

      const registry = loadSavedWorkflowRegistry({ agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect([...registry.workflows.keys()]).toEqual(["audit-todos"]);
      expect(registry.workflows.get("audit-todos")?.description).toBe("Audit TODOs");
    });
  });

  it("loads project workflows only when the project is trusted and lets project override global", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const cwd = join(dir, "project");
      mkdirSync(join(agentDir, "workflows"), { recursive: true });
      mkdirSync(join(cwd, ".pi", "workflows"), { recursive: true });
      writeFileSync(join(agentDir, "workflows", "review.js"), workflowScript("review", "Global review"));
      writeFileSync(join(cwd, ".pi", "workflows", "review.js"), workflowScript("review", "Project review"));

      const untrusted = loadSavedWorkflowRegistry({ agentDir, cwd, projectTrusted: false });
      expect(untrusted.workflows.get("review")?.description).toBe("Global review");

      const trusted = loadSavedWorkflowRegistry({ agentDir, cwd, projectTrusted: true });
      expect(trusted.workflows.get("review")?.description).toBe("Project review");
      expect(trusted.workflows.get("review")?.scope).toBe("project");
    });
  });

  it("skips invalid workflows and symlinks escaping the workflow root", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const workflowsDir = join(agentDir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      writeFileSync(join(workflowsDir, "bad-meta.js"), "export const meta = buildMeta();\n");
      writeFileSync(join(dir, "outside.js"), workflowScript("outside"));
      symlinkSync(join(dir, "outside.js"), join(workflowsDir, "escape.js"));

      const registry = loadSavedWorkflowRegistry({ agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect([...registry.workflows.keys()]).toEqual([]);
      expect(registry.warnings.some((warning) => warning.includes("bad-meta"))).toBe(true);
      expect(registry.warnings.some((warning) => warning.includes("outside") || warning.includes("escape"))).toBe(true);
    });
  });

  it("rejects scriptPath workflows in saved roots when meta.name is not a saved-workflow name", () => {
    withTempDir((dir) => {
      const agentDir = join(dir, "agent");
      const workflowsDir = join(agentDir, "workflows");
      mkdirSync(workflowsDir, { recursive: true });
      const scriptPath = join(workflowsDir, "bad-name.js");
      writeFileSync(scriptPath, workflowScript("Bad Name"));

      const result = loadWorkflowScriptPath(scriptPath, { agentDir, cwd: join(dir, "project"), projectTrusted: false });

      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.message).toContain("meta.name must match");
    });
  });

  it("does not overwrite an existing persisted script snapshot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      const path = await persistWorkflowScript({
        dir,
        metaName: "immutable",
        scriptHash: "abcdef1234567890",
        script: "original",
      });
      writeFileSync(path, "mutated");

      await expect(persistWorkflowScript({
        dir,
        metaName: "immutable",
        scriptHash: "abcdef1234567890",
        script: "original",
      })).rejects.toThrow("does not match");
      expect(readFileSync(path, "utf8")).toBe("mutated");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads a resume journal up to a malformed trailing line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-workflows-"));
    try {
      const taskId = "task_resume_test";
      writeFileSync(
        join(dir, `task-${taskId}.jsonl`),
        [
          JSON.stringify({ type: "task_start", version: 3, taskId }),
          JSON.stringify({ type: "task_log", message: "first diagnostic" }),
          JSON.stringify({ type: "subagent_result", index: 1, fingerprint: "a", result: "one" }),
          "{ truncated",
          JSON.stringify({ type: "subagent_result", index: 2, fingerprint: "b", result: "two" }),
        ].join("\n"),
      );

      const journal = await loadWorkflowJournal(dir, taskId);

      expect(journal?.status).toBe("running");
      expect(journal?.logs).toEqual(["first diagnostic"]);
      expect(journal?.subagentResults).toEqual([{ index: 1, fingerprint: "a", result: "one", failed: false }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("run_workflow tool rendering", () => {
  const taskManager = new SynchronousTaskManager();
  const tool = createRunWorkflowTool({
    getTaskManager: () => taskManager,
    getLimiter: () => new ConcurrencyLimiter(4),
    getThinkingLevel: () => "high",
    getSubagentTimeoutMs: () => 0,
  }) as unknown as {
    renderCall: (args: unknown, theme: Theme, context: { executionStarted: boolean }) => { render: (width: number) => string[] };
    renderResult: (result: unknown, options: unknown, theme: Theme) => { render: (width: number) => string[] };
  };

  it("renders the call label and hides it once execution starts", () => {
    const theme = makeMockTheme();
    const before = renderToText(tool.renderCall({ name: "audit", script: "export const meta = {}" }, theme, { executionStarted: false }));
    expect(before).toContain("Workflow(audit)");
    const after = renderToText(tool.renderCall({ name: "audit", script: "..." }, theme, { executionStarted: true }));
    expect(after.trim()).toBe("");
  });

  it("renders live phases and subagents", () => {
    const theme = makeMockTheme();
    const details = {
      taskId: "task_123",
      name: "audit",
      status: "running",
      subagentCount: 2,
      phases: ["scan"],
      plannedPhases: [{ title: "scan" }, { title: "review" }],
      currentPhase: "scan",
      logs: [],
      frame: 1,
      subagents: [
        { index: 1, label: "source", profile: "general-purpose", backend: "pi", phase: "scan", status: "running", activity: ["read src"], activityCount: 1 },
        { index: 2, label: "tests", profile: "general-purpose", backend: "pi", phase: "scan", status: "queued", activity: [], activityCount: 0 },
      ],
    };
    const text = renderToText(tool.renderResult({ content: [], details }, {}, theme));

    expect(text).toContain("Workflow(audit) running · 0/2");
    expect(text).toContain("▶ scan running · 0/2");
    expect(text).toContain("Pi Agent(general-purpose: source)");
    expect(text).toContain("read src");
    expect(text).toContain("◌ Pi Agent(general-purpose, tests) queued");
    expect(text).toContain("· review planned · 0/0");
  });

  it("renders accurate aggregate totals around a bounded phase and agent window", () => {
    const theme = makeMockTheme();
    const details = {
      taskId: "task_large",
      name: "large-review",
      status: "running",
      subagentCount: 50,
      subagentStatusCounts: { queued: 5, running: 10, done: 30, error: 5, aborted: 0 },
      phaseCount: 20,
      phases: ["scan", "review"],
      phaseSummaries: [
        {
          id: 1,
          title: "scan",
          planned: true,
          reached: true,
          current: false,
          subagentCount: 35,
          statusCounts: { queued: 0, running: 0, done: 30, error: 5, aborted: 0 },
        },
        {
          id: 2,
          title: "review",
          planned: true,
          reached: true,
          current: true,
          subagentCount: 15,
          statusCounts: { queued: 5, running: 10, done: 0, error: 0, aborted: 0 },
        },
      ],
      plannedPhases: [{ title: "scan" }, { title: "review" }],
      currentPhase: "review",
      subagents: [
        { index: 31, phaseId: 1, phase: "scan", label: "failed scan", profile: "general-purpose", backend: "pi", status: "error", error: "scan failed" },
        { index: 41, phaseId: 2, phase: "review", label: "active review", profile: "general-purpose", backend: "pi", status: "running", activity: ["reviewing"], activityCount: 1 },
      ],
      logCount: 50,
      logs: ["log 48", "log 49", "log 50"],
    };

    const text = renderToText(tool.renderResult({ content: [], details }, {}, theme));

    expect(text).toContain("Workflow(large-review) running · 30/50");
    expect(text).toContain("⚠ scan partial · 30/35");
    expect(text).toContain("▶ review running · 0/15");
    expect(text).toContain("... 34 more");
    expect(text).toContain("... 14 more");
    expect(text).toContain("... 18 more phase(s)");
    expect(text).toContain("... 47 earlier log(s) not shown");
    expect(text).toContain("failed scan");
    expect(text).toContain("active review");
  });

  it("renders completed and failed workflow snapshots", () => {
    const theme = makeMockTheme();
    const completed = {
      taskId: "task_done",
      name: "review",
      status: "completed",
      subagentCount: 1,
      phases: [],
      logs: ["review logged"],
      subagents: [
        { index: 1, label: "reviewer", profile: "general-purpose", backend: "pi", status: "done" },
      ],
    };
    const failed = {
      taskId: "task_failed",
      name: "broken",
      status: "error",
      subagentCount: 0,
      phases: [],
      logs: [],
      subagents: [],
      error: "invalid workflow",
    };
    const aborted = {
      taskId: "task_aborted",
      name: "cancelled",
      status: "aborted",
      subagentCount: 1,
      phases: [],
      logs: [],
      subagents: [
        {
          index: 1,
          label: "worker",
          profile: "general-purpose",
          backend: "pi",
          status: "aborted",
          error: "Pi session shut down",
        },
      ],
      error: "Pi session shut down",
    };

    const completedText = renderToText(tool.renderResult({ content: [], details: completed }, {}, theme));
    const failedText = renderToText(tool.renderResult({ content: [], details: failed }, {}, theme));
    const abortedText = renderToText(tool.renderResult({ content: [], details: aborted }, {}, theme));

    expect(completedText).toContain("Workflow(review) completed · 1/1");
    expect(completedText).toContain("✓ Pi Agent(general-purpose, reviewer)");
    expect(completedText).toContain("review logged");
    expect(failedText).toContain("Workflow(broken) error · 0/0");
    expect(failedText).toContain("invalid workflow");
    expect(abortedText).toContain("Workflow(cancelled) aborted · 0/1");
    expect(abortedText).toContain("⊘ Pi Agent(general-purpose, worker) aborted: Pi session shut down");
  });
});

describe("run_workflow tool registration", () => {
  function fakeApi(names: string[]) {
    const flags = new Map<string, boolean | string>();
    return {
      registerTool: (tool: { name: string }) => names.push(tool.name),
      registerMessageRenderer: () => {},
      sendMessage: () => {},
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      getFlag: (name: string) => flags.get(name),
      on: () => {},
      getThinkingLevel: () => "high",
    };
  }

  it("registers both run_agent and run_workflow by default", () => {
    const names: string[] = [];
    createSubagentExtension()(fakeApi(names) as never);
    expect(names).toEqual(["run_agent", "run_workflow"]);
  });

  it("omits run_workflow when workflow is disabled", () => {
    const names: string[] = [];
    createSubagentExtension({ workflow: false })(fakeApi(names) as never);
    expect(names).toEqual(["run_agent"]);
  });
});
