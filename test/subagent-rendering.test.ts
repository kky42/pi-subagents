import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSubagentExtension } from "../src/pi-subagent.ts";
import { formatUsage } from "../src/core/subagent-render.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

describe("pi-subagent synchronous rendering", () => {
  let agentDir = "";
  const { makeMockTheme, renderToText, stripAnsi } = setupPiSubagentTestHarness((state) => {
    agentDir = state.agentDir;
  });

  function captureAgentTool() {
    let agentTool: any;
    const flags = new Map<string, boolean | string>();
    const mockApi: any = {
      registerTool: (tool: any) => {
        if (tool.name === "run_agent") agentTool = tool;
      },
      registerFlag: (name: string, options: { default?: boolean | string }) => {
        if (options.default !== undefined) flags.set(name, options.default);
      },
      getFlag: (name: string) => flags.get(name),
      on: () => {},
      getThinkingLevel: () => "high",
      events: { emit: () => {} },
    };
    createSubagentExtension()(mockApi);
    return agentTool;
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

  it("renders synchronous call and terminal states", () => {
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(join(agentDir, "subagents", "code-searcher.md"), "---\ndescription: Searches code.\n---\n");
    const agentTool = captureAgentTool();
    const theme = makeMockTheme();

    const call = renderToText(agentTool.renderCall(
      { label: "Find auth files", profile: "code-searcher", prompt: "..." },
      theme,
      { executionStarted: false },
    ));
    const executingCall = renderToText(agentTool.renderCall(
      { label: "Find auth files", profile: "code-searcher", prompt: "..." },
      theme,
      { executionStarted: true },
    ));
    const completed = renderToText(agentTool.renderResult({
      content: [{ type: "text", text: "terminal envelope" }],
      details: {
        label: "Find auth files",
        profile: "code-searcher",
        backend: "pi",
        status: "done",
        result: "auth files found",
        taskId: "task_done",
        sessionKey: "session_done",
      },
    }, {}, theme, {}));
    const failed = renderToText(agentTool.renderResult({
      content: [{ type: "text", text: "terminal envelope" }],
      details: {
        label: "Inspect tests",
        profile: "general-purpose",
        backend: "pi",
        status: "error",
        error: "Provider failed",
        taskId: "task_failed",
        sessionKey: "session_failed",
      },
    }, {}, theme, {}));
    const aborted = renderToText(agentTool.renderResult({
      content: [{ type: "text", text: "terminal envelope" }],
      details: {
        label: "Stop task",
        profile: "general-purpose",
        backend: "pi",
        status: "aborted",
        error: "User aborted",
        taskId: "task_aborted",
        sessionKey: "session_aborted",
      },
    }, {}, theme, {}));

    expect(call.trimEnd()).toBe("Pi Agent(code-searcher: Find auth files)");
    expect(executingCall).toBe("");
    expect(completed).toContain("✓ Pi Agent(code-searcher, Find auth files)");
    expect(failed).toContain("✗ Pi Agent(general-purpose, Inspect tests)");
    expect(failed).toContain("error: Provider failed");
    expect(aborted).toContain("⊘ Pi Agent(general-purpose, Stop task)");
    expect(aborted).toContain("aborted: User aborted");
    expect(completed).not.toContain("task_done");
    expect(completed).not.toContain("session_done");
  });

  it("renders queued and running progress with rolling activity and usage", () => {
    const agentTool = captureAgentTool();
    const theme = makeMockTheme();
    const now = 1_700_000_000_000;
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const queued = renderToText(agentTool.renderResult({
        content: [{ type: "text", text: "queued" }],
        details: {
          label: "Wait turn",
          profile: "general-purpose",
          backend: "pi",
          status: "queued",
          taskId: "task_queued",
          sessionKey: "session_queued",
          progress: {
            id: "queued-call",
            label: "Wait turn",
            profile: "general-purpose",
            backend: "pi",
            status: "queued",
            startedAt: now - 2000,
            activity: [],
            activityCount: 0,
          },
        },
      }, {}, theme, {}));
      const runningResult = {
        content: [{ type: "text" as const, text: "running" }],
        details: {
          label: "Research repo",
          profile: "code-searcher" as const,
          backend: "pi" as const,
          status: "running" as const,
          taskId: "task_running",
          sessionKey: "session_running",
          activeCount: 1,
          usage: {
            input: 81_000,
            output: 4_900,
            cacheRead: 602_000,
            cacheWrite: 0,
            totalTokens: 687_900,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.85 },
          },
          progress: {
            id: "running-call",
            label: "Research repo",
            profile: "code-searcher" as const,
            backend: "pi" as const,
            status: "running" as const,
            startedAt: now - 2000,
            activity: ["Read app.py", "Read config.yaml"],
            activityCount: 4,
          },
          telemetry: {
            tokensKnown: true,
            costKnown: true,
            costBreakdownKnown: false,
          },
        },
      };
      const running = renderToText(agentTool.renderResult(runningResult, {}, theme, {}));

      expect(queued).toContain("◌ Pi Agent(general-purpose, Wait turn) queued 2s");
      expect(running).toContain("Pi Agent(code-searcher: Research repo)");
      expect(running).toContain("2s ↑81k ↓4.9k R602k CH88.1% $0.850");
      expect(running).toContain("... +2 earlier events");
      expect(running).toContain("Read app.py");
      expect(running).toContain("Read config.yaml");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("truncates long activity only in rendered output", () => {
    const agentTool = captureAgentTool();
    const theme = makeMockTheme();
    const hiddenTail = "TAIL_MARKER_SHOULD_STAY_OUT_OF_RENDERED_PREVIEW";
    const longCommand = `bash uv run python ${"print('long payload') ".repeat(30)}${hiddenTail}`;
    const result = {
      content: [{ type: "text" as const, text: "running" }],
      details: {
        label: "Long tool call",
        profile: "general-purpose" as const,
        backend: "pi" as const,
        status: "running" as const,
        activeCount: 1,
        taskId: "task_long",
        sessionKey: "session_long",
        progress: {
          id: "long-call",
          label: "Long tool call",
          profile: "general-purpose" as const,
          backend: "pi" as const,
          status: "running" as const,
          startedAt: Date.now(),
          activity: [longCommand],
          activityCount: 1,
        },
      },
    };

    const text = renderToText(agentTool.renderResult(result, {}, theme, {}));
    expect(text).toContain("bash uv run python");
    expect(text).toContain("... (+");
    expect(text).not.toContain(hiddenTail);
    expect(result.details.progress.activity[0]).toBe(longCommand);

    const narrowLines = agentTool.renderResult(result, {}, theme, {})
      .render(80)
      .map((line: string) => stripAnsi(line))
      .filter((line: string) => line.trim());
    expect(narrowLines).toHaveLength(2);
  });
});
