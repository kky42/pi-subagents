import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let active = 0;
    let maximum = 0;
    let started = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    setContextRoutingResponses(registration, async (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
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

    const first = await tool.execute("first", { description: "First", prompt: "First task." }, undefined, undefined, context);
    const second = await tool.execute("second", { description: "Second", prompt: "Second task." }, undefined, undefined, context);

    expect(first.details.status).toBe("accepted");
    expect(second.details.status).toBe("accepted");
    expect(first.details.task_id).not.toBe(second.details.task_id);
    await delay(20);
    expect(started).toBe(1);
    expect(maximum).toBe(1);

    releaseFirst();
    const terminals = await Promise.all([
      waitForTaskNotification(session, first.details.task_id),
      waitForTaskNotification(session, second.details.task_id),
    ]);
    expect(terminals.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(started).toBe(2);
    expect(maximum).toBe(1);
    disposeSession(session);
  });

  it("uses the max-concurrency flag over the factory default", async () => {
    const { session, registration, model, modelRegistry } = await createSession({
      maxConcurrentSubagents: 3,
      maxConcurrentSubagentsFlag: "1",
    });
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let active = 0;
    let maximum = 0;
    setContextRoutingResponses(registration, async (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      active++;
      maximum = Math.max(maximum, active);
      await delay(20);
      active--;
      return fauxAssistantMessage("done");
    });

    const accepted = await Promise.all([
      tool.execute("a", { description: "A", prompt: "A" }, undefined, undefined, context),
      tool.execute("b", { description: "B", prompt: "B" }, undefined, undefined, context),
    ]);
    await Promise.all(accepted.map((result) => waitForTaskNotification(session, result.details.task_id)));

    expect(maximum).toBe(1);
    disposeSession(session);
  });

  it("serializes calls that share a session key before consuming concurrency slots", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 2 });
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let sharedActive = 0;
    let maximumShared = 0;
    setContextRoutingResponses(registration, async (providerContext) => {
      if (providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      sharedActive++;
      maximumShared = Math.max(maximumShared, sharedActive);
      await delay(20);
      sharedActive--;
      return fauxAssistantMessage("shared done");
    });

    const accepted = await Promise.all([
      tool.execute("shared-a", { description: "Shared A", prompt: "A", session_key: "worker" }, undefined, undefined, context),
      tool.execute("shared-b", { description: "Shared B", prompt: "B", session_key: "worker" }, undefined, undefined, context),
    ]);
    await Promise.all(accepted.map((result) => waitForTaskNotification(session, result.details.task_id)));

    expect(maximumShared).toBe(1);
    expect(accepted.map((result) => result.details.session_key)).toEqual(["worker", "worker"]);
    disposeSession(session);
  });

  it("a rejected profile does not prevent a queued valid task from completing", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "bad-model.md"), "---\ndescription: Bad model.\nmodel: ghost/nope\n---\n");
    const { session, registration, model, modelRegistry } = await createSession({ maxConcurrentSubagents: 1 });
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) =>
      fauxAssistantMessage(providerContext.tools?.some((candidate: { name?: string }) => candidate.name === "Agent")
        ? "notification observed"
        : "valid child done"));

    const invalid = await tool.execute(
      "invalid",
      { description: "Invalid", prompt: "Fail.", subagent_type: "bad-model" },
      undefined,
      undefined,
      context,
    );
    const valid = await tool.execute("valid", { description: "Valid", prompt: "Run." }, undefined, undefined, context);
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
