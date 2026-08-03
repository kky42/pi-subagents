import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getSubagentProfiles } from "../src/profiles.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../src/core/spawn.ts";
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

describe("pi-subagent background progress and status", () => {
  let agentDir = "";
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    taskNotifications,
    waitForTaskNotification,
    executeAgentTask,
    makeExecutionContext,
  } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("returns an accepted envelope without live tool updates or waiting for the child", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const updates: unknown[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setContextRoutingResponses(registration, async (context) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      await gate;
      return fauxAssistantMessage("child complete");
    });

    const result = await tool.execute(
      "detached-call",
      { description: "Research config", prompt: "Inspect config loading." },
      undefined,
      (update: unknown) => updates.push(update),
      makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }),
    );

    expect(result.details).toEqual({
      task_id: expect.stringMatching(/^task_[a-f0-9]+$/),
      task_type: "agent",
      status: "accepted",
      session_key: expect.stringMatching(/^session_[a-f0-9]+$/),
      name: "Research config",
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    expect(result).not.toHaveProperty("usage");
    expect(updates).toEqual([]);

    release();
    const terminal = await waitForTaskNotification(session, result.details.task_id);
    expect(terminal).toEqual({
      ...result.details,
      status: "completed",
      content: "child complete",
    });
    disposeSession(session);
  });

  it.each(["tui", "rpc"] as const)("lets a %s root turn settle while its task keeps running", async (mode) => {
    const { session, registration } = await createSession({ mode });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        await gate;
        return fauxAssistantMessage("interactive child done");
      }
      if (!serialized.includes('"toolName":"Agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("Agent", { description: "Interactive child", prompt: "Wait for release." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(serialized.includes("interactive child done") ? "notification handled" : "task launched");
    });

    await session.prompt("Launch one background task.");
    const accepted = session.messages.find((message: any) => message.role === "toolResult" && message.toolName === "Agent") as any;
    expect(accepted.details.status).toBe("accepted");

    release();
    await waitForTaskNotification(session, accepted.details.task_id);
    await session.waitForIdle();
    disposeSession(session);
  });

  it("retries a terminal notification cleared from Pi's follow-up queue", async () => {
    const { session, registration } = await createSession({ mode: "tui" });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let rootContinuationStarted!: () => void;
    const rootStarted = new Promise<void>((resolve) => { rootContinuationStarted = resolve; });
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => { releaseRoot = resolve; });
    let notificationContexts = 0;

    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        await childGate;
        return fauxAssistantMessage("queued child done");
      }
      if (serialized.includes("queued child done")) {
        notificationContexts++;
        return fauxAssistantMessage("notification handled");
      }
      if (!serialized.includes('"toolName":"Agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("Agent", { description: "Queued child", prompt: "Wait for release." }),
        ], { stopReason: "toolUse" });
      }
      rootContinuationStarted();
      await rootGate;
      return fauxAssistantMessage("task launched");
    });

    const prompt = session.prompt("Launch one background task.");
    await rootStarted;
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "Agent") as any;
    releaseChild();
    await waitUntil(() => (session as any).agent.hasQueuedMessages());
    session.clearQueue();
    releaseRoot();
    await prompt;

    const terminal = await waitForTaskNotification(session, accepted.details.task_id);
    await session.waitForIdle();
    expect(terminal).toMatchObject({ status: "completed", content: "queued child done" });
    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(1);
    expect(notificationContexts).toBe(1);
    disposeSession(session);
  });

  it("delivers a task completed while the root agent settles exactly once", async () => {
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    let firstAgentEnd = true;
    const settlingExtension: ExtensionFactory = (pi) => {
      pi.on("agent_end", async () => {
        if (!firstAgentEnd) {
          return;
        }
        firstAgentEnd = false;
        releaseChild();
        await new Promise<void>((resolve) => setImmediate(resolve));
      });
    };
    const { session, registration } = await createSession({
      mode: "tui",
      extensionFactories: [settlingExtension],
    });
    let notificationContexts = 0;
    let terminalDelivered!: () => void;
    const terminalMessage = new Promise<void>((resolve) => { terminalDelivered = resolve; });
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-flow-task-notification"
      ) {
        terminalDelivered();
      }
    });

    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        await childGate;
        return fauxAssistantMessage("settling child done");
      }
      if (serialized.includes("settling child done")) {
        notificationContexts++;
        return fauxAssistantMessage("notification handled");
      }
      if (!serialized.includes('"toolName":"Agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("Agent", { description: "Settling child", prompt: "Wait for agent_end." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("task launched");
    });

    await session.prompt("Launch one background task.");
    await terminalMessage;
    await session.waitForIdle();
    unsubscribe();

    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "Agent") as any;
    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(1);
    expect(notificationContexts).toBe(1);
    disposeSession(session);
  });

  it("keeps task completion on its originating branch during tree navigation", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession({ mode: "tui" });
    let releaseChild!: () => void;
    setContextRoutingResponses(registration, (context, options) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return new Promise((resolve) => {
          releaseChild = () => resolve(fauxAssistantMessage("branch child done"));
          options.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("branch child aborted")), { once: true });
        });
      }
      if (serialized.includes("pi-flow-task-notification")) {
        return fauxAssistantMessage("notification observed");
      }
      if (!serialized.includes('"toolName":"Agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("Agent", { description: "Branch child", prompt: "Wait during tree navigation." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("task launched");
    });

    await session.prompt("Launch one background task.");
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "Agent") as any;
    await waitUntil(() => typeof releaseChild === "function");
    const userEntry = sessionManager.getEntries().find((entry: any) =>
      entry.type === "message" && entry.message.role === "user") as any;

    const navigation = await session.navigateTree(userEntry.id, { summarize: false });
    releaseChild();
    await waitUntil(() => sessionManager.getEntries().some((entry: any) =>
      entry.type === "custom_message" && entry.details?.task_id === accepted.details.task_id));
    await session.waitForIdle();

    expect(navigation.cancelled).toBe(false);
    const terminalEntry = sessionManager.getEntries().find((entry: any) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-flow-task-notification" &&
      entry.details?.task_id === accepted.details.task_id) as any;
    expect(terminalEntry?.details).toMatchObject({
      status: "failed",
      task_id: accepted.details.task_id,
      content: "Pi session tree changed",
    });
    expect(JSON.stringify(sessionManager.buildSessionContext().messages)).not.toContain(accepted.details.task_id);
    expect(sessionManager.getEntries().some((entry: any) =>
      entry.type === "custom" &&
      entry.customType === "pi-flow-subagent-session-key" &&
      entry.data?.key === accepted.details.session_key)).toBe(true);

    let newBranchChildContext: Context | undefined;
    setContextRoutingResponses(registration, (context) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      newBranchChildContext = context;
      return fauxAssistantMessage("new branch child done");
    });
    const tool = session.getToolDefinition("Agent") as any;
    const next = await tool.execute(
      "new-branch-call",
      {
        description: "New branch child",
        prompt: "Start fresh after navigation.",
        session_key: accepted.details.session_key,
      },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry, sessionManager }),
    );
    const nextTerminal = await waitForTaskNotification(session, next.details.task_id);

    expect(nextTerminal).toMatchObject({ status: "completed", content: "new branch child done" });
    const newBranchMessages = JSON.stringify(newBranchChildContext?.messages);
    expect(newBranchMessages).toContain("Start fresh after navigation.");
    expect(newBranchMessages).not.toContain("Wait during tree navigation.");
    disposeSession(session);
  });

  it.each(["print", "json"] as const)("keeps %s mode open until task notifications are processed", async (mode) => {
    const { session, registration } = await createSession({ mode });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        await gate;
        return fauxAssistantMessage(`${mode} child done`);
      }
      if (!serialized.includes('"toolName":"Agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("Agent", { description: "Print child", prompt: "Wait for release." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(serialized.includes(`${mode} child done`) ? `${mode} notification handled` : "task launched");
    });

    let settled = false;
    const prompt = session.prompt("Launch one background task.").then(() => { settled = true; });
    await waitUntil(() => session.messages.some((message: any) => message.role === "toolResult" && message.toolName === "Agent"));
    await delay(20);
    expect(settled).toBe(false);

    release();
    await prompt;
    const accepted = session.messages.find((message: any) => message.role === "toolResult" && message.toolName === "Agent") as any;
    const terminal = await waitForTaskNotification(session, accepted.details.task_id);
    expect(terminal).toMatchObject({ status: "completed", content: `${mode} child done` });
    expect(JSON.stringify(session.messages)).toContain(`${mode} notification handled`);
    disposeSession(session);
  });

  it("persists failed terminal notifications when extension reload aborts tasks", async () => {
    const { session, registration, sessionManager } = await createSession({ mode: "tui" });
    let childStarted = false;
    let rootNotificationCalls = 0;
    let rootContinuationStarted = false;
    let releaseRoot!: () => void;
    setContextRoutingResponses(registration, (context, options) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        const serialized = JSON.stringify(context.messages);
        if (serialized.includes("pi-flow-task-notification")) {
          rootNotificationCalls++;
        }
        if (!serialized.includes('"toolName":"Agent"')) {
          return fauxAssistantMessage([
            fauxToolCall("Agent", { description: "Reload child", prompt: "Wait until reload." }),
          ], { stopReason: "toolUse" });
        }
        rootContinuationStarted = true;
        return new Promise((resolve) => {
          releaseRoot = () => resolve(fauxAssistantMessage("task launched"));
        });
      }
      childStarted = true;
      return new Promise((resolve) => {
        if (options.signal?.aborted) {
          resolve(fauxAssistantMessage("aborted child"));
          return;
        }
        options.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("aborted child")), { once: true });
      });
    });
    const prompt = session.prompt("Launch one background task before reload.");
    await waitUntil(() => childStarted && rootContinuationStarted);
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "Agent") as any;

    await session.reload();
    releaseRoot();
    await prompt;

    expect(taskNotifications(session, accepted.details.task_id)).toEqual([]);
    const terminalEntry = sessionManager.getEntries().find((entry: any) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-flow-task-notification" &&
      entry.details?.task_id === accepted.details.task_id) as any;
    expect(terminalEntry?.details).toMatchObject({
      status: "failed",
      task_id: accepted.details.task_id,
      content: "Pi session shut down",
    });
    expect(rootNotificationCalls).toBe(0);
    disposeSession(session);
  });

  it("starts Agent and workflow tasks after a reused extension session boundary", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession({ mode: "tui" });
    let oldChildStarted = false;
    setContextRoutingResponses(registration, (context, options) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      oldChildStarted = true;
      return new Promise((resolve) => {
        if (options.signal?.aborted) {
          resolve(fauxAssistantMessage("aborted old child"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => resolve(fauxAssistantMessage("aborted old child")),
          { once: true },
        );
      });
    });
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    const oldAgentTool = session.getToolDefinition("Agent") as any;
    const oldAccepted = await oldAgentTool.execute(
      "old-session-call",
      { description: "Old session child", prompt: "Wait for the session boundary." },
      undefined,
      undefined,
      context,
    );
    await waitUntil(() => oldChildStarted);

    await session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
    expect(taskNotifications(session, oldAccepted.details.task_id)).toEqual([]);
    const terminalEntry = sessionManager.getEntries().find((entry) =>
      entry.type === "custom_message" && entry.customType === "pi-flow-task-notification");
    expect(terminalEntry?.type === "custom_message" ? terminalEntry.details : undefined).toMatchObject({
      status: "failed",
      task_id: oldAccepted.details.task_id,
      content: "Pi session shut down",
    });
    await session.extensionRunner.emit({ type: "session_start", reason: "new" });

    setContextRoutingResponses(registration, (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      return fauxAssistantMessage("new session child done");
    });
    const agentTool = session.getToolDefinition("Agent") as any;
    const agentAccepted = await agentTool.execute(
      "new-session-agent",
      { description: "New session agent", prompt: "Complete after the session boundary." },
      undefined,
      undefined,
      context,
    );
    const agentTerminal = await waitForTaskNotification(session, agentAccepted.details.task_id);

    const workflowTool = session.getToolDefinition("workflow") as any;
    const workflowAccepted = await workflowTool.execute(
      "new-session-workflow",
      {
        script: "export const meta = { name: 'new_session', description: 'Run after a new session' };\nreturn await agent('Complete after the session boundary.', { label: 'worker' });",
      },
      undefined,
      undefined,
      context,
    );
    const workflowTerminal = await waitForTaskNotification(session, workflowAccepted.details.task_id);

    expect(agentTerminal).toMatchObject({ status: "completed", content: "new session child done" });
    expect(workflowTerminal).toMatchObject({ status: "completed", content: "new session child done" });
    expect(taskNotifications(session, oldAccepted.details.task_id)).toEqual([]);
    disposeSession(session);
  });

  it("does not bind background execution to the foreground tool signal", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const controller = new AbortController();
    let childContext: Context | undefined;
    setContextRoutingResponses(registration, (context) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      childContext = context;
      return fauxAssistantMessage("detached child done");
    });

    controller.abort();
    const accepted = await tool.execute(
      "pre-aborted-call",
      { description: "Detached child", prompt: "Run despite the foreground signal." },
      controller.signal,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = await waitForTaskNotification(session, accepted.details.task_id);

    expect(accepted.details.status).toBe("accepted");
    expect(terminal.status).toBe("completed");
    expect(childContext).toBeDefined();
    disposeSession(session);
  });

  it("reports timeout through one failed terminal notification", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ subagentTimeoutMs: 20 });
    setContextRoutingResponses(registration, async (context) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      await delay(80);
      return fauxAssistantMessage("late output");
    });
    const tool = session.getToolDefinition("Agent") as any;
    const accepted = await tool.execute(
      "timeout-call",
      { description: "Slow child", prompt: "Take too long." },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = await waitForTaskNotification(session, accepted.details.task_id);

    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("Subagent timed out after 20ms");
    expect(terminal.task_id).toBe(accepted.details.task_id);
    disposeSession(session);
  });

  it("keeps backend progress and usage available for internal direct spawning", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const profile = getSubagentProfiles(agentDir).get("general-purpose")!;
    registration.setResponses([fauxAssistantMessage("direct child done")]);
    const progressUpdates: unknown[] = [];
    const result = await spawnSubagent({
      toolCallId: "internal-progress",
      description: "Internal child",
      prompt: "Inspect internals.",
      profile,
      model,
      thinkingLevel: "high",
      ctx: makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }) as unknown as ExtensionContext,
      signal: undefined,
      timeoutMs: 0,
      progressEnabled: true,
      onProgress: (partial) => progressUpdates.push(partial),
      onUsage: () => {},
      excludeTools: CHILD_EXCLUDED_TOOLS,
    });

    expect(result.details.status).toBe("done");
    expect(result.details.progress).toMatchObject({ id: "internal-progress", status: "done", backend: "pi" });
    expect(result.usage?.input).toBeGreaterThan(0);
    expect(result.usage?.output).toBeGreaterThan(0);
    expect(progressUpdates.length).toBeGreaterThan(0);
    disposeSession(session);
  });

  it("maps provider stop errors to internal backend errors", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const profile = getSubagentProfiles(agentDir).get("general-purpose")!;
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
    registration.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded (429)" }),
    ]);
    const result = await spawnSubagent({
      toolCallId: "provider-error",
      description: "Research config",
      prompt: "Inspect config loading.",
      profile,
      model,
      thinkingLevel: "high",
      ctx: makeExecutionContext({ hasUI: false, model, modelRegistry }) as unknown as ExtensionContext,
      signal: undefined,
      timeoutMs: 0,
      progressEnabled: true,
      onProgress: () => {},
      onUsage: () => {},
      excludeTools: CHILD_EXCLUDED_TOOLS,
    });

    expect(result.details.status).toBe("error");
    expect(result.details.error).toContain("rate limit exceeded");
    expect(result.details.progress?.status).toBe("error");
    disposeSession(session);
  });

  it("shows compact task counters and cumulative usage in the footer", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const statuses: Array<{ key: string; text: string | undefined }> = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onStatus: (key, text) => statuses.push({ key, text }),
    });

    await executeAgentTask(
      session,
      registration,
      context,
      { description: "Usage child", prompt: "Report usage." },
      async () => fauxAssistantMessage("usage child done"),
    );

    const footer = statuses.filter((status) => status.key === "pi-flow").at(-1)?.text ?? "";
    expect(footer).toContain("pi-flow [1/1] agents [0/0] workflows");
    expect(footer).toMatch(/↑\S+ ↓\S+ (?:R\S+ |W\S+ )*CH\d+\.\d%/);
    disposeSession(session);
  });
});
