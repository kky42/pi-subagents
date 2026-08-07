import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentTelemetry, SubagentUsage } from "../types.ts";
import { formatUsage } from "./subagent-render.ts";

export const FLOW_STATUS_KEY = "pi-flow";

export interface FlowStatusState {
  calls: Map<string, { usage: SubagentUsage; telemetry: SubagentTelemetry }>;
}

export function createFlowStatusState(): FlowStatusState {
  return { calls: new Map() };
}

export function clearFlowUsage(state: FlowStatusState): void {
  state.calls.clear();
}

export function recordFlowUsage(
  state: FlowStatusState,
  callId: string,
  usage: SubagentUsage,
  telemetry?: SubagentTelemetry,
): void {
  state.calls.set(callId, {
    usage,
    telemetry: telemetry ?? { tokensKnown: true, costKnown: true, costBreakdownKnown: false },
  });
}

function emptyUsage(): SubagentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function getUsageTotals(state: FlowStatusState): { usage: SubagentUsage; telemetry: SubagentTelemetry } {
  const usage = emptyUsage();
  let reasoningReported = false;
  let costKnown = true;
  for (const entry of state.calls.values()) {
    usage.input += entry.usage.input;
    usage.output += entry.usage.output;
    usage.cacheRead += entry.usage.cacheRead;
    usage.cacheWrite += entry.usage.cacheWrite;
    usage.cost.total += entry.usage.cost.total;
    if (entry.usage.reasoning !== undefined) {
      usage.reasoning = (usage.reasoning ?? 0) + entry.usage.reasoning;
      reasoningReported = true;
    }
    costKnown &&= entry.telemetry.costKnown;
  }
  if (!reasoningReported) {
    delete usage.reasoning;
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return {
    usage,
    telemetry: { tokensKnown: true, costKnown, costBreakdownKnown: false },
  };
}

function hasUsage(usage: SubagentUsage): boolean {
  return usage.totalTokens > 0 || usage.cost.total > 0;
}

export function buildFlowStatusLines(state: FlowStatusState): string[] {
  const totals = getUsageTotals(state);
  if (!hasUsage(totals.usage)) {
    return [];
  }
  return [`pi-flow ${formatUsage(totals.usage, totals.telemetry)}`];
}

export function publishFlowStatus(ctx: ExtensionContext, state: FlowStatusState): void {
  if (!ctx.hasUI) {
    return;
  }
  const lines = buildFlowStatusLines(state);
  if (lines.length === 0) {
    ctx.ui.setWidget(FLOW_STATUS_KEY, undefined);
    return;
  }
  // Component form instead of string lines: pi renders string widgets with a
  // forced one-space indent and default color, while the built-in footer uses
  // no indent and dim text. Match the footer exactly.
  ctx.ui.setWidget(FLOW_STATUS_KEY, (_tui, theme) => {
    const container = new Container();
    for (const line of lines) {
      container.addChild(new Text(theme.fg("dim", line), 0, 0));
    }
    return container;
  }, { placement: "belowEditor" });
}
