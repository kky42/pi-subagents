import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function terminalEnvelope(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text) as {
    status: "completed" | "failed";
    content: string;
  };
}

describe("pi-subagent synchronous concurrency", () => {
  let agentDir = "";
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    makeExecutionContext,
  } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("keeps Promise.all calls pending while enforcing the concurrency limit", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 1 });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true });
    const firstGate = deferred();
    const updates: Record<string, any[]> = { first: [], second: [] };
    let active = 0;
    let maximum = 0;
    let started = 0;
    setContextRoutingResponses(registration, async () => {
      const index = ++started;
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (index === 1) await firstGate.promise;
        return fauxAssistantMessage(`child ${index} done`);
      } finally {
        active--;
      }
    });

    let batchSettled = false;
    const batch = Promise.all([
      tool.execute("first", { label: "First", prompt: "First task." }, undefined, (update: any) => updates.first.push(update), context),
      tool.execute("second", { label: "Second", prompt: "Second task." }, undefined, (update: any) => updates.second.push(update), context),
    ]).then((results) => {
      batchSettled = true;
      return results;
    });

    await waitUntil(() => started === 1 && updates.second.some((update) => update.details.status === "queued"));
    expect(batchSettled).toBe(false);
    expect(maximum).toBe(1);
    expect(updates.first.some((update) => update.details.status === "running")).toBe(true);
    expect(updates.second.some((update) => update.details.status === "running")).toBe(false);

    firstGate.resolve();
    const results = await batch;
    expect(results.map((result) => result.details.status)).toEqual(["done", "done"]);
    expect(results.map(terminalEnvelope)).toEqual([
      expect.objectContaining({ status: "completed", content: "child 1 done" }),
      expect.objectContaining({ status: "completed", content: "child 2 done" }),
    ]);
    expect(started).toBe(2);
    expect(maximum).toBe(1);
    expect(updates.second.some((update) => update.details.status === "running")).toBe(true);
    disposeSession(session);
  });

  it("runs independent calls concurrently when slots are available", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 2 });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    const gate = deferred();
    let active = 0;
    let maximum = 0;
    let started = 0;
    setContextRoutingResponses(registration, async () => {
      started++;
      active++;
      maximum = Math.max(maximum, active);
      await gate.promise;
      active--;
      return fauxAssistantMessage("done");
    });

    const pending = Promise.all([
      tool.execute("a", { label: "A", prompt: "A" }, undefined, undefined, context),
      tool.execute("b", { label: "B", prompt: "B" }, undefined, undefined, context),
    ]);
    await waitUntil(() => started === 2);
    expect(maximum).toBe(2);
    gate.resolve();
    const results = await pending;
    expect(results.map((result) => result.details.status)).toEqual(["done", "done"]);
    disposeSession(session);
  });

  it("uses the max-concurrency flag over the factory default", async () => {
    const { session, registration, model, modelRegistry } = await createSession({
      maxConcurrentSubagents: 3,
      maxConcurrentSubagentsFlag: "1",
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let active = 0;
    let maximum = 0;
    setContextRoutingResponses(registration, async () => {
      active++;
      maximum = Math.max(maximum, active);
      await delay(20);
      active--;
      return fauxAssistantMessage("done");
    });

    await Promise.all([
      tool.execute("flag-a", { label: "A", prompt: "A" }, undefined, undefined, context),
      tool.execute("flag-b", { label: "B", prompt: "B" }, undefined, undefined, context),
    ]);

    expect(maximum).toBe(1);
    disposeSession(session);
  });

  it("serializes calls that share a session key", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 2 });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true });
    const firstGate = deferred();
    const secondUpdates: any[] = [];
    let sharedActive = 0;
    let maximumShared = 0;
    let started = 0;
    setContextRoutingResponses(registration, async () => {
      const index = ++started;
      sharedActive++;
      maximumShared = Math.max(maximumShared, sharedActive);
      try {
        if (index === 1) await firstGate.promise;
        return fauxAssistantMessage(`shared ${index} done`);
      } finally {
        sharedActive--;
      }
    });

    const pending = Promise.all([
      tool.execute("shared-a", { label: "Shared A", prompt: "A", session_key: "worker" }, undefined, undefined, context),
      tool.execute("shared-b", { label: "Shared B", prompt: "B", session_key: "worker" }, undefined, (update: any) => secondUpdates.push(update), context),
    ]);

    await waitUntil(() => started === 1 && secondUpdates.some((update) => update.details.status === "queued"));
    expect(maximumShared).toBe(1);
    expect(secondUpdates.some((update) => update.details.status === "running")).toBe(false);
    firstGate.resolve();
    const results = await pending;

    expect(maximumShared).toBe(1);
    expect(results.map((result) => result.details.sessionKey)).toEqual(["worker", "worker"]);
    expect(results.map((result) => terminalEnvelope(result).status)).toEqual(["completed", "completed"]);
    disposeSession(session);
  });

  it("releases capacity after a rejected profile", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "bad-model.md"), "---\ndescription: Bad model.\nmodel: ghost/nope\n---\n");
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 1 });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, () => fauxAssistantMessage("valid child done"));

    const [invalid, valid] = await Promise.all([
      tool.execute("invalid", { label: "Invalid", prompt: "Fail.", profile: "bad-model" }, undefined, undefined, context),
      tool.execute("valid", { label: "Valid", prompt: "Run." }, undefined, undefined, context),
    ]);

    expect(invalid.details.status).toBe("error");
    expect(terminalEnvelope(invalid)).toEqual(expect.objectContaining({
      status: "failed",
      content: expect.stringContaining("Profile model not found: ghost/nope"),
    }));
    expect(valid.details.status).toBe("done");
    expect(terminalEnvelope(valid)).toEqual(expect.objectContaining({
      status: "completed",
      content: "valid child done",
    }));
    disposeSession(session);
  });
});
