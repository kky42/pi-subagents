import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  buildFlowStatusLines,
  clearFlowUsage,
  createFlowStatusState,
  publishFlowStatus,
  recordFlowUsage,
} from "../src/core/flow-status.ts";
import type { SubagentTelemetry, SubagentUsage } from "../src/types.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

const telemetry: SubagentTelemetry = {
  tokensKnown: true,
  costKnown: true,
  costBreakdownKnown: false,
};

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): SubagentUsage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

describe("flow status display", () => {
  it("renders one cumulative tokens/cost line in the earliest widget format", () => {
    const state = createFlowStatusState();
    recordFlowUsage(state, "agent-1", usage(61_000, 60_000, 5_300_000, 0, 0.04), telemetry);

    expect(buildFlowStatusLines(state)).toEqual(["pi-flow ↑61k ↓60k R5.3M CH98.9% $0.040"]);
  });

  it("sums usage across calls and never shows per-task detail", () => {
    const state = createFlowStatusState();
    recordFlowUsage(state, "agent-1", usage(100, 10), telemetry);
    recordFlowUsage(state, "workflow-1", usage(200, 20), telemetry);

    const lines = buildFlowStatusLines(state);

    expect(lines).toEqual(["pi-flow ↑300 ↓30 CH0.0%"]);
    expect(lines[0]).not.toMatch(/agent|workflow|idle|active|done/);
  });

  it("replaces cumulative snapshots for one call instead of double counting", () => {
    const state = createFlowStatusState();
    recordFlowUsage(state, "agent-1", usage(100, 10), telemetry);
    recordFlowUsage(state, "agent-1", usage(250, 20), telemetry);

    expect(buildFlowStatusLines(state)).toEqual(["pi-flow ↑250 ↓20 CH0.0%"]);
  });

  it("marks unknown cost and hides the widget without any usage", () => {
    const unknown = createFlowStatusState();
    recordFlowUsage(unknown, "agent-1", usage(100, 10), { ...telemetry, costKnown: false });
    expect(buildFlowStatusLines(unknown)).toEqual(["pi-flow ↑100 ↓10 CH0.0% $?"]);

    expect(buildFlowStatusLines(createFlowStatusState())).toEqual([]);
  });

  it("clears accumulated usage", () => {
    const state = createFlowStatusState();
    recordFlowUsage(state, "agent-1", usage(100, 10), telemetry);
    clearFlowUsage(state);

    expect(buildFlowStatusLines(state)).toEqual([]);
  });
});

describe("flow status publish", () => {
  type WidgetContent =
    | ((tui: unknown, theme: Theme) => { render: (width: number) => string[] })
    | string[]
    | undefined;

  function widgetContext(widgets: Array<{ key: string; content: WidgetContent; placement: string | undefined }>): ExtensionContext {
    return {
      hasUI: true,
      mode: "rpc",
      ui: {
        setWidget: (key: string, content: WidgetContent, options?: { placement?: string }) => {
          widgets.push({ key, content, placement: options?.placement });
        },
      },
    } as unknown as ExtensionContext;
  }

  it("publishes a dim summary line without leading indent below the editor and clears it when empty", () => {
    const { makeMockTheme, renderToText } = setupPiSubagentTestHarness();
    const widgets: Array<{ key: string; content: WidgetContent; placement: string | undefined }> = [];
    const ctx = widgetContext(widgets);
    const state = createFlowStatusState();
    recordFlowUsage(state, "agent-1", usage(100, 10), telemetry);

    publishFlowStatus(ctx, state);

    expect(widgets).toHaveLength(1);
    expect(widgets[0].key).toBe("pi-flow");
    expect(widgets[0].placement).toBe("belowEditor");
    const colors: string[] = [];
    const theme = makeMockTheme();
    const originalFg = theme.fg;
    theme.fg = (color, text) => {
      colors.push(color);
      return originalFg(color, text);
    };
    const component = (widgets[0].content as (tui: unknown, theme: Theme) => { render: (width: number) => string[] })(null, theme);
    expect(renderToText(component).trimEnd()).toBe("pi-flow ↑100 ↓10 CH0.0%");
    expect(colors).toEqual(["dim"]);

    clearFlowUsage(state);
    publishFlowStatus(ctx, state);
    expect(widgets.at(-1)).toEqual({ key: "pi-flow", content: undefined, placement: undefined });
  });

  it("skips headless contexts", () => {
    const widgets: Array<{ key: string; content: WidgetContent; placement: string | undefined }> = [];
    const ctx = widgetContext(widgets);
    const state = createFlowStatusState();
    recordFlowUsage(state, "agent-1", usage(100, 10), telemetry);

    publishFlowStatus({ ...ctx, hasUI: false }, state);

    expect(widgets).toEqual([]);
  });
});
