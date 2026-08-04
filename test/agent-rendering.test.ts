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
    let workflowTool: any;
    let notificationRenderer: any;
    const flags = new Map<string, boolean | string>();
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "Agent") agentTool = tool;
        if (tool.name === "workflow") workflowTool = tool;
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
    return { agentTool, workflowTool, notificationRenderer };
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

  it("renders an Agent launch as a compact accepted task", () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "code-searcher.md"), "---\ndescription: Searches code.\n---\n");
    const { agentTool } = captureRenderers();
    const theme = makeMockTheme();

    const call = renderToText(agentTool.renderCall(
      { description: "Find auth files", subagent_type: "code-searcher", prompt: "..." },
      theme,
      { executionStarted: false },
    ));
    const runningCall = renderToText(agentTool.renderCall(
      { description: "Find auth files", subagent_type: "code-searcher", prompt: "..." },
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
        name: "Find auth files",
        display: {
          backend: "pi",
          profile: "code-searcher",
        },
      },
    }, {}, theme, {}));
    const legacyResult = renderToText(agentTool.renderResult({
      content: [{ type: "text", text: "accepted" }],
      details: {
        task_id: "task_old",
        task_type: "agent",
        status: "accepted",
        session_key: "session_old",
        name: "Old task",
      },
    }, {}, theme, {}));

    expect(call.trimEnd()).toBe("Pi Agent(code-searcher: Find auth files)");
    expect(runningCall).toBe("");
    expect(result.trimEnd()).toBe("Pi Agent(code-searcher: Find auth files) accepted task_123");
    expect(legacyResult.trimEnd()).toBe("Agent(Old task) accepted task_old");
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
      name: "Inspect auth",
      content: "Detailed child result",
      display: {
        backend: "codex",
        profile: "reviewer",
      },
    };
    const failed = {
      task_id: "task_failed",
      task_type: "agent",
      status: "failed",
      session_key: "session_failed",
      name: "Inspect tests",
      content: "Provider failed",
      display: {
        backend: "claude",
        profile: "test-reviewer",
      },
    };

    const compact = renderToText(notificationRenderer({ details: completed }, { expanded: false }, theme));
    const expanded = renderToText(notificationRenderer({ details: completed }, { expanded: true }, theme));
    const failure = renderToText(notificationRenderer({ details: failed }, { expanded: false }, theme));

    expect(compact.trimEnd()).toBe("✓ Codex Agent(reviewer: Inspect auth) completed task_done");
    expect(compact).not.toContain("Detailed child result");
    expect(expanded).toContain("Detailed child result");
    expect(failure).toContain("✗ Claude Agent(test-reviewer: Inspect tests) failed task_failed");
    expect(failure).toContain("Provider failed");
  });

  it("renders Workflow calls and notifications with the parenthesized name", () => {
    const { workflowTool, notificationRenderer } = captureRenderers();
    const theme = makeMockTheme();
    const call = renderToText(workflowTool.renderCall(
      { name: "review_flow" },
      theme,
      { executionStarted: false },
    ));
    const result = renderToText(workflowTool.renderResult({
      content: [{ type: "text", text: "accepted" }],
      details: {
        task_id: "task_workflow",
        task_type: "workflow",
        status: "accepted",
        name: "review_flow",
      },
    }, {}, theme, {}));
    const notification = renderToText(notificationRenderer({
      details: {
        task_id: "task_workflow",
        task_type: "workflow",
        status: "completed",
        name: "review_flow",
        content: "Workflow result",
      },
    }, { expanded: false }, theme));

    expect(call.trimEnd()).toBe("Workflow(review_flow)");
    expect(result.trimEnd()).toBe("Workflow(review_flow) accepted task_workflow");
    expect(notification.trimEnd()).toBe("✓ Workflow(review_flow) completed task_workflow");
  });
});
