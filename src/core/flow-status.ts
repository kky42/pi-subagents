import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  SubagentBackend,
  SubagentTelemetry,
  SubagentUsage,
} from "../types.ts";
import type { TaskCounts } from "./task-manager.ts";
import { getBackendAgentLabel } from "./display.ts";
import {
  formatDuration,
  formatUsage,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from "./subagent-render.ts";

export const FLOW_STATUS_KEY = "pi-flow";
export const MAX_FLOW_STATUS_LINES = 5;
const MAX_ACTIVE_DETAIL_LINES = 3;

interface FlowUsageEntry {
  usage: SubagentUsage;
  telemetry: SubagentTelemetry;
}

export interface ActiveAgentStatus {
  id: string;
  name: string;
  subagentType: string;
  backend: SubagentBackend;
  startedAt: number;
  eventCount: number;
}

export interface ActiveWorkflowStatus {
  id: string;
  name: string;
  startedAt: number;
  finishedAgents: number;
  totalAgents: number;
}

export interface FlowStatusState {
  calls: Map<string, FlowUsageEntry>;
  activeAgents: Map<string, ActiveAgentStatus>;
  activeWorkflows: Map<string, ActiveWorkflowStatus>;
  tasks: TaskCounts;
}

interface DetailLine {
  kind: "agent" | "workflow";
  startedAt: number;
  text: string;
}

export function createFlowStatusState(): FlowStatusState {
  return {
    calls: new Map(),
    activeAgents: new Map(),
    activeWorkflows: new Map(),
    tasks: {
      agent: { finished: 0, total: 0 },
      workflow: { finished: 0, total: 0 },
    },
  };
}

export function recordFlowUsage(
  state: FlowStatusState,
  callId: string,
  usage: SubagentUsage,
  telemetry: SubagentTelemetry,
): void {
  state.calls.set(callId, { usage, telemetry });
}

export function clearActiveFlowTasks(state: FlowStatusState): void {
  state.activeAgents.clear();
  state.activeWorkflows.clear();
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

function getUsageTotals(
  state: FlowStatusState,
  include: (callId: string) => boolean = () => true,
): { usage: SubagentUsage; telemetry: SubagentTelemetry } {
  const usage = emptyUsage();
  let reasoningReported = false;
  let costKnown = true;
  for (const [callId, entry] of state.calls) {
    if (!include(callId)) {
      continue;
    }
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

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function usageSuffix(usage: SubagentUsage, telemetry: SubagentTelemetry): string {
  return hasUsage(usage) ? ` · ${formatUsage(usage, telemetry)}` : "";
}

function spinner(now: number): string {
  const frame = Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[frame];
}

function activeAgentLine(state: FlowStatusState, agent: ActiveAgentStatus, now: number): DetailLine {
  const call = state.calls.get(agent.id);
  const descriptor = agent.name
    ? `${agent.subagentType}: ${agent.name}`
    : agent.subagentType;
  const events = countLabel(agent.eventCount, "event");
  const usage = call ? usageSuffix(call.usage, call.telemetry) : "";
  return {
    kind: "agent",
    startedAt: agent.startedAt,
    text: `${spinner(now)} ${getBackendAgentLabel(agent.backend)}(${descriptor}) ${formatDuration(now - agent.startedAt)} · ${events}${usage}`,
  };
}

function activeWorkflowLine(state: FlowStatusState, workflow: ActiveWorkflowStatus, now: number): DetailLine {
  const totals = getUsageTotals(state, (callId) => callId.startsWith(`${workflow.id}:agent:`));
  const agents = countLabel(workflow.totalAgents, "agent");
  return {
    kind: "workflow",
    startedAt: workflow.startedAt,
    text: `${spinner(now)} Workflow(${workflow.name}) ${formatDuration(now - workflow.startedAt)} · ${workflow.finishedAgents}/${agents}${usageSuffix(totals.usage, totals.telemetry)}`,
  };
}

function selectDetailLines(lines: DetailLine[]): DetailLine[] {
  const sorted = [...lines].sort((left, right) => left.startedAt - right.startedAt);
  const selected = sorted.slice(0, MAX_ACTIVE_DETAIL_LINES);
  if (selected.length < MAX_ACTIVE_DETAIL_LINES) {
    return selected;
  }

  const kinds = new Set(selected.map((line) => line.kind));
  for (const kind of ["agent", "workflow"] as const) {
    if (kinds.has(kind)) {
      continue;
    }
    const replacement = sorted.find((line) => line.kind === kind);
    if (replacement) {
      selected[selected.length - 1] = replacement;
    }
  }
  return selected.sort((left, right) => left.startedAt - right.startedAt);
}

export function buildFlowStatusLines(state: FlowStatusState, now = Date.now()): string[] {
  const totals = getUsageTotals(state);
  const activeAgentCount = Math.max(0, state.tasks.agent.total - state.tasks.agent.finished);
  const activeWorkflowCount = Math.max(0, state.tasks.workflow.total - state.tasks.workflow.finished);
  const totalTasks = state.tasks.agent.total + state.tasks.workflow.total;

  if (totalTasks === 0 && !hasUsage(totals.usage)) {
    return [];
  }

  if (activeAgentCount === 0 && activeWorkflowCount === 0) {
    return [
      `pi-flow idle · ${countLabel(state.tasks.agent.finished, "agent")} and ${countLabel(state.tasks.workflow.finished, "workflow")} done${usageSuffix(totals.usage, totals.telemetry)}`,
    ];
  }

  const summary = `pi-flow ${countLabel(activeAgentCount, "agent")} and ${countLabel(activeWorkflowCount, "workflow")} running${usageSuffix(totals.usage, totals.telemetry)}`;
  const detailCandidates = [
    ...[...state.activeAgents.values()].map((agent) => activeAgentLine(state, agent, now)),
    ...[...state.activeWorkflows.values()].map((workflow) => activeWorkflowLine(state, workflow, now)),
  ];
  const details = selectDetailLines(detailCandidates);
  const shownAgents = details.filter((line) => line.kind === "agent").length;
  const shownWorkflows = details.filter((line) => line.kind === "workflow").length;
  const hiddenAgents = Math.max(0, activeAgentCount - shownAgents);
  const hiddenWorkflows = Math.max(0, activeWorkflowCount - shownWorkflows);
  const hidden: string[] = [];
  if (hiddenAgents > 0) {
    hidden.push(`${hiddenAgents} more ${hiddenAgents === 1 ? "agent" : "agents"}`);
  }
  if (hiddenWorkflows > 0) {
    hidden.push(`${hiddenWorkflows} more ${hiddenWorkflows === 1 ? "workflow" : "workflows"}`);
  }

  const lines = [summary, ...details.map((line) => line.text)];
  if (hidden.length > 0) {
    lines.push(`… ${hidden.join(", ")}`);
  }
  return lines.slice(0, MAX_FLOW_STATUS_LINES);
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

  if (ctx.mode === "tui") {
    ctx.ui.setWidget(
      FLOW_STATUS_KEY,
      (_tui, theme) => ({
        render(width: number): string[] {
          return lines.map((line, index) => {
            const color = index === 0 || line.startsWith("…") ? "dim" : "muted";
            return truncateToWidth(theme.fg(color, line), width, theme.fg("dim", "..."));
          });
        },
        invalidate() {},
      }),
      { placement: "belowEditor" },
    );
    return;
  }

  ctx.ui.setWidget(FLOW_STATUS_KEY, lines, { placement: "belowEditor" });
}
