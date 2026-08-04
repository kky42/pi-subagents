import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("pi-subagent background progress and status", () => {
  let agentDir = "";
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    taskNotifications,
    waitForTaskNotification,
    executeSubagentTask,
    makeExecutionContext,
  } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  it("returns an accepted envelope without live tool updates or waiting for the child", async () => {
    const taskStates: unknown[] = [];
    const taskStateObserver: ExtensionFactory = (pi) => {
      pi.events.on("pi-flow:task-state", (event) => {
        taskStates.push(event);
      });
    };
    const { session, registration, model, modelRegistry } = await createSession({
      extensionFactories: [taskStateObserver],
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const updates: unknown[] = [];
    const terminalDelivered = deferred();
    let notificationContexts = 0;
    let notificationCopies = 0;
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-flow-task-notification"
      ) {
        terminalDelivered.resolve();
      }
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setContextRoutingResponses(registration, async (context) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        const notifications = context.messages.filter((message) =>
          JSON.stringify(message).includes("child complete"));
        if (notifications.length > 0) {
          notificationContexts++;
          notificationCopies += notifications.length;
        }
        return fauxAssistantMessage("notification observed");
      }
      await gate;
      return fauxAssistantMessage("child complete");
    });

    const result = await tool.execute(
      "detached-call",
      { label: "Research config", prompt: "Inspect config loading." },
      undefined,
      (update: unknown) => updates.push(update),
      makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }),
    );

    expect(result.details).toEqual({
      task_id: expect.stringMatching(/^task_[a-f0-9]+$/),
      task_type: "agent",
      status: "accepted",
      session_key: expect.stringMatching(/^session_[a-f0-9]+$/),
      label: "Research config",
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.details);
    expect(result).not.toHaveProperty("usage");
    expect(updates).toEqual([]);
    expect(taskStates).toEqual([{
      version: 1,
      task_id: result.details.task_id,
      task_type: "agent",
      status: "accepted",
    }]);

    release();
    await terminalDelivered.promise;
    await session.waitForIdle();
    const terminal = taskNotifications(session, result.details.task_id)[0];
    expect(terminal).toEqual({
      ...result.details,
      status: "completed",
      content: "child complete",
    });
    expect(notificationContexts).toBe(1);
    expect(notificationCopies).toBe(1);
    expect(taskStates).toEqual([
      {
        version: 1,
        task_id: result.details.task_id,
        task_type: "agent",
        status: "accepted",
      },
      {
        version: 1,
        task_id: result.details.task_id,
        task_type: "agent",
        status: "completed",
      },
    ]);
    unsubscribe();
    disposeSession(session);
  });

  it.each(["tui", "rpc"] as const)("lets a %s root turn settle while its task keeps running", async (mode) => {
    const { session, registration } = await createSession({ mode });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await gate;
        return fauxAssistantMessage("interactive child done");
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Interactive child", prompt: "Wait for release." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(serialized.includes("interactive child done") ? "notification handled" : "task launched");
    });

    await session.prompt("Launch one background task.");
    const accepted = session.messages.find((message: any) => message.role === "toolResult" && message.toolName === "run_agent") as any;
    expect(accepted.details.status).toBe("accepted");

    release();
    await waitForTaskNotification(session, accepted.details.task_id);
    await session.waitForIdle();
    disposeSession(session);
  });

  it("publishes active and idle widget lines through RPC mode", async () => {
    const childGate = deferred();
    const widgets: Array<{ lines: string[] | undefined; placement: string | undefined }> = [];
    const { session, registration } = await createSession({
      mode: "rpc",
      onWidget: (_key, lines, placement) => widgets.push({ lines, placement }),
    });
    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await childGate.promise;
        return fauxAssistantMessage("rpc child done");
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "RPC child", prompt: "Wait for release." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(serialized.includes("rpc child done") ? "notification handled" : "task launched");
    });

    await session.prompt("Launch one RPC background task.");
    await waitUntil(() => widgets.some((widget) =>
      widget.lines?.some((line) => line.includes("Pi Agent(general-purpose: RPC child)")) === true));
    childGate.resolve();
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
    await waitForTaskNotification(session, accepted.details.task_id);
    await session.waitForIdle();

    const active = widgets.find((widget) =>
      widget.lines?.some((line) => line.includes("Pi Agent(general-purpose: RPC child)")));
    expect(active?.placement).toBe("belowEditor");
    expect(active?.lines?.length).toBeLessThanOrEqual(5);
    expect(widgets.at(-1)?.lines).toHaveLength(1);
    expect(widgets.at(-1)?.lines?.[0]).toContain("pi-flow idle · 1 agent and 0 workflows done");
    disposeSession(session);
  });

  it("steers one completion after an active root tool batch", async () => {
    const childGate = deferred();
    const toolBatchStarted = deferred();
    const finishToolBatch = deferred();
    const taskFinished = deferred();
    const terminalDelivered = deferred();
    const widgets: string[][] = [];
    const toolExtension: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "active_gate",
        label: "active_gate",
        description: "Hold the active root tool batch",
        parameters: Type.Object({}),
        async execute() {
          toolBatchStarted.resolve();
          await finishToolBatch.promise;
          return {
            content: [{ type: "text" as const, text: "active batch complete" }],
            details: {},
          };
        },
      });
    };
    const { session, registration } = await createSession({
      mode: "tui",
      extensionFactories: [toolExtension],
      onWidget: (_key, lines) => {
        if (lines) {
          widgets.push(lines);
        }
        if (lines?.[0]?.includes("pi-flow idle · 1 agent")) {
          taskFinished.resolve();
        }
      },
    });
    let notificationContexts = 0;
    let notificationCopies = 0;
    let modelResponsesBeforeNotification = 0;
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-flow-task-notification"
      ) {
        terminalDelivered.resolve();
      }
    });

    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await childGate.promise;
        return fauxAssistantMessage("active batch child done");
      }
      const notifications = context.messages.filter((message) =>
        JSON.stringify(message).includes("active batch child done"));
      if (notifications.length > 0) {
        notificationContexts++;
        notificationCopies += notifications.length;
        return fauxAssistantMessage("active batch notification handled");
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Active batch child", prompt: "Wait during the active tool batch." }),
          fauxToolCall("active_gate", {}),
        ], { stopReason: "toolUse" });
      }
      modelResponsesBeforeNotification++;
      return fauxAssistantMessage("continued before notification");
    });

    const prompt = session.prompt("Launch one background task in an active tool batch.");
    await toolBatchStarted.promise;
    childGate.resolve();
    await taskFinished.promise;
    expect(widgets.some((lines) => lines.some((line) => line.includes("Pi Agent(general-purpose: Active batch child)")))).toBe(true);
    expect(widgets.at(-1)).toHaveLength(1);
    expect(widgets.at(-1)?.[0]).toContain("pi-flow idle · 1 agent and 0 workflows done");
    expect((session as any).agent.hasQueuedMessages()).toBe(true);
    expect(taskNotifications(session)).toHaveLength(0);
    finishToolBatch.resolve();
    await prompt;
    await terminalDelivered.promise;
    await session.waitForIdle();

    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(1);
    expect(modelResponsesBeforeNotification).toBe(0);
    expect(notificationContexts).toBe(1);
    expect(notificationCopies).toBe(1);
    unsubscribe();
    disposeSession(session);
  });

  it("does not retry a cleared notification and persists it once", async () => {
    const childGate = deferred();
    const rootProviderActive = deferred();
    const finishRootResponse = deferred();
    const taskFinished = deferred();
    const { session, registration, sessionManager } = await createSession({
      mode: "tui",
      onWidget: (_key, lines) => {
        if (lines?.[0]?.includes("pi-flow idle · 1 agent")) {
          taskFinished.resolve();
        }
      },
    });
    let notificationContexts = 0;

    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await childGate.promise;
        return fauxAssistantMessage("cleared child done");
      }
      if (serialized.includes("cleared child done")) {
        notificationContexts++;
        return fauxAssistantMessage("notification handled");
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Cleared child", prompt: "Wait while the root response is active." }),
        ], { stopReason: "toolUse" });
      }
      rootProviderActive.resolve();
      await finishRootResponse.promise;
      return fauxAssistantMessage("task launched");
    });

    const prompt = session.prompt("Launch one background task.");
    await rootProviderActive.promise;
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
    childGate.resolve();
    await taskFinished.promise;
    expect((session as any).agent.hasQueuedMessages()).toBe(true);
    session.clearQueue();
    expect((session as any).agent.hasQueuedMessages()).toBe(false);
    finishRootResponse.resolve();
    await prompt;
    await session.waitForIdle();

    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(0);
    expect(notificationContexts).toBe(0);

    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    const persistedTerminals = sessionManager.getEntries().filter((entry: any) =>
      entry.type === "custom_message" &&
      entry.customType === "pi-flow-task-notification" &&
      entry.details?.task_id === accepted.details.task_id);
    expect(persistedTerminals).toHaveLength(1);
    expect((persistedTerminals[0] as any).details).toMatchObject({
      status: "completed",
      content: "cleared child done",
    });
    disposeSession(session);
  });

  it("consumes a post-check completion on the next root run", async () => {
    const childGate = deferred();
    const postRunChecked = deferred();
    const finishPostRun = deferred();
    const taskFinished = deferred();
    const terminalDelivered = deferred();
    const { session, registration } = await createSession({
      mode: "tui",
      onWidget: (_key, lines) => {
        if (lines?.[0]?.includes("pi-flow idle · 1 agent")) {
          taskFinished.resolve();
        }
      },
    });
    let notificationContexts = 0;
    let notificationCopies = 0;
    let nextRunNotificationContexts = 0;
    let modelResponsesBeforeNotification = 0;
    const originalHandlePostAgentRun = (session as any)._handlePostAgentRun.bind(session);
    let interceptedPostRun = false;
    (session as any)._handlePostAgentRun = async () => {
      const shouldContinue = await originalHandlePostAgentRun();
      if (!shouldContinue && !interceptedPostRun) {
        interceptedPostRun = true;
        postRunChecked.resolve();
        await finishPostRun.promise;
      }
      return shouldContinue;
    };
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-flow-task-notification"
      ) {
        terminalDelivered.resolve();
      }
    });

    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await childGate.promise;
        return fauxAssistantMessage("settling child done");
      }
      const notifications = context.messages.filter((message) =>
        JSON.stringify(message).includes("settling child done"));
      if (notifications.length > 0) {
        notificationContexts++;
        notificationCopies += notifications.length;
        if (serialized.includes("Process the late completion.")) {
          nextRunNotificationContexts++;
        }
        return fauxAssistantMessage("notification handled");
      }
      if (serialized.includes("Process the late completion.")) {
        modelResponsesBeforeNotification++;
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Settling child", prompt: "Wait for agent_end." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("task launched");
    });

    const prompt = session.prompt("Launch one background task.");
    await postRunChecked.promise;
    childGate.resolve();
    await taskFinished.promise;
    finishPostRun.resolve();
    await prompt;

    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(0);
    expect((session as any).agent.hasQueuedMessages()).toBe(true);

    await session.prompt("Process the late completion.");
    await terminalDelivered.promise;
    await session.waitForIdle();
    unsubscribe();

    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(1);
    expect(modelResponsesBeforeNotification).toBe(0);
    expect(nextRunNotificationContexts).toBe(1);
    expect(notificationContexts).toBe(1);
    expect(notificationCopies).toBe(1);
    disposeSession(session);
  });

  it("steers a completion into an automatic continuation's next model context", async () => {
    const childGate = deferred();
    const toolBatchStarted = deferred();
    const finishToolBatch = deferred();
    const taskFinished = deferred();
    const terminalDelivered = deferred();
    const toolExtension: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "settling_gate",
        label: "settling_gate",
        description: "Hold an automatic continuation tool batch",
        parameters: Type.Object({}),
        async execute() {
          toolBatchStarted.resolve();
          await finishToolBatch.promise;
          return {
            content: [{ type: "text" as const, text: "tool batch complete" }],
            details: {},
          };
        },
      });
    };
    const { session, registration } = await createSession({
      mode: "tui",
      extensionFactories: [toolExtension],
      onWidget: (_key, lines) => {
        if (lines?.[0]?.includes("pi-flow idle · 1 agent")) {
          taskFinished.resolve();
        }
      },
    });
    let queueAutomaticContinuation = true;
    let notificationContexts = 0;
    let notificationCopies = 0;
    let modelResponsesBeforeNotification = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end" && queueAutomaticContinuation) {
        queueAutomaticContinuation = false;
        void session.steer("automatic continuation");
      }
      if (
        event.type === "message_end" &&
        event.message.role === "custom" &&
        event.message.customType === "pi-flow-task-notification"
      ) {
        terminalDelivered.resolve();
      }
    });

    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await childGate.promise;
        return fauxAssistantMessage("continuation child done");
      }
      const notifications = context.messages.filter((message) =>
        JSON.stringify(message).includes("continuation child done"));
      if (notifications.length > 0) {
        notificationContexts++;
        notificationCopies += notifications.length;
        return fauxAssistantMessage("notification handled");
      }
      if (serialized.includes("automatic continuation")) {
        if (!serialized.includes('"toolName":"settling_gate"')) {
          return fauxAssistantMessage([fauxToolCall("settling_gate", {})], { stopReason: "toolUse" });
        }
        modelResponsesBeforeNotification++;
        return fauxAssistantMessage("continued without notification");
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Continuation child", prompt: "Wait for tool batch." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("task launched");
    });

    const prompt = session.prompt("Launch one background task.");
    await toolBatchStarted.promise;
    childGate.resolve();
    await taskFinished.promise;
    finishToolBatch.resolve();
    await prompt;
    await terminalDelivered.promise;
    await session.waitForIdle();
    unsubscribe();

    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
    expect(taskNotifications(session, accepted.details.task_id)).toHaveLength(1);
    expect(modelResponsesBeforeNotification).toBe(0);
    expect(notificationContexts).toBe(1);
    expect(notificationCopies).toBe(1);
    disposeSession(session);
  });

  it("keeps task completion on its originating branch during tree navigation", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession({ mode: "tui" });
    let releaseChild!: () => void;
    setContextRoutingResponses(registration, (context, options) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return new Promise((resolve) => {
          releaseChild = () => resolve(fauxAssistantMessage("branch child done"));
          options.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("branch child aborted")), { once: true });
        });
      }
      if (serialized.includes("pi-flow-task-notification")) {
        return fauxAssistantMessage("notification observed");
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Branch child", prompt: "Wait during tree navigation." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("task launched");
    });

    await session.prompt("Launch one background task.");
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "run_agent") as any;
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
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      newBranchChildContext = context;
      return fauxAssistantMessage("new branch child done");
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const next = await tool.execute(
      "new-branch-call",
      {
        label: "New branch child",
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
    const agentEndStarted = deferred();
    const extensionRunner = session.extensionRunner as any;
    const originalEmit = extensionRunner.emit.bind(extensionRunner);
    extensionRunner.emit = async (event: { type: string }) => {
      if (event.type === "agent_end") {
        agentEndStarted.resolve();
      }
      return originalEmit(event);
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setContextRoutingResponses(registration, async (context) => {
      const serialized = JSON.stringify(context.messages);
      if (!context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        await gate;
        return fauxAssistantMessage(`${mode} child done`);
      }
      if (!serialized.includes('"toolName":"run_agent"')) {
        return fauxAssistantMessage([
          fauxToolCall("run_agent", { label: "Print child", prompt: "Wait for release." }),
        ], { stopReason: "toolUse" });
      }
      return fauxAssistantMessage(serialized.includes(`${mode} child done`) ? `${mode} notification handled` : "task launched");
    });

    let settled = false;
    const prompt = session.prompt("Launch one background task.").then(() => { settled = true; });
    await agentEndStarted.promise;
    expect(settled).toBe(false);

    release();
    await prompt;
    const accepted = session.messages.find((message: any) => message.role === "toolResult" && message.toolName === "run_agent") as any;
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
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        const serialized = JSON.stringify(context.messages);
        if (serialized.includes("pi-flow-task-notification")) {
          rootNotificationCalls++;
        }
        if (!serialized.includes('"toolName":"run_agent"')) {
          return fauxAssistantMessage([
            fauxToolCall("run_agent", { label: "Reload child", prompt: "Wait until reload." }),
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
      message.role === "toolResult" && message.toolName === "run_agent") as any;

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

  it("starts run_agent and run_workflow tasks after a reused extension session boundary", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession({ mode: "tui" });
    let oldChildStarted = false;
    setContextRoutingResponses(registration, (context, options) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
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
    const oldSubagentTool = session.getToolDefinition("run_agent") as any;
    const oldAccepted = await oldSubagentTool.execute(
      "old-session-call",
      { label: "Old session child", prompt: "Wait for the session boundary." },
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
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      return fauxAssistantMessage("new session child done");
    });
    const agentTool = session.getToolDefinition("run_agent") as any;
    const agentAccepted = await agentTool.execute(
      "new-session-agent",
      { label: "New session agent", prompt: "Complete after the session boundary." },
      undefined,
      undefined,
      context,
    );
    const agentTerminal = await waitForTaskNotification(session, agentAccepted.details.task_id);

    const workflowTool = session.getToolDefinition("run_workflow") as any;
    const workflowAccepted = await workflowTool.execute(
      "new-session-workflow",
      {
        name: "new_session",
        script: "export const meta = { name: 'new_session', description: 'Run after a new session' };\nreturn await run_agent('Complete after the session boundary.', { label: 'worker' });",
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
    const tool = session.getToolDefinition("run_agent") as any;
    const controller = new AbortController();
    let childContext: Context | undefined;
    setContextRoutingResponses(registration, (context) => {
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      childContext = context;
      return fauxAssistantMessage("detached child done");
    });

    controller.abort();
    const accepted = await tool.execute(
      "pre-aborted-call",
      { label: "Detached child", prompt: "Run despite the foreground signal." },
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
      if (context.tools?.some((candidate: { name?: string }) => candidate.name === "run_agent")) {
        return fauxAssistantMessage("notification observed");
      }
      await delay(80);
      return fauxAssistantMessage("late output");
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const accepted = await tool.execute(
      "timeout-call",
      { label: "Slow child", prompt: "Take too long." },
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
      label: "Internal child",
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
      label: "Research config",
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

  it("shows idle task totals and cumulative usage in the widget", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      onWidget: (key, lines) => widgets.push({ key, lines }),
    });

    await executeSubagentTask(
      session,
      registration,
      context,
      { label: "Usage child", prompt: "Report usage." },
      async () => fauxAssistantMessage("usage child done"),
    );

    const line = widgets.filter((widget) => widget.key === "pi-flow").at(-1)?.lines?.[0] ?? "";
    expect(line).toContain("pi-flow idle · 1 agent and 0 workflows done");
    expect(line).toMatch(/↑\S+ ↓\S+ (?:R\S+ |W\S+ )*CH\d+\.\d%/);
    disposeSession(session);
  });
});
