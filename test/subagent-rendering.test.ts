import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { formatUsage } from "../src/core/subagent-render.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent rendering", () => {
  let agentDir = "";
  const { makeMockTheme, renderToText } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  function captureRenderers() {
    let agentTool: any;
    let notificationRenderer: any;
    const flags = new Map<string, boolean | string>();
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "run_agent") agentTool = tool;
      },
      registerMessageRenderer: (customType: string, renderer: unknown) => {
        if (customType === "pi-flow-task-notification") notificationRenderer = renderer;
      },
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      getFlag: (name: string) => flags.get(name),
      sendMessage: () => {},
      on: () => {},
      getThinkingLevel: () => "high",
    };
    createSubagentExtension()(mockApi);
    return { agentTool, notificationRenderer };
  }

  it("renders zero cache hits and unknown cost explicitly", () => {
    expect(formatUsage({
      input: 1000,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }, {
      tokensKnown: true,
      costKnown: false,
      costBreakdownKnown: false,
    })).toBe("↑1.0k ↓0 CH0.0% $?");
  });

  it("renders a run_agent launch as a compact accepted task", () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "code-searcher.md"), "---\ndescription: Searches code.\n---\n");
    const { agentTool } = captureRenderers();
    const theme = makeMockTheme();

    const call = renderToText(agentTool.renderCall(
      { label: "Find auth files", profile: "code-searcher", prompt: "..." },
      theme,
      { executionStarted: false },
    ));
    const runningCall = renderToText(agentTool.renderCall(
      { label: "Find auth files", profile: "code-searcher", prompt: "..." },
      theme,
      { executionStarted: true },
    ));
    const result = renderToText(agentTool.renderResult({
      content: [{ type: "text", text: "accepted" }],
      details: {
        task_id: "task_123",
        task_type: "agent",
        status: "accepted",
        session_key: "session_123",
        label: "Find auth files",
      },
    }, {}, theme, {}));

    expect(call).toContain("Pi Agent");
    expect(call).toContain("code-searcher");
    expect(call).toContain("Find auth files");
    expect(runningCall).toBe("");
    expect(result.trimEnd()).toBe("Agent Find auth files accepted task_123");
    expect(result).not.toContain("session_123");
  });

  it("renders terminal custom notifications compactly and expands content", () => {
    const { notificationRenderer } = captureRenderers();
    const theme = makeMockTheme();
    const completed = {
      task_id: "task_done",
      task_type: "agent",
      status: "completed",
      session_key: "session_done",
      label: "Inspect auth",
      content: "Detailed child result",
    };
    const failed = {
      task_id: "task_failed",
      task_type: "agent",
      status: "failed",
      session_key: "session_failed",
      label: "Inspect tests",
      content: "Provider failed",
    };

    const compact = renderToText(notificationRenderer({ details: completed }, { expanded: false }, theme));
    const expanded = renderToText(notificationRenderer({ details: completed }, { expanded: true }, theme));
    const failure = renderToText(notificationRenderer({ details: failed }, { expanded: false }, theme));

    expect(compact.trimEnd()).toBe("✓ Agent Inspect auth task_done");
    expect(compact).not.toContain("Detailed child result");
    expect(expanded).toContain("Detailed child result");
    expect(failure).toContain("✗ Agent Inspect tests task_failed");
    expect(failure).toContain("Provider failed");
  });
});
