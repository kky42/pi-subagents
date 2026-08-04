import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  SubagentBackend,
  SubagentTelemetry,
  SubagentUsage,
} from "../types.ts";
import type { TaskCounts } from "./task-manager.ts";
import { formatAgentDisplayLabel } from "./display.ts";
import {
  formatDuration,
  formatUsage,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from "./subagent-render.ts";

export const FLOW_STATUS_KEY = "pi-flow";
export const MAX_FLOW_STATUS_LINES = 5;
const MAX_ACTIVE_DETAIL_LINES = 3;
const flowSpinnerStates = new WeakMap<FlowStatusState, { frame: number }>();

interface FlowUsageEntry {
  usage: SubagentUsage;
  telemetry: SubagentTelemetry;
}

interface SubagentStatusBase {
  id: string;
  label: string;
  profile: string;
  backend: SubagentBackend;
  queuedAt: number;
}

export interface QueuedSubagentStatus extends SubagentStatusBase {
  executionState: "queued";
}

export interface RunningSubagentStatus extends SubagentStatusBase {
  executionState: "running";
  startedAt: number;
  eventCount: number;
}

export type ActiveSubagentStatus = QueuedSubagentStatus | RunningSubagentStatus;

export interface ActiveWorkflowStatus {
  id: string;
  name: string;
  startedAt: number;
  finishedSubagents: number;
  totalSubagents: number;
}

export interface FlowStatusState {
  calls: Map<string, FlowUsageEntry>;
  activeSubagents: Map<string, ActiveSubagentStatus>;
  activeWorkflows: Map<string, ActiveWorkflowStatus>;
  tasks: TaskCounts;
}

interface DetailLine {
  kind: "subagent" | "workflow";
  sortAt: number;
  text: string;
}

export function createFlowStatusState(): FlowStatusState {
  return {
    calls: new Map(),
    activeSubagents: new Map(),
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
  state.activeSubagents.clear();
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

function activeSubagentLine(state: FlowStatusState, subagent: ActiveSubagentStatus, now: number): DetailLine {
  const display = { backend: subagent.backend, profile: subagent.profile };
  const taskLabel = formatAgentDisplayLabel(display, subagent.label);
  if (subagent.executionState === "queued") {
    return {
      kind: "subagent",
      sortAt: subagent.queuedAt,
      text: `◌ ${taskLabel} queued`,
    };
  }
  const call = state.calls.get(subagent.id);
  const events = countLabel(subagent.eventCount, "event");
  const usage = call ? usageSuffix(call.usage, call.telemetry) : "";
  return {
    kind: "subagent",
    sortAt: subagent.queuedAt,
    text: `${spinner(now)} ${taskLabel} ${formatDuration(now - subagent.startedAt)} · ${events}${usage}`,
  };
}

function activeWorkflowLine(state: FlowStatusState, workflow: ActiveWorkflowStatus, now: number): DetailLine {
  const totals = getUsageTotals(state, (callId) => callId.startsWith(`${workflow.id}:subagent:`));
  const subagents = countLabel(workflow.totalSubagents, "subagent");
  return {
    kind: "workflow",
    sortAt: workflow.startedAt,
    text: `${spinner(now)} Workflow(${workflow.name}) ${formatDuration(now - workflow.startedAt)} · ${workflow.finishedSubagents}/${subagents}${usageSuffix(totals.usage, totals.telemetry)}`,
  };
}

function selectDetailLines(lines: DetailLine[]): DetailLine[] {
  const sorted = [...lines].sort((left, right) => left.sortAt - right.sortAt);
  const selected = sorted.slice(0, MAX_ACTIVE_DETAIL_LINES);
  if (selected.length < MAX_ACTIVE_DETAIL_LINES) {
    return selected;
  }

  const kinds = new Set(selected.map((line) => line.kind));
  for (const kind of ["subagent", "workflow"] as const) {
    if (kinds.has(kind)) {
      continue;
    }
    const replacement = sorted.find((line) => line.kind === kind);
    if (replacement) {
      selected[selected.length - 1] = replacement;
    }
  }
  return selected.sort((left, right) => left.sortAt - right.sortAt);
}

export function buildFlowStatusLines(state: FlowStatusState, now = Date.now()): string[] {
  const totals = getUsageTotals(state);
  const activeSubagentCount = Math.max(0, state.tasks.agent.total - state.tasks.agent.finished);
  const activeWorkflowCount = Math.max(0, state.tasks.workflow.total - state.tasks.workflow.finished);
  const totalTasks = state.tasks.agent.total + state.tasks.workflow.total;

  if (totalTasks === 0 && !hasUsage(totals.usage)) {
    return [];
  }

  if (activeSubagentCount === 0 && activeWorkflowCount === 0) {
    return [
      `pi-flow idle · ${countLabel(state.tasks.agent.finished, "agent")} and ${countLabel(state.tasks.workflow.finished, "workflow")} done${usageSuffix(totals.usage, totals.telemetry)}`,
    ];
  }

  const summary = `pi-flow ${countLabel(activeSubagentCount, "agent")} and ${countLabel(activeWorkflowCount, "workflow")} active${usageSuffix(totals.usage, totals.telemetry)}`;
  const detailCandidates = [
    ...[...state.activeSubagents.values()].map((subagent) => activeSubagentLine(state, subagent, now)),
    ...[...state.activeWorkflows.values()].map((workflow) => activeWorkflowLine(state, workflow, now)),
  ];
  const details = selectDetailLines(detailCandidates);
  const shownSubagents = details.filter((line) => line.kind === "subagent").length;
  const shownWorkflows = details.filter((line) => line.kind === "workflow").length;
  const hiddenSubagents = Math.max(0, activeSubagentCount - shownSubagents);
  const hiddenWorkflows = Math.max(0, activeWorkflowCount - shownWorkflows);
  const hidden: string[] = [];
  if (hiddenSubagents > 0) {
    hidden.push(`${hiddenSubagents} more ${hiddenSubagents === 1 ? "agent" : "agents"}`);
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
      (tui, theme) => {
        const rows = lines.map((line) => {
          const firstCharacter = [...line][0] ?? "";
          const animated = SPINNER_FRAMES.includes(firstCharacter);
          return {
            animated,
            text: animated ? line.slice(firstCharacter.length + 1) : line,
          };
        });
        const spinnerState = flowSpinnerStates.get(state) ?? { frame: 0 };
        flowSpinnerStates.set(state, spinnerState);
        const interval = rows.some((row) => row.animated)
          ? setInterval(() => {
              spinnerState.frame = (spinnerState.frame + 1) % SPINNER_FRAMES.length;
              tui.requestRender();
            }, SPINNER_INTERVAL_MS)
          : undefined;
        interval?.unref?.();

        return {
          render(width: number): string[] {
            return rows.map((row) => {
              let rendered: string;
              if (row.animated) {
                rendered = `${theme.fg("accent", SPINNER_FRAMES[spinnerState.frame])} ${theme.fg("dim", row.text)}`;
              } else {
                rendered = theme.fg("dim", row.text);
              }
              return truncateToWidth(rendered, width, theme.fg("dim", "..."));
            });
          },
          invalidate() {},
          dispose() {
            if (interval) clearInterval(interval);
          },
        };
      },
      { placement: "belowEditor" },
    );
    return;
  }

  ctx.ui.setWidget(FLOW_STATUS_KEY, lines, { placement: "belowEditor" });
}
