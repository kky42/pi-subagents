import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent pi backend behavior", () => {
  let cwd = "";
  let agentDir = "";
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    waitForTaskNotification,
    executeAgentTask,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness((state) => {
    cwd = state.cwd;
    agentDir = state.agentDir;
  });

  it("keeps custom profile prompt, model, thinking, and tools isolated in the child", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "code-searcher.md"), `---
description: Searches code without editing files.
tools: read, grep, find, ls, bash
model: faux/faux-fast
thinking: low
---

Custom Code Searcher Role`);
    const { session, registration, model, modelRegistry } = await createSession({
      models: [
        { id: "faux-thinker", name: "Faux Thinker", reasoning: true },
        { id: "faux-fast", name: "Faux Fast", reasoning: false },
      ],
      defaultModelId: "faux-thinker",
    });
    let childContext: Context | undefined;
    let childOptions: SimpleStreamOptions | undefined;
    let childModel: Model<string> | undefined;

    const { accepted, terminal } = await executeAgentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: "Find auth files", subagent_type: "code-searcher", prompt: "Search for the auth flow." },
      async (context, options, selectedModel) => {
        childContext = context;
        childOptions = options;
        childModel = selectedModel;
        return fauxAssistantMessage("found auth.ts");
      },
    );

    expect(accepted.details).toMatchObject({ status: "accepted", session_key: expect.stringMatching(/^session_/) });
    expect(terminal).toEqual({ ...accepted.details, status: "completed", content: "found auth.ts" });
    expect(childModel?.id).toBe("faux-fast");
    expect((childOptions as { reasoning?: string } | undefined)?.reasoning).toBeUndefined();
    expect(childContext?.systemPrompt).toContain("Custom Code Searcher Role");
    expect(childContext?.systemPrompt).not.toContain("# PiFlow delegation");
    expect(getToolNames(childContext)).toEqual(["bash", "find", "grep", "ls", "read"]);
    expect(JSON.stringify(childContext?.messages)).toContain("Search for the auth flow.");
    disposeSession(session);
  });

  it("preserves project append prompts without exposing delegation tools", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "APPEND_SYSTEM.md"), "Project append marker.");
    const { session, registration, model, modelRegistry } = await createSession();
    let childContext: Context | undefined;

    await executeAgentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: "Inspect context", prompt: "Inspect context." },
      async (context) => {
        childContext = context;
        return fauxAssistantMessage("context inspected");
      },
    );

    expect(childContext?.systemPrompt).toContain("Project append marker.");
    expect(childContext?.systemPrompt).not.toContain("# PiFlow delegation");
    expect(getToolNames(childContext)).not.toContain("Agent");
    expect(getToolNames(childContext)).not.toContain("workflow");
    disposeSession(session);
  });

  it("generates a session key and resumes it on a later Agent call", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, sessionManager });
    let secondContext: Context | undefined;
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("Agent")) return fauxAssistantMessage("notification observed");
      const serialized = JSON.stringify(providerContext.messages);
      if (serialized.includes("Second prompt.")) {
        secondContext = providerContext;
        return fauxAssistantMessage("draft v2");
      }
      return fauxAssistantMessage("draft v1");
    });

    const first = await tool.execute("first", { label: "Initial draft", prompt: "First prompt." }, undefined, undefined, context);
    const firstTerminal = await waitForTaskNotification(session, first.details.task_id);
    const second = await tool.execute(
      "second",
      { label: "Revise draft", prompt: "Second prompt.", session_key: first.details.session_key },
      undefined,
      undefined,
      context,
    );
    const secondTerminal = await waitForTaskNotification(session, second.details.task_id);

    expect(first.details.session_key).toMatch(/^session_/);
    expect(firstTerminal.session_key).toBe(first.details.session_key);
    expect(second.details.session_key).toBe(first.details.session_key);
    expect(secondTerminal.content).toBe("draft v2");
    const messages = JSON.stringify(secondContext?.messages);
    expect(messages).toContain("First prompt.");
    expect(messages).toContain("draft v1");
    expect(messages).toContain("Second prompt.");
    const mappings = sessionManager.getEntries().filter((entry: any) => entry.type === "custom" && entry.customType === "pi-flow-subagent-session-key");
    expect(mappings).toHaveLength(1);
    disposeSession(session);
  });

  it("fails continuation when the persisted child session is missing", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) =>
      fauxAssistantMessage(getToolNames(providerContext).includes("Agent") ? "notification observed" : "first done"));

    const first = await tool.execute(
      "first",
      { label: "First", prompt: "First.", session_key: "missing-child" },
      undefined,
      undefined,
      context,
    );
    await waitForTaskNotification(session, first.details.task_id);
    rmSync(join(agentDir, "subagent-sessions"), { recursive: true, force: true });

    const second = await tool.execute(
      "second",
      { label: "Continue", prompt: "Continue.", session_key: "missing-child" },
      undefined,
      undefined,
      context,
    );
    const terminal = await waitForTaskNotification(session, second.details.task_id);

    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("Cannot resume subagent: persisted session");
    expect(terminal.content).toContain("was not found");
    disposeSession(session);
  });

  it("preserves a caller-supplied new session key", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const { accepted, terminal } = await executeAgentTask(
      session,
      registration,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      { label: "Named worker", prompt: "Work.", session_key: "worker" },
      async () => fauxAssistantMessage("worker done"),
    );

    expect(accepted.details.session_key).toBe("worker");
    expect(terminal.session_key).toBe("worker");
    disposeSession(session);
  });

  it("fails a session key reused with a different profile", async () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "reviewer.md"), "---\ndescription: Reviewer.\n---\nReviewer role.");
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) =>
      fauxAssistantMessage(getToolNames(providerContext).includes("Agent") ? "notification observed" : "first done"));

    const first = await tool.execute(
      "first",
      { label: "First", prompt: "First.", session_key: "shared" },
      undefined,
      undefined,
      context,
    );
    await waitForTaskNotification(session, first.details.task_id);
    const mismatch = await tool.execute(
      "mismatch",
      { label: "Mismatch", prompt: "Second.", session_key: "shared", subagent_type: "reviewer" },
      undefined,
      undefined,
      context,
    );
    const terminal = await waitForTaskNotification(session, mismatch.details.task_id);

    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("already belongs to general-purpose (pi)");
    disposeSession(session);
  });

  it("reports unknown profiles only in the terminal notification", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    setContextRoutingResponses(registration, () => fauxAssistantMessage("notification observed"));
    const tool = session.getToolDefinition("Agent") as any;
    const accepted = await tool.execute(
      "unknown",
      { label: "Unknown", prompt: "Search.", subagent_type: "explorer" },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const terminal = await waitForTaskNotification(session, accepted.details.task_id);

    expect(accepted.details.status).toBe("accepted");
    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("Unknown subagent_type");
    disposeSession(session);
  });

  it("fresh generated keys do not leak one child conversation into another", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let secondContext: Context | undefined;
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("Agent")) return fauxAssistantMessage("notification observed");
      if (JSON.stringify(providerContext.messages).includes("Second task.")) {
        secondContext = providerContext;
        return fauxAssistantMessage("second done");
      }
      return fauxAssistantMessage("FIRST_CHILD_SECRET");
    });

    const first = await tool.execute("first", { label: "First", prompt: "First task." }, undefined, undefined, context);
    await waitForTaskNotification(session, first.details.task_id);
    const second = await tool.execute("second", { label: "Second", prompt: "Second task." }, undefined, undefined, context);
    await waitForTaskNotification(session, second.details.task_id);

    expect(first.details.session_key).not.toBe(second.details.session_key);
    const messages = JSON.stringify(secondContext?.messages);
    expect(messages).toContain("Second task.");
    expect(messages).not.toContain("FIRST_CHILD_SECRET");
    expect(messages).not.toContain("First task.");
    disposeSession(session);
  });
});
