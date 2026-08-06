import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  createProgressEmitter,
  MAX_ACTIVITY_LINE_CHARS,
  MAX_ACTIVITY_LINES,
  MAX_MODEL_VISIBLE_TEXT_CHARS,
  MAX_PROGRESS_METADATA_CHARS,
  MAX_PROGRESS_RESULT_CHARS,
  MAX_PROGRESS_UPDATE_JSON_CHARS,
} from "../src/core/progress.ts";
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
    task_id: string;
    task_type: "agent";
    status: "completed" | "failed";
    session_key: string;
    label: string;
    content: string;
  };
}

function customTaskNotifications(session: { messages: readonly unknown[] }): unknown[] {
  return session.messages.filter((message: any) =>
    message?.role === "custom" && message.customType === "pi-flow-task-notification");
}

describe("direct subagent progress payloads", () => {
  it("bounds heartbeat updates and keeps prior snapshots immutable", async () => {
    vi.useFakeTimers();
    try {
      const updates: any[] = [];
      const emitter = createProgressEmitter({
        label: `label-${"l".repeat(10_000)}`,
        profile: `profile-${"p".repeat(10_000)}`,
        backend: "pi",
        enabled: true,
        onProgress: (update) => updates.push(update),
      });
      for (let index = 0; index < 100; index++) {
        emitter.addActivity(`Read item ${index}: ${"activity ".repeat(2_000)}TAIL_${index}`);
      }

      emitter.emit();
      emitter.startHeartbeat();
      const firstUpdate = updates[0];
      const firstSerialized = JSON.stringify(firstUpdate);
      await vi.advanceTimersByTimeAsync(2_100);
      emitter.replaceLatestActivity(`Updated ${"z".repeat(20_000)}FINAL_TAIL`);
      emitter.emit();
      emitter.stop();

      expect(updates.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(firstUpdate)).toBe(firstSerialized);
      expect(updates.every((update) => JSON.stringify(update).length <= MAX_PROGRESS_UPDATE_JSON_CHARS)).toBe(true);
      for (const update of updates) {
        expect(update.details.label.length).toBeLessThanOrEqual(MAX_PROGRESS_METADATA_CHARS);
        expect(update.details.profile.length).toBeLessThanOrEqual(MAX_PROGRESS_METADATA_CHARS);
        expect(update.details.progress.activity).toHaveLength(MAX_ACTIVITY_LINES);
        expect(update.details.progress.activity.every((line: string) => line.length <= MAX_ACTIVITY_LINE_CHARS)).toBe(true);
        expect(update.details.progress.activityCount).toBe(100);
      }
      expect(JSON.stringify(updates.at(-1))).not.toContain("FINAL_TAIL");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("pi-subagent synchronous progress and lifecycle", () => {
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    makeExecutionContext,
  } = setupPiSubagentTestHarness();

  it("waits for the child and returns the terminal Tool result", async () => {
    const taskStates: unknown[] = [];
    const taskStateObserver: ExtensionFactory = (pi) => {
      pi.events.on("pi-flow:task-state", (event) => taskStates.push(event));
    };
    const { session, registration, model, modelRegistry } = await createSession({
      extensionFactories: [taskStateObserver],
    });
    const childGate = deferred();
    let childStarted = false;
    setContextRoutingResponses(registration, async () => {
      childStarted = true;
      await childGate.promise;
      return fauxAssistantMessage("child complete");
    });
    const tool = session.getToolDefinition("run_agent") as any;
    let settled = false;
    const pending = tool.execute(
      "blocking-call",
      { label: "Research config", prompt: "Inspect config loading." },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    ).then((result: any) => {
      settled = true;
      return result;
    });

    await waitUntil(() => childStarted);
    expect(settled).toBe(false);
    expect(taskStates).toEqual([{
      version: 1,
      task_id: expect.stringMatching(/^task_[a-f0-9]+$/),
      task_type: "agent",
      status: "accepted",
    }]);

    childGate.resolve();
    const result = await pending;
    const terminal = terminalEnvelope(result);

    expect(terminal).toEqual({
      task_id: result.details.taskId,
      task_type: "agent",
      status: "completed",
      session_key: result.details.sessionKey,
      label: "Research config",
      content: "child complete",
    });
    expect(result.details).toMatchObject({
      label: "Research config",
      profile: "general-purpose",
      backend: "pi",
      status: "done",
      result: "child complete",
      taskId: expect.stringMatching(/^task_[a-f0-9]+$/),
      sessionKey: expect.stringMatching(/^session_[a-f0-9]+$/),
    });
    expect(taskStates).toEqual([
      { version: 1, task_id: result.details.taskId, task_type: "agent", status: "accepted" },
      { version: 1, task_id: result.details.taskId, task_type: "agent", status: "completed" },
    ]);
    expect(customTaskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("bounds model-visible terminal text while keeping TUI details bounded", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const fullResult = `${"large direct result ".repeat(4_000)}DIRECT_RESULT_TAIL`;
    setContextRoutingResponses(registration, async () => fauxAssistantMessage(fullResult));
    const tool = session.getToolDefinition("run_agent") as any;
    const updates: any[] = [];

    const result = await tool.execute(
      "large-result-call",
      { label: "Large result", prompt: "Return the large result." },
      undefined,
      (update: unknown) => updates.push(update),
      makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }),
    );
    const terminal = terminalEnvelope(result);

    expect(terminal.content).toContain("[truncated]");
    expect(terminal.content.length).toBeLessThanOrEqual(MAX_MODEL_VISIBLE_TEXT_CHARS);
    expect(terminal.content).not.toContain("DIRECT_RESULT_TAIL");
    expect(result.details.result).toContain("[truncated]");
    expect(result.details.result.length).toBeLessThanOrEqual(MAX_PROGRESS_RESULT_CHARS);
    expect(result.details.progress.result).toContain("[truncated]");
    expect(result.details.progress.result.length).toBeLessThanOrEqual(MAX_PROGRESS_RESULT_CHARS);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((update) => JSON.stringify(update).length <= MAX_PROGRESS_UPDATE_JSON_CHARS)).toBe(true);
    expect(updates.some((update) => update.details.status === "done")).toBe(true);
    disposeSession(session);
  });

  it("emits queued, running, and terminal progress through onUpdate", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const childGate = deferred();
    setContextRoutingResponses(registration, async () => {
      await childGate.promise;
      return fauxAssistantMessage("progress child done");
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const updates: any[] = [];
    const pending = tool.execute(
      "progress-call",
      { label: "Progress child", prompt: "Wait for release." },
      undefined,
      (update: unknown) => updates.push(update),
      makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }),
    );

    await waitUntil(() => updates.some((update) => update.details.status === "running"));
    expect(updates.some((update) => update.details.status === "queued")).toBe(true);
    const queued = updates.find((update) => update.details.status === "queued");
    const running = updates.find((update) => update.details.status === "running");
    expect(running.details).toMatchObject({
      label: "Progress child",
      profile: "general-purpose",
      backend: "pi",
      taskId: expect.stringMatching(/^task_[a-f0-9]+$/),
      sessionKey: expect.stringMatching(/^session_[a-f0-9]+$/),
      progress: {
        status: "running",
      },
    });

    childGate.resolve();
    const result = await pending;
    const done = updates.slice().reverse().find((update) => update.details.status === "done");
    expect(done).toBeDefined();
    expect(queued.details).toMatchObject({
      status: "queued",
      progress: { status: "queued", activity: [] },
    });
    expect(running.details).toMatchObject({
      status: "running",
      progress: { status: "running", activity: [] },
    });
    expect(result.details).toMatchObject({
      status: "done",
      progress: { status: "done" },
      taskId: running.details.taskId,
      sessionKey: running.details.sessionKey,
    });
    expect(result.usage?.input).toBeGreaterThan(0);
    expect(result.usage?.output).toBeGreaterThan(0);
    expect(done.usage).toEqual(result.usage);
    expect(done.usage).not.toBe(result.usage);
    expect(done.usage.cost).not.toBe(result.usage?.cost);
    disposeSession(session);
  });

  it("returns an aborted Tool result without starting a pre-aborted call", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const controller = new AbortController();
    let childContext: Context | undefined;
    setContextRoutingResponses(registration, (context) => {
      childContext = context;
      return fauxAssistantMessage("should not run");
    });
    controller.abort();

    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "pre-aborted-call",
      { label: "Cancelled child", prompt: "Do not start." },
      controller.signal,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = terminalEnvelope(result);

    expect(result.details.status).toBe("aborted");
    expect(result.details.error).toBeTruthy();
    expect(terminal).toMatchObject({
      task_id: result.details.taskId,
      status: "failed",
      session_key: result.details.sessionKey,
      label: "Cancelled child",
    });
    expect(childContext).toBeUndefined();
    expect(customTaskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("returns timeout failure through the Tool result", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ subagentTimeoutMs: 20 });
    setContextRoutingResponses(registration, async () => {
      await delay(80);
      return fauxAssistantMessage("late output");
    });

    const tool = session.getToolDefinition("run_agent") as any;
    const result = await tool.execute(
      "timeout-call",
      { label: "Slow child", prompt: "Take too long." },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = terminalEnvelope(result);

    expect(result.details.status).toBe("aborted");
    expect(result.details.error).toContain("Subagent timed out after 20ms");
    expect(terminal).toEqual({
      task_id: result.details.taskId,
      task_type: "agent",
      status: "failed",
      session_key: result.details.sessionKey,
      label: "Slow child",
      content: expect.stringContaining("Subagent timed out after 20ms"),
    });
    expect(customTaskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("aborts an active Tool call on session shutdown", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    let childStarted = false;
    setContextRoutingResponses(registration, (_context, options) => {
      childStarted = true;
      return new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => resolve(fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Subagent aborted" })),
          { once: true },
        );
      });
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const pending = tool.execute(
      "shutdown-call",
      { label: "Shutdown child", prompt: "Wait for shutdown." },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    await waitUntil(() => childStarted);
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const result = await pending;
    const terminal = terminalEnvelope(result);

    expect(result.details.status).toBe("aborted");
    expect(result.details.error).toBe("Pi session shut down");
    expect(terminal).toMatchObject({
      task_id: result.details.taskId,
      status: "failed",
      content: "Pi session shut down",
    });
    expect(customTaskNotifications(session)).toEqual([]);
    disposeSession(session);
  });
});
