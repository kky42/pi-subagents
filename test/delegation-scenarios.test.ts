import { fauxAssistantMessage, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("delegation scenario execution", () => {
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    taskNotifications,
    makeExecutionContext,
    getToolNames,
  } = setupPiSubagentTestHarness();

  it("allows narrow work to finish in the root without delegation", async () => {
    const { session, registration } = await createSession();
    registration.setResponses([fauxAssistantMessage("direct result")]);

    await session.prompt("Answer this narrow local question directly.");

    expect(session.messages.some((message: any) =>
      message.role === "assistant" && Array.isArray(message.content) && message.content.some((item: any) => item.name === "run_agent"))).toBe(false);
    expect(JSON.stringify(session.messages)).toContain("direct result");
    disposeSession(session);
  });

  it("runs a flat fan-out as independent synchronous tasks", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("run_agent")) return fauxAssistantMessage("root continuation");
      const text = JSON.stringify(providerContext.messages);
      return fauxAssistantMessage(text.includes("source") ? "source result" : "test result");
    });

    const results = await Promise.all([
      tool.execute("source", { label: "Inspect source", prompt: "Inspect source correctness." }, undefined, undefined, context),
      tool.execute("tests", { label: "Inspect tests", prompt: "Inspect test coverage." }, undefined, undefined, context),
    ]);
    const terminals = results.map((result) => JSON.parse(result.content[0].text));

    expect(results.every((result) => result.details.status === "done")).toBe(true);
    expect(results[0].details.sessionKey).not.toBe(results[1].details.sessionKey);
    expect(terminals.map((result) => result.content).sort()).toEqual(["source result", "test result"]);
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });

  it("continues one logical child stream with a returned session key", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const tool = session.getToolDefinition("run_agent") as any;
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    let continuedChildContext: Context | undefined;
    setContextRoutingResponses(registration, (providerContext) => {
      if (getToolNames(providerContext).includes("run_agent")) return fauxAssistantMessage("root continuation");
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
    expect(JSON.parse(first.content[0].text).content).toBe("remembered flow");
    const second = await tool.execute(
      "continue",
      {
        label: "Continue investigation",
        prompt: "Recall and refine the flow.",
        session_key: first.details.sessionKey,
      },
      undefined,
      undefined,
      context,
    );
    const terminal = JSON.parse(second.content[0].text);

    expect(second.details.sessionKey).toBe(first.details.sessionKey);
    expect(JSON.stringify(continuedChildContext?.messages)).toContain("remembered flow");
    expect(terminal.content).toBe("refined flow");
    expect(taskNotifications(session)).toEqual([]);
    disposeSession(session);
  });
});
