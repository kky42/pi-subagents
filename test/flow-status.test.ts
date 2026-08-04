import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
import {
  buildFlowStatusLines,
  createFlowStatusState,
  MAX_FLOW_STATUS_LINES,
  publishFlowStatus,
  recordFlowUsage,
} from "../src/core/flow-status.ts";
import type { SubagentTelemetry, SubagentUsage } from "../src/types.ts";

const telemetry: SubagentTelemetry = {
  tokensKnown: true,
  costKnown: true,
  costBreakdownKnown: false,
};

function usage(input: number, output: number, cacheRead = 0, cost = 0): SubagentUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

describe("flow status display", () => {
  it("renders at most five active lines with fair subagent and workflow detail", () => {
    const state = createFlowStatusState();
    state.tasks = {
      subagent: { finished: 0, total: 4 },
      workflow: { finished: 0, total: 2 },
    };
    for (let index = 0; index < 4; index++) {
      state.activeSubagents.set(`agent-${index}`, {
        id: `agent-${index}`,
        label: `task ${index}`,
        profile: index === 0 ? "context-gather" : "expert",
        backend: index === 0 ? "codex" : "pi",
        executionState: "running",
        queuedAt: index * 1000,
        startedAt: index * 1000,
        eventCount: index + 1,
      });
      recordFlowUsage(state, `agent-${index}`, usage(100, 10), telemetry);
    }
    for (let index = 0; index < 2; index++) {
      state.activeWorkflows.set(`workflow-${index}`, {
        id: `workflow-${index}`,
        name: `review_${index}`,
        startedAt: 4000 + index * 1000,
        finishedSubagents: index + 2,
        totalSubagents: 6,
      });
      recordFlowUsage(state, `workflow-${index}:subagent:1`, usage(200, 20), telemetry);
    }

    const lines = buildFlowStatusLines(state, 32_000);

    expect(lines).toHaveLength(MAX_FLOW_STATUS_LINES);
    expect(lines[0]).toBe("pi-flow 4 subagents and 2 workflows active · ↑800 ↓80 CH0.0%");
    expect(lines.some((line) => line.includes("Codex Subagent(context-gather: task 0) 32s · 1 event · ↑100 ↓10 CH0.0%"))).toBe(true);
    expect(lines.filter((line) => line.includes("Workflow("))).toHaveLength(1);
    expect(lines.at(-1)).toBe("… 2 more subagents, 1 more workflow");
  });

  it("keeps queued subagents static beside running subagents and one workflow row", () => {
    const state = createFlowStatusState();
    state.tasks = {
      subagent: { finished: 0, total: 2 },
      workflow: { finished: 0, total: 1 },
    };
    state.activeSubagents.set("queued-agent", {
      id: "queued-agent",
      label: "waiting",
      profile: "general-purpose",
      backend: "pi",
      executionState: "queued",
      queuedAt: 1_000,
    });
    state.activeSubagents.set("running-agent", {
      id: "running-agent",
      label: "working",
      profile: "reviewer",
      backend: "codex",
      executionState: "running",
      queuedAt: 2_000,
      startedAt: 9_000,
      eventCount: 3,
    });
    state.activeWorkflows.set("workflow", {
      id: "workflow",
      name: "review_flow",
      startedAt: 3_000,
      finishedSubagents: 1,
      totalSubagents: 3,
    });
    recordFlowUsage(state, "queued-agent", usage(500, 50), telemetry);
    recordFlowUsage(state, "running-agent", usage(100, 10), telemetry);

    const lines = buildFlowStatusLines(state, 10_500);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("pi-flow 2 subagents and 1 workflow active · ↑600 ↓60 CH0.0%");
    expect(lines[1]).toBe("◌ Pi Subagent(general-purpose: waiting) queued");
    expect(lines[1]).not.toMatch(/\d+s|event|↑|↓/);
    expect(lines[2]).toContain("Codex Subagent(reviewer: working) 1s · 3 events · ↑100 ↓10 CH0.0%");
    expect(lines[3]).toContain("Workflow(review_flow) 7s · 1/3 subagents");
  });

  it("uses pi's spinner animation while keeping widget text consistently dim", () => {
    vi.setSystemTime(2_000);
    const state = createFlowStatusState();
    state.tasks = {
      subagent: { finished: 0, total: 1 },
      workflow: { finished: 0, total: 0 },
    };
    state.activeSubagents.set("agent", {
      id: "agent",
      label: "working",
      profile: "general-purpose",
      backend: "pi",
      executionState: "running",
      queuedAt: 1_000,
      startedAt: 1_000,
      eventCount: 1,
    });

    let widget: unknown;
    let renders = 0;
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: (_key: string, content: unknown) => {
          widget = content;
        },
      },
    } as unknown as ExtensionContext;

    publishFlowStatus(ctx, state);
    const component = (widget as (
      tui: { requestRender: () => void },
      theme: { fg: (color: string, text: string) => string },
    ) => { render: (width: number) => string[]; dispose: () => void })(
      { requestRender: () => renders++ },
      { fg: (color, text) => `<${color}>${text}</${color}>` },
    );

    const first = component.render(200)[1];
    expect(first).toContain("<accent>⠋</accent> <dim>Pi Subagent(general-purpose: working)");
    vi.advanceTimersByTime(80);
    const second = component.render(200)[1];

    expect(renders).toBe(1);
    expect(second).toContain("<accent>⠙</accent> <dim>Pi Subagent(general-purpose: working)");
    component.dispose();
    vi.advanceTimersByTime(80);
    expect(renders).toBe(1);
  });

  it("truncates themed TUI output to a narrow terminal width", () => {
    const state = createFlowStatusState();
    state.tasks = {
      subagent: { finished: 0, total: 4 },
      workflow: { finished: 0, total: 1 },
    };
    for (let index = 0; index < 4; index++) {
      state.activeSubagents.set(`agent-${index}`, index === 3
        ? {
            id: `agent-${index}`,
            label: `long-queued-agent-${index}`,
            profile: "general-purpose",
            backend: "pi",
            executionState: "queued",
            queuedAt: index,
          }
        : {
            id: `agent-${index}`,
            label: `long-running-agent-${index}`,
            profile: "general-purpose",
            backend: "pi",
            executionState: "running",
            queuedAt: index,
            startedAt: index,
            eventCount: 100 + index,
          });
    }
    state.activeWorkflows.set("workflow-1", {
      id: "workflow-1",
      name: "long-running-workflow",
      startedAt: 10,
      finishedSubagents: 2,
      totalSubagents: 8,
    });
    let widget: unknown;
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        setWidget: (_key: string, content: unknown) => {
          widget = content;
        },
      },
    } as unknown as ExtensionContext;

    publishFlowStatus(ctx, state);
    const component = (widget as (tui: unknown, theme: { fg: (color: string, text: string) => string }) => { render: (width: number) => string[] })(
      {},
      { fg: (_color, text) => `\u001b[36m${text}\u001b[39m` },
    );
    const width = 24;
    const lines = component.render(width);
    const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

    expect(lines).toHaveLength(MAX_FLOW_STATUS_LINES);
    expect(lines.every((line) => line.includes("\u001b["))).toBe(true);
    expect(plainLines.every((line) => line.length <= width)).toBe(true);
    expect(plainLines.some((line) => line.endsWith("..."))).toBe(true);
  });

  it("removes active detail in idle state and keeps cumulative usage", () => {
    const state = createFlowStatusState();
    state.tasks = {
      subagent: { finished: 6, total: 6 },
      workflow: { finished: 1, total: 1 },
    };
    state.activeSubagents.set("stale", {
      id: "stale",
      label: "must not render",
      profile: "expert",
      backend: "pi",
      executionState: "running",
      queuedAt: 0,
      startedAt: 0,
      eventCount: 9,
    });
    recordFlowUsage(state, "agent-1", usage(1_000_000, 137_000, 17_000_000, 18.393), telemetry);

    expect(buildFlowStatusLines(state, 50_000)).toEqual([
      "pi-flow idle · 6 subagents and 1 workflow done · ↑1.0M ↓137k R17M CH94.4% $18.393",
    ]);
  });

  it("replaces cumulative snapshots for one call instead of double counting", () => {
    const state = createFlowStatusState();
    state.tasks = {
      subagent: { finished: 1, total: 1 },
      workflow: { finished: 0, total: 0 },
    };
    recordFlowUsage(state, "agent-1", usage(100, 10), telemetry);
    recordFlowUsage(state, "agent-1", usage(250, 20), telemetry);

    expect(buildFlowStatusLines(state)).toEqual([
      "pi-flow idle · 1 subagent and 0 workflows done · ↑250 ↓20 CH0.0%",
    ]);
  });

  it("stays hidden before the session launches any pi-flow task", () => {
    expect(buildFlowStatusLines(createFlowStatusState())).toEqual([]);
  });
});
