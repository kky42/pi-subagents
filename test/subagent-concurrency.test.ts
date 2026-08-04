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

describe("pi-subagent background concurrency", () => {
  let agentDir = "";
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    waitForTaskNotification,
    makeExecutionContext,
  } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("accepts parallel calls immediately while limiting active children", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 1 });
    const tool = session.getToolDefinition("run_agent") as any;
    const widgets: Array<string[] | undefined> = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onWidget: (_key, lines) => widgets.push(lines),
    });
    let active = 0;
    let maximum = 0;
    let started = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    setContextRoutingResponses(registration, async (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      const index = ++started;
      active++;
      maximum = Math.max(maximum, active);
      try {
        if (index === 1) await firstGate;
        return fauxAssistantMessage(`child ${index} done`);
      } finally {
        active--;
      }
    });

    const first = await tool.execute("first", { label: "First", prompt: "First task." }, undefined, undefined, context);
    const second = await tool.execute("second", { label: "Second", prompt: "Second task." }, undefined, undefined, context);

    expect(first.details.status).toBe("accepted");
    expect(second.details.status).toBe("accepted");
    expect(first.details.task_id).not.toBe(second.details.task_id);
    expect(first.details.display).toEqual({ backend: "pi", profile: "general-purpose" });
    expect(JSON.parse(first.content[0].text)).toEqual({
      task_id: first.details.task_id,
      task_type: "agent",
      status: "accepted",
      session_key: first.details.session_key,
      label: "First",
    });
    await waitUntil(() => started === 1 && widgets.some((lines) =>
      lines?.includes("◌ Pi Agent(general-purpose: Second) queued") === true));
    expect(started).toBe(1);
    expect(maximum).toBe(1);
    const queuedUpdate = widgets.find((lines) =>
      lines?.includes("◌ Pi Agent(general-purpose: Second) queued") === true);
    expect(queuedUpdate?.[0]).toBe("pi-flow 2 agents and 0 workflows active");
    expect(queuedUpdate?.find((line) => line.includes("Second"))).toBe(
      "◌ Pi Agent(general-purpose: Second) queued",
    );

    releaseFirst();
    await waitUntil(() => started === 2 && widgets.some((lines) =>
      lines?.some((line) =>
        line.includes("Pi Agent(general-purpose: Second) 0s · 0 events")) === true));
    const terminals = await Promise.all([
      waitForTaskNotification(session, first.details.task_id),
      waitForTaskNotification(session, second.details.task_id),
    ]);
    expect(terminals.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(terminals).toEqual([
      expect.objectContaining({ display: { backend: "pi", profile: "general-purpose" } }),
      expect.objectContaining({ display: { backend: "pi", profile: "general-purpose" } }),
    ]);
    const notificationMessages = session.messages.filter((message: any) =>
      message.role === "custom" && message.customType === "pi-flow-task-notification");
    expect(notificationMessages).toHaveLength(2);
    for (const message of notificationMessages as any[]) {
      expect(JSON.parse(message.content)).not.toHaveProperty("display");
    }
    expect(started).toBe(2);
    expect(maximum).toBe(1);
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
    setContextRoutingResponses(registration, async (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      active++;
      maximum = Math.max(maximum, active);
      await delay(20);
      active--;
      return fauxAssistantMessage("done");
    });

    const accepted = await Promise.all([
      tool.execute("a", { label: "A", prompt: "A" }, undefined, undefined, context),
      tool.execute("b", { label: "B", prompt: "B" }, undefined, undefined, context),
    ]);
    await Promise.all(accepted.map((result) => waitForTaskNotification(session, result.details.task_id)));

    expect(maximum).toBe(1);
    disposeSession(session);
  });

  it("serializes calls that share a session key before consuming concurrency slots", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 2 });
    const tool = session.getToolDefinition("run_agent") as any;
    const widgets: Array<string[] | undefined> = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onWidget: (_key, lines) => widgets.push(lines),
    });
    let sharedActive = 0;
    let maximumShared = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let started = 0;
    setContextRoutingResponses(registration, async (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      const index = ++started;
      sharedActive++;
      maximumShared = Math.max(maximumShared, sharedActive);
      try {
        if (index === 1) {
          await firstGate;
        }
        return fauxAssistantMessage("shared done");
      } finally {
        sharedActive--;
      }
    });

    const accepted = await Promise.all([
      tool.execute("shared-a", { label: "Shared A", prompt: "A", session_key: "worker" }, undefined, undefined, context),
      tool.execute("shared-b", { label: "Shared B", prompt: "B", session_key: "worker" }, undefined, undefined, context),
    ]);
    await waitUntil(() => widgets.some((lines) =>
      lines?.includes("◌ Pi Agent(general-purpose: Shared B) queued") === true));
    await waitUntil(() => started === 1);
    expect(started).toBe(1);
    expect(widgets.some((lines) => lines?.some((line) =>
      line.includes("Pi Agent(general-purpose: Shared A) 0s · 0 events")) === true)).toBe(true);
    releaseFirst();
    await Promise.all(accepted.map((result) => waitForTaskNotification(session, result.details.task_id)));

    expect(maximumShared).toBe(1);
    expect(accepted.map((result) => result.details.session_key)).toEqual(["worker", "worker"]);
    disposeSession(session);
  });

  it("removes queued subagent status when session shutdown aborts the queue", async () => {
    const widgets: Array<string[] | undefined> = [];
    const { session, registration, model, modelRegistry } = await createSession({
      maxConcurrentSubagents: 1,
      onWidget: (_key, lines) => widgets.push(lines),
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onWidget: (_key, lines) => widgets.push(lines),
    });
    setContextRoutingResponses(registration, (providerContext, options) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      return new Promise((resolve) => {
        if (options.signal?.aborted) {
          resolve(fauxAssistantMessage("aborted"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => resolve(fauxAssistantMessage("aborted")),
          { once: true },
        );
      });
    });

    await tool.execute("running", { label: "Running", prompt: "Wait." }, undefined, undefined, context);
    await tool.execute("queued", { label: "Queued", prompt: "Wait." }, undefined, undefined, context);
    await waitUntil(() => widgets.some((lines) =>
      lines?.includes("◌ Pi Agent(general-purpose: Queued) queued") === true));

    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });

    expect(widgets.at(-1)).toBeUndefined();
    expect(widgets.slice(-2).some((lines) => lines?.some((line) => line.includes("queued")))).toBe(false);
    disposeSession(session);
  });

  it("a rejected profile does not prevent a queued valid task from completing", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "bad-model.md"), "---\ndescription: Bad model.\nmodel: ghost/nope\n---\n");
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 1 });
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) =>
      fauxAssistantMessage(providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")
        ? "notification observed"
        : "valid child done"));

    const invalid = await tool.execute(
      "invalid",
      { label: "Invalid", prompt: "Fail.", profile: "bad-model" },
      undefined,
      undefined,
      context,
    );
    const valid = await tool.execute("valid", { label: "Valid", prompt: "Run." }, undefined, undefined, context);
    const [invalidTerminal, validTerminal] = await Promise.all([
      waitForTaskNotification(session, invalid.details.task_id),
      waitForTaskNotification(session, valid.details.task_id),
    ]);

    expect(invalidTerminal.status).toBe("failed");
    expect(invalidTerminal.content).toContain("Profile model not found: ghost/nope");
    expect(validTerminal).toMatchObject({ status: "completed", content: "valid child done" });
    disposeSession(session);
  });
});
