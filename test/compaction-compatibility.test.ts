import smartCompactionExtension from "@kky42/pi-smart-compaction/src/index.ts";
import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

const TASK_NOTIFICATION_TYPE = "pi-flow-task-notification";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function contextText(context: Context): string {
  return JSON.stringify(context.messages);
}

function hasTaskNotification(messages: readonly unknown[]): boolean {
  return messages.some((message: any) =>
    message?.role === "custom" && message.customType === TASK_NOTIFICATION_TYPE);
}

function hasAssistantText(messages: readonly unknown[], text: string): boolean {
  return messages.some((message: any) =>
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((part: any) => part?.type === "text" && part.text === text));
}

describe("pi-smart-compaction compatibility", () => {
  const { createSession, setContextRoutingResponses } = setupPiSubagentTestHarness();

  it("queues PiFlow terminal notifications through threshold auto-compaction", async () => {
    const { session, registration, sessionManager } = await createSession({
      extensionFactories: [smartCompactionExtension],
      thinkingLevel: "off",
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 127_900,
        },
      },
    });
    const childGate = deferred();
    let childStarted = false;
    let childFinished = false;
    let summaryStarted = false;
    let summaryInProgress = false;
    let streamingDuringSummary = false;
    let notificationTurnStartedDuringSummary = false;

    setContextRoutingResponses(registration, async (context) => {
      const text = contextText(context);
      const isRoot = context.tools?.some((tool) => tool.name === "run_agent") === true;
      if (text.includes("<conversation>")) {
        summaryStarted = true;
        summaryInProgress = true;
        streamingDuringSummary = session.isStreaming;
        childGate.resolve();
        await waitUntil(() => childFinished);
        await delay(30);
        session.setAutoCompactionEnabled(false);
        summaryInProgress = false;
        return fauxAssistantMessage("AUTO_COMPACTION_SUMMARY");
      }
      if (!isRoot) {
        childStarted = true;
        await childGate.promise;
        childFinished = true;
        return fauxAssistantMessage("AUTO_CHILD_DONE");
      }
      if (text.includes("task_type") && text.includes("completed")) {
        notificationTurnStartedDuringSummary = summaryInProgress;
        return fauxAssistantMessage("AUTO_NOTIFICATION_REPLY");
      }
      return fauxAssistantMessage("AUTO_TRIGGER_REPLY");
    });

    const tool = session.getToolDefinition("run_agent") as any;
    await tool.execute(
      "auto-compaction-task",
      { label: "Auto child", prompt: "Wait, then finish." },
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    );
    await waitUntil(() => childStarted);

    await session.prompt(`Trigger threshold compaction. ${"x".repeat(400)}`);

    expect(summaryStarted).toBe(true);
    expect(streamingDuringSummary).toBe(true);
    expect(notificationTurnStartedDuringSummary).toBe(false);
    expect(hasTaskNotification(session.messages)).toBe(true);
    expect(hasAssistantText(session.messages, "AUTO_NOTIFICATION_REPLY")).toBe(true);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
    expect(sessionManager.getEntries().some((entry) =>
      entry.type === "custom_message" && entry.customType === TASK_NOTIFICATION_TYPE)).toBe(true);
  });

  it("rejects manual compaction while a PiFlow task is active and preserves its notification", async () => {
    const { session, registration, sessionManager } = await createSession({
      extensionFactories: [smartCompactionExtension],
      thinkingLevel: "off",
      settings: {
        compaction: {
          enabled: true,
          keepRecentTokens: 1,
          reserveTokens: 100,
        },
      },
    });
    const childGate = deferred();
    let childStarted = false;
    let childFinished = false;
    let summaryStarted = false;

    setContextRoutingResponses(registration, async (context) => {
      const text = contextText(context);
      const isRoot = context.tools?.some((tool) => tool.name === "run_agent") === true;
      if (text.includes("<conversation>")) {
        summaryStarted = true;
        childGate.resolve();
        await waitUntil(() => childFinished);
        await delay(30);
        return fauxAssistantMessage("MANUAL_COMPACTION_SUMMARY");
      }
      if (!isRoot) {
        childStarted = true;
        await childGate.promise;
        childFinished = true;
        return fauxAssistantMessage("MANUAL_CHILD_DONE");
      }
      const response = text.includes("task_type") && text.includes("completed")
        ? "MANUAL_NOTIFICATION_REPLY"
        : "SEED_REPLY";
      return fauxAssistantMessage(response);
    });

    await session.prompt(`Seed manual compaction history. ${"x".repeat(400)}`);
    const tool = session.getToolDefinition("run_agent") as any;
    await tool.execute(
      "manual-compaction-task",
      { label: "Manual child", prompt: "Wait, then finish." },
      undefined,
      undefined,
      session.extensionRunner.createContext(),
    );
    await waitUntil(() => childStarted);

    const compactResult = await session.compact().then(
      () => ({ completed: true, error: "" }),
      (error: unknown) => ({
        completed: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    childGate.resolve();
    await waitUntil(() => childFinished);
    await waitUntil(() => hasAssistantText(session.messages, "MANUAL_NOTIFICATION_REPLY"));

    expect(compactResult).toEqual({ completed: false, error: "Compaction cancelled" });
    expect(summaryStarted).toBe(false);
    expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
    expect(hasTaskNotification(session.messages)).toBe(true);
    expect(sessionManager.getEntries().some((entry) =>
      entry.type === "custom_message" && entry.customType === TASK_NOTIFICATION_TYPE)).toBe(true);
  });
});
