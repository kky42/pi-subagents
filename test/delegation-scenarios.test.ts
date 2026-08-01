import { fauxAssistantMessage, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getSubagentProfiles } from "../src/profiles.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function assistantToolCalls(messages: Array<{ role?: string; content?: unknown }>) {
  return messages
    .filter((message) => message.role === "assistant" && Array.isArray(message.content))
    .flatMap((message) => message.content as Array<{ type?: string; name?: string; arguments?: Record<string, unknown> }>)
    .filter((item) => item.type === "toolCall");
}

describe("delegation scenario execution", () => {
  let agentDir = "";
  const { disposeSession, createSession } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  function availableProfileName(): string {
    const name = getSubagentProfiles(agentDir).keys().next().value;
    expect(name).toBeTypeOf("string");
    return name as string;
  }

  it("allows narrow work to finish in the root without delegation", async () => {
    const { session, registration } = await createSession();
    registration.setResponses([fauxAssistantMessage("direct result")]);

    await session.prompt("Answer this narrow local question directly.");

    expect(assistantToolCalls(session.messages)).toEqual([]);
    expect(JSON.stringify(session.messages)).toContain("direct result");
    disposeSession(session);
  });

  it("executes a small flat fan-out as fresh parallel Agent calls", async () => {
    const { session, registration } = await createSession();
    const subagentType = availableProfileName();
    registration.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("Agent", { description: "Inspect source", prompt: "Inspect source correctness.", subagent_type: subagentType }),
          fauxToolCall("Agent", { description: "Inspect tests", prompt: "Inspect test coverage.", subagent_type: subagentType }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("source result"),
      fauxAssistantMessage("test result"),
      fauxAssistantMessage("combined result"),
    ]);

    await session.prompt("Run two independent investigations and synthesize them.");

    const calls = assistantToolCalls(session.messages).filter((call) => call.name === "Agent");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.arguments?.session_key === undefined)).toBe(true);
    expect(JSON.stringify(session.messages)).toContain("source result");
    expect(JSON.stringify(session.messages)).toContain("test result");
    expect(JSON.stringify(session.messages)).toContain("combined result");
    disposeSession(session);
  });

  it("continues one logical child stream with the same session key", async () => {
    const { session, registration } = await createSession();
    let continuedChildContext: Context | undefined;
    const sessionKey = "logical-child-stream";
    const subagentType = availableProfileName();
    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Initial investigation", prompt: "Inspect and remember the flow.", subagent_type: subagentType, session_key: sessionKey })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("remembered flow"),
      fauxAssistantMessage(
        [fauxToolCall("Agent", { description: "Continue investigation", prompt: "Recall and refine the flow.", subagent_type: subagentType, session_key: sessionKey })],
        { stopReason: "toolUse" },
      ),
      (context) => {
        continuedChildContext = context;
        return fauxAssistantMessage("refined flow");
      },
      fauxAssistantMessage("reported refinement"),
    ]);

    await session.prompt("Use the same child for a dependent follow-up.");

    const calls = assistantToolCalls(session.messages).filter((call) => call.name === "Agent");
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.arguments?.session_key)).toEqual([sessionKey, sessionKey]);
    expect(JSON.stringify(continuedChildContext?.messages)).toContain("remembered flow");
    expect(JSON.stringify(session.messages)).toContain("reported refinement");
    disposeSession(session);
  });
});
