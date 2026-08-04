import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("delegation scenario execution", () => {
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    waitForTaskNotification,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness();

  it("allows narrow work to finish in the root without delegation", async () => {
    const { session, registration } = await createSession();
    registration.setResponses([fauxAssistantMessage("direct result")]);

    await session.prompt("Answer this narrow local question directly.");

    expect(session.messages.some((message: any) =>
      message.role === "assistant" && Array.isArray(message.content) && message.content.some((item: any) => item.name === "Agent"))).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("direct result");
    disposeSession(session);
  });

  it("runs a flat fan-out as independent accepted background tasks", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("Agent")) return fauxAssistantMessage("notification observed");
      const text = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(text.includes("source") ? "source result" : "test result");
    });

    const accepted = await Promise.all([
      tool.execute("source", { label: "Inspect source", prompt: "Inspect source correctness." }, undefined, undefined, context),
      tool.execute("tests", { label: "Inspect tests", prompt: "Inspect test coverage." }, undefined, undefined, context),
    ]);
    const terminals = await Promise.all(accepted.map((result) => waitForTaskNotification(session, result.details.task_id)));

    expect(accepted.every((result) => result.details.status === "accepted")).toBe(true);
    expect(accepted[0].details.session_key).not.toBe(accepted[1].details.session_key);
    expect(terminals.map((result) => result.content).sort()).toEqual(["source result", "test result"]);
    disposeSession(session);
  });

  it("continues one logical child stream with a returned session key", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("Agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let continuedChildContext: Context | undefined;
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("Agent")) return fauxAssistantMessage("notification observed");
      if (JSON.stringify(providerContext.messages).includes("Recall and refine")) {
        continuedChildContext = providerContext;
        return fauxAssistantMessage("refined flow");
      }
      return fauxAssistantMessage("remembered flow");
    });

    const first = await tool.execute(
      "initial",
      { label: "Initial investigation", prompt: "Inspect and remember the flow." },
      undefined,
      undefined,
      context,
    );
    await waitForTaskNotification(session, first.details.task_id);
    const second = await tool.execute(
      "continue",
      {
        label: "Continue investigation",
        prompt: "Recall and refine the flow.",
        session_key: first.details.session_key,
      },
      undefined,
      undefined,
      context,
    );
    const terminal = await waitForTaskNotification(session, second.details.task_id);

    expect(second.details.session_key).toBe(first.details.session_key);
    expect(JSON.stringify(continuedChildContext?.messages)).toContain("remembered flow");
    expect(terminal.content).toBe("refined flow");
    disposeSession(session);
  });
});
