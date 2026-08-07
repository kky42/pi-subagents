import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
  type ThemeColor,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { ConcurrencyLimiter } from "./core/concurrency.ts";
import { filterProfilesForModelRegistry } from "./core/model.ts";
import { MAX_MODEL_VISIBLE_TEXT_CHARS } from "./core/progress.ts";
import {
  isActiveSubagentStatus,
  isCompletedSubagentStatus,
  renderSubagentNode,
} from "./core/subagent-render.ts";
import { SPINNER_INTERVAL_MS } from "./core/spinner.ts";
import {
  SynchronousTaskManager,
  taskEnvelopeContent,
  type WorkflowTerminalTaskEnvelope,
} from "./core/task-manager.ts";
import { getSubagentProfiles } from "./profiles.ts";
import type {
  SubagentUsage,
  WorkflowPhaseSnapshot,
  WorkflowSubagentSnapshot,
  WorkflowSubagentStatusCounts,
  WorkflowToolDetails,
} from "./types.ts";
import { isWorkflowAbortError, runWorkflow } from "./workflow/runtime.ts";
import { prepareWorkflowToolSource } from "./workflow/source.ts";
import { createWorkflowSubagentRunner } from "./workflow/subagent-runner.ts";

const WORKFLOW_PROMPT_SNIPPET = "Orchestrate dependent or larger multi-subagent work";

export const WORKFLOW_DISPLAY_SUBAGENT_LIMIT = 12;
export const WORKFLOW_DISPLAY_PHASE_LIMIT = 8;
export const WORKFLOW_DISPLAY_LOG_LIMIT = 3;
export const WORKFLOW_RESULT_PREVIEW_CHARS = 2_000;
export const WORKFLOW_ACTIVITY_PREVIEW_LINES = 2;
export const WORKFLOW_ACTIVITY_PREVIEW_CHARS = 240;
export const WORKFLOW_LOG_PREVIEW_CHARS = 240;
export const WORKFLOW_PHASE_PREVIEW_CHARS = 160;
export const WORKFLOW_METADATA_PREVIEW_CHARS = 160;
export const WORKFLOW_ERROR_PREVIEW_CHARS = 1_000;
export const MAX_WORKFLOW_DETAILS_JSON_CHARS = 60_000;
export const MAX_WORKFLOW_UPDATE_JSON_CHARS = 65_536;

const TRUNCATED_PREVIEW_SUFFIX = " ... [truncated]";

interface WorkflowDisplayLimits {
  subagents: number;
  phases: number;
  logs: number;
  metadataChars: number;
  phaseChars: number;
  logChars: number;
  resultChars: number;
  errorChars: number;
  activityLines: number;
  activityChars: number;
  includeSessionKeys: boolean;
}

const WORKFLOW_DISPLAY_LIMITS: WorkflowDisplayLimits = {
  subagents: WORKFLOW_DISPLAY_SUBAGENT_LIMIT,
  phases: WORKFLOW_DISPLAY_PHASE_LIMIT,
  logs: WORKFLOW_DISPLAY_LOG_LIMIT,
  metadataChars: WORKFLOW_METADATA_PREVIEW_CHARS,
  phaseChars: WORKFLOW_PHASE_PREVIEW_CHARS,
  logChars: WORKFLOW_LOG_PREVIEW_CHARS,
  resultChars: WORKFLOW_RESULT_PREVIEW_CHARS,
  errorChars: WORKFLOW_ERROR_PREVIEW_CHARS,
  activityLines: WORKFLOW_ACTIVITY_PREVIEW_LINES,
  activityChars: WORKFLOW_ACTIVITY_PREVIEW_CHARS,
  includeSessionKeys: true,
};

const COMPACT_WORKFLOW_DISPLAY_LIMITS: WorkflowDisplayLimits = {
  subagents: 8,
  phases: 6,
  logs: 2,
  metadataChars: 96,
  phaseChars: 96,
  logChars: 160,
  resultChars: 512,
  errorChars: 512,
  activityLines: 1,
  activityChars: 120,
  includeSessionKeys: false,
};

const WORKFLOW_PROMPT_GUIDELINES = [
  "Omit script and script_path to run a saved workflow by name.",
  "Only run trusted workflow scripts; worker VM isolation detects stalls but is not a security boundary.",
];

const WORKFLOW_TOOL_DESCRIPTION = [
  "Use run_workflow for multi-subagent orchestration that requires dependent stages, branching, structured outputs, or larger fan-out.",
  "Run a matching saved workflow when available; otherwise provide a trusted ad-hoc script.",
].join(" ");

export const workflowToolParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    maxLength: WORKFLOW_METADATA_PREVIEW_CHARS,
    pattern: ".*\\S.*",
    description: "Workflow meta.name; required and must match the selected script or path.",
  }),
  script: Type.Optional(
    Type.String({
      description: "Trusted ad-hoc workflow JavaScript source whose meta.name matches name; do not include explanatory prose.",
    }),
  ),
  script_path: Type.Optional(
    Type.String({
      description: "Path to a trusted saved workflow script whose meta.name matches name.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed unchanged to the workflow as the global `args`." }),
  ),
}, { additionalProperties: false });

export type WorkflowToolParams = Static<typeof workflowToolParameters>;

export interface CreateRunWorkflowToolOptions {
  getTaskManager: () => SynchronousTaskManager;
  getLimiter: () => ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
}

interface WorkflowExecutionResult {
  details: WorkflowToolDetails;
  terminalContent: string;
  usage?: SubagentUsage;
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

function aggregateWorkflowUsage(subagents: readonly WorkflowSubagentSnapshot[]): {
  usage?: SubagentUsage;
  telemetry: WorkflowToolDetails["telemetry"];
} {
  const withUsage = subagents.filter(
    (subagent): subagent is WorkflowSubagentSnapshot & { usage: SubagentUsage } => Boolean(subagent.usage),
  );
  const missingUsageSubagentCount = subagents.length - withUsage.length;
  if (withUsage.length === 0) {
    return {
      telemetry: {
        tokensKnown: subagents.length === 0,
        costKnown: subagents.length === 0,
        costBreakdownKnown: false,
        partial: missingUsageSubagentCount > 0,
        missingUsageSubagentCount,
      },
    };
  }

  const usage = emptyUsage();
  let reasoningReported = false;
  for (const subagent of withUsage) {
    usage.input += subagent.usage.input;
    usage.output += subagent.usage.output;
    usage.cacheRead += subagent.usage.cacheRead;
    usage.cacheWrite += subagent.usage.cacheWrite;
    usage.cost.input += subagent.usage.cost.input;
    usage.cost.output += subagent.usage.cost.output;
    usage.cost.cacheRead += subagent.usage.cost.cacheRead;
    usage.cost.cacheWrite += subagent.usage.cost.cacheWrite;
    usage.cost.total += subagent.usage.cost.total;
    if (subagent.usage.reasoning !== undefined) {
      usage.reasoning = (usage.reasoning ?? 0) + subagent.usage.reasoning;
      reasoningReported = true;
    }
  }
  if (!reasoningReported) {
    delete usage.reasoning;
  }
  usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const telemetry = withUsage.map((subagent) => subagent.telemetry);
  return {
    usage,
    telemetry: {
      tokensKnown: missingUsageSubagentCount === 0 && telemetry.every((item) => item?.tokensKnown !== false),
      costKnown: missingUsageSubagentCount === 0 && telemetry.every((item) => item?.costKnown !== false),
      costBreakdownKnown:
        missingUsageSubagentCount === 0 && telemetry.every((item) => item?.costBreakdownKnown === true),
      costEstimated: telemetry.some((item) => item?.costEstimated === true),
      partial: missingUsageSubagentCount > 0 || telemetry.some((item) => item?.partial === true),
      missingUsageSubagentCount,
    },
  };
}

function emptySubagentStatusCounts(): WorkflowSubagentStatusCounts {
  return { queued: 0, running: 0, done: 0, error: 0, aborted: 0 };
}

function countSubagentStatuses(subagents: readonly WorkflowSubagentSnapshot[]): WorkflowSubagentStatusCounts {
  const counts = emptySubagentStatusCounts();
  for (const subagent of subagents) {
    counts[subagent.status]++;
  }
  return counts;
}

function boundedTextPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const retainedChars = Math.max(0, maxChars - TRUNCATED_PREVIEW_SUFFIX.length);
  return `${text.slice(0, retainedChars).trimEnd()}${TRUNCATED_PREVIEW_SUFFIX}`;
}

function resultPreview(result: unknown, maxChars = WORKFLOW_RESULT_PREVIEW_CHARS): unknown {
  if (result === undefined) {
    return undefined;
  }
  if (typeof result === "string") {
    return boundedTextPreview(result, maxChars);
  }
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    return boundedTextPreview(String(result), maxChars);
  }
  if (serialized.length > maxChars) {
    return boundedTextPreview(serialized, maxChars);
  }
  return JSON.parse(serialized) as unknown;
}

function displayResultPreview(result: unknown): string | undefined {
  const preview = resultPreview(result);
  if (preview === undefined) {
    return undefined;
  }
  return typeof preview === "string" ? preview : JSON.stringify(preview);
}

function activityPreview(
  activity: readonly string[],
  maxLines = WORKFLOW_ACTIVITY_PREVIEW_LINES,
  maxChars = WORKFLOW_ACTIVITY_PREVIEW_CHARS,
): string[] {
  return activity
    .slice(-maxLines)
    .map((line) => boundedTextPreview(line, maxChars));
}

interface WorkflowPhaseRecord {
  id: number;
  title: string | undefined;
  order: number;
  lastTouched: number;
  planned: boolean;
  reached: boolean;
  current: boolean;
  plannedMeta?: NonNullable<WorkflowToolDetails["plannedPhases"]>[number];
  statusCounts: WorkflowSubagentStatusCounts;
  subagentCount: number;
}

function collectWorkflowPhaseRecords(snapshot: WorkflowToolDetails): WorkflowPhaseRecord[] {
  const records = new Map<string | undefined, WorkflowPhaseRecord>();
  let nextOrder = 0;
  let touch = 0;
  const ensure = (title: string | undefined): WorkflowPhaseRecord => {
    let record = records.get(title);
    if (!record) {
      record = {
        id: ++nextOrder,
        title,
        order: nextOrder,
        lastTouched: ++touch,
        planned: false,
        reached: false,
        current: false,
        statusCounts: emptySubagentStatusCounts(),
        subagentCount: 0,
      };
      records.set(title, record);
    }
    return record;
  };

  for (const planned of snapshot.plannedPhases ?? []) {
    const record = ensure(planned.title);
    record.planned = true;
    record.plannedMeta ??= planned;
  }
  for (const title of snapshot.phases) {
    const record = ensure(title);
    record.reached = true;
    record.lastTouched = ++touch;
  }
  if (snapshot.currentPhase !== undefined) {
    const record = ensure(snapshot.currentPhase);
    record.current = true;
    record.lastTouched = ++touch;
  }
  for (const subagent of snapshot.subagents) {
    const record = ensure(subagent.phase);
    record.subagentCount++;
    record.statusCounts[subagent.status]++;
    record.lastTouched = Math.max(record.lastTouched, ++touch);
  }
  return [...records.values()];
}

function workflowPhasePriority(record: WorkflowPhaseRecord): number {
  if (record.current) return 0;
  if (record.statusCounts.error + record.statusCounts.aborted > 0) return 1;
  if (record.statusCounts.running > 0) return 2;
  if (record.statusCounts.queued > 0) return 3;
  if (record.reached) return 4;
  return 5;
}

function selectWorkflowPhases(records: readonly WorkflowPhaseRecord[], limit: number): WorkflowPhaseRecord[] {
  if (records.length <= limit) {
    return [...records];
  }
  return records
    .map((record) => ({ record, priority: workflowPhasePriority(record) }))
    .sort((left, right) =>
      left.priority - right.priority || right.record.lastTouched - left.record.lastTouched)
    .slice(0, limit)
    .map((item) => item.record)
    .sort((left, right) => left.order - right.order);
}

function selectWorkflowSubagents(
  subagents: readonly WorkflowSubagentSnapshot[],
  phaseRecords: readonly WorkflowPhaseRecord[],
  limit: number,
): WorkflowSubagentSnapshot[] {
  if (limit === 0 || phaseRecords.length === 0) {
    return [];
  }
  const selectedPhaseTitles = new Set(phaseRecords.map((record) => record.title));
  const candidates = subagents.filter((subagent) => selectedPhaseTitles.has(subagent.phase));
  const ranked = [...candidates].sort((left, right) =>
    subagentRenderPriority(left) - subagentRenderPriority(right) || right.index - left.index);
  const selected = new Set<number>();
  const phasesByPriority = [...phaseRecords].sort((left, right) =>
    workflowPhasePriority(left) - workflowPhasePriority(right) || right.lastTouched - left.lastTouched);

  for (const phase of phasesByPriority) {
    const candidate = ranked.find((subagent) => subagent.phase === phase.title && !selected.has(subagent.index));
    if (candidate) {
      selected.add(candidate.index);
      if (selected.size === limit) break;
    }
  }
  for (const candidate of ranked) {
    if (selected.size === limit) break;
    selected.add(candidate.index);
  }
  return candidates.filter((subagent) => selected.has(subagent.index)).sort((left, right) => left.index - right.index);
}

function cloneUsage(usage: SubagentUsage | undefined): SubagentUsage | undefined {
  return usage ? { ...usage, cost: { ...usage.cost } } : undefined;
}

function buildWorkflowDisplaySnapshot(
  snapshot: WorkflowToolDetails,
  telemetry: WorkflowToolDetails["telemetry"],
  limits: WorkflowDisplayLimits,
): WorkflowToolDetails {
  const phaseRecords = collectWorkflowPhaseRecords(snapshot);
  const selectedPhases = selectWorkflowPhases(phaseRecords, limits.phases);
  const selectedSubagents = selectWorkflowSubagents(snapshot.subagents, selectedPhases, limits.subagents);
  const selectedPhaseByTitle = new Map(selectedPhases.map((phase) => [phase.title, phase]));
  const displayTitleById = new Map(
    selectedPhases.map((phase) => [
      phase.id,
      phase.title === undefined ? undefined : boundedTextPreview(phase.title, limits.phaseChars),
    ]),
  );
  const phaseSummaries: WorkflowPhaseSnapshot[] = selectedPhases.map((phase) => ({
    id: phase.id,
    title: displayTitleById.get(phase.id),
    planned: phase.planned,
    reached: phase.reached,
    current: phase.current,
    subagentCount: phase.subagentCount,
    statusCounts: { ...phase.statusCounts },
  }));
  const subagents = selectedSubagents.map((subagent): WorkflowSubagentSnapshot => {
    const phase = selectedPhaseByTitle.get(subagent.phase);
    return {
      index: subagent.index,
      label: boundedTextPreview(subagent.label, limits.metadataChars),
      phase: phase ? displayTitleById.get(phase.id) : undefined,
      phaseId: phase?.id,
      profile: boundedTextPreview(subagent.profile, limits.metadataChars),
      backend: subagent.backend,
      sessionKey: limits.includeSessionKeys && subagent.sessionKey !== undefined
        ? boundedTextPreview(subagent.sessionKey, limits.metadataChars)
        : undefined,
      status: subagent.status,
      startedAt: subagent.startedAt,
      endedAt: subagent.endedAt,
      activity: subagent.activity
        ? activityPreview(subagent.activity, limits.activityLines, limits.activityChars)
        : undefined,
      activityCount: subagent.activityCount,
      result: subagent.result === undefined
        ? undefined
        : boundedTextPreview(subagent.result, limits.resultChars),
      error: subagent.error === undefined
        ? undefined
        : boundedTextPreview(subagent.error, limits.errorChars),
      usage: cloneUsage(subagent.usage),
      telemetry: subagent.telemetry ? { ...subagent.telemetry } : undefined,
    };
  });
  const currentPhaseRecord = selectedPhases.find((phase) => phase.current);
  return {
    name: boundedTextPreview(snapshot.name, limits.metadataChars),
    status: snapshot.status,
    subagentCount: Math.max(snapshot.subagentCount, snapshot.subagents.length),
    subagentStatusCounts: countSubagentStatuses(snapshot.subagents),
    phaseCount: phaseRecords.filter((phase) => phase.title !== undefined).length,
    phases: selectedPhases
      .filter((phase) => phase.reached && phase.title !== undefined)
      .map((phase) => displayTitleById.get(phase.id) as string),
    phaseSummaries,
    plannedPhases: selectedPhases
      .filter((phase) => phase.planned && phase.title !== undefined)
      .map((phase) => ({
        title: displayTitleById.get(phase.id) as string,
        detail: phase.plannedMeta?.detail === undefined
          ? undefined
          : boundedTextPreview(phase.plannedMeta.detail, limits.metadataChars),
        model: phase.plannedMeta?.model === undefined
          ? undefined
          : boundedTextPreview(phase.plannedMeta.model, limits.metadataChars),
      })),
    currentPhase: currentPhaseRecord ? displayTitleById.get(currentPhaseRecord.id) : undefined,
    subagents,
    logCount: snapshot.logs.length,
    logs: snapshot.logs
      .slice(-limits.logs)
      .map((line) => boundedTextPreview(line, limits.logChars)),
    result: resultPreview(snapshot.result, limits.resultChars),
    error: snapshot.error === undefined
      ? undefined
      : boundedTextPreview(snapshot.error, limits.errorChars),
    telemetry: telemetry ? { ...telemetry } : undefined,
    frame: snapshot.frame,
  };
}

function summaryOnlyWorkflowSnapshot(snapshot: WorkflowToolDetails): WorkflowToolDetails {
  return {
    name: boundedTextPreview(snapshot.name, 64),
    status: snapshot.status,
    subagentCount: snapshot.subagentCount,
    subagentStatusCounts: { ...snapshot.subagentStatusCounts },
    phaseCount: snapshot.phaseCount,
    phases: [],
    phaseSummaries: [],
    plannedPhases: [],
    subagents: [],
    logCount: snapshot.logCount,
    logs: [],
    result: resultPreview(snapshot.result, 128),
    error: snapshot.error === undefined ? undefined : boundedTextPreview(snapshot.error, 128),
    telemetry: snapshot.telemetry ? { ...snapshot.telemetry } : undefined,
    frame: snapshot.frame,
  };
}

function boundedWorkflowSnapshot(
  snapshot: WorkflowToolDetails,
  telemetry: WorkflowToolDetails["telemetry"],
): WorkflowToolDetails {
  for (const limits of [WORKFLOW_DISPLAY_LIMITS, COMPACT_WORKFLOW_DISPLAY_LIMITS]) {
    const candidate = buildWorkflowDisplaySnapshot(snapshot, telemetry, limits);
    if (JSON.stringify(candidate).length <= MAX_WORKFLOW_DETAILS_JSON_CHARS) {
      return candidate;
    }
  }
  const compact = buildWorkflowDisplaySnapshot(snapshot, telemetry, {
    ...COMPACT_WORKFLOW_DISPLAY_LIMITS,
    subagents: 4,
    phases: 4,
    logs: 1,
    metadataChars: 64,
    phaseChars: 64,
    logChars: 128,
    resultChars: 128,
    errorChars: 128,
    activityLines: 0,
  });
  if (JSON.stringify(compact).length <= MAX_WORKFLOW_DETAILS_JSON_CHARS) {
    return compact;
  }
  return summaryOnlyWorkflowSnapshot(compact);
}

function cloneWorkflowSnapshot(snapshot: WorkflowToolDetails): WorkflowToolDetails {
  return {
    ...snapshot,
    subagentStatusCounts: { ...snapshot.subagentStatusCounts },
    phases: [...snapshot.phases],
    phaseSummaries: snapshot.phaseSummaries.map((phase) => ({
      ...phase,
      statusCounts: { ...phase.statusCounts },
    })),
    plannedPhases: snapshot.plannedPhases?.map((phase) => ({ ...phase })),
    subagents: snapshot.subagents.map((subagent) => ({
      ...subagent,
      activity: subagent.activity ? [...subagent.activity] : undefined,
      usage: cloneUsage(subagent.usage),
      telemetry: subagent.telemetry ? { ...subagent.telemetry } : undefined,
    })),
    logs: [...snapshot.logs],
    result: resultPreview(snapshot.result),
    telemetry: snapshot.telemetry ? { ...snapshot.telemetry } : undefined,
  };
}

function workflowSnapshotResult(
  text: string,
  details: WorkflowToolDetails,
  usage?: SubagentUsage,
  boundedUpdate = false,
) {
  const makeResult = (snapshot: WorkflowToolDetails) => ({
    content: [{ type: "text" as const, text }],
    details: snapshot,
    ...(usage ? { usage: cloneUsage(usage) } : {}),
  });
  const result = makeResult(details);
  if (!boundedUpdate || JSON.stringify(result).length <= MAX_WORKFLOW_UPDATE_JSON_CHARS) {
    return result;
  }
  return makeResult(summaryOnlyWorkflowSnapshot(details));
}

function workflowExecutionSnapshot(snapshot: WorkflowToolDetails, terminalContent: string): WorkflowExecutionResult {
  const aggregate = aggregateWorkflowUsage(snapshot.subagents);
  return {
    details: boundedWorkflowSnapshot(snapshot, aggregate.telemetry),
    terminalContent,
    usage: aggregate.usage,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal, fallback: unknown): string {
  return signal.reason === undefined ? errorMessage(fallback) : errorMessage(signal.reason);
}

function workflowErrorDetails(name: string, error: unknown, aborted = false): WorkflowExecutionResult {
  const message = errorMessage(error);
  return workflowExecutionSnapshot({
    name,
    status: aborted ? "aborted" : "error",
    subagentCount: 0,
    subagentStatusCounts: emptySubagentStatusCounts(),
    phaseCount: 0,
    phases: [],
    phaseSummaries: [],
    subagents: [],
    logCount: 0,
    logs: [],
    error: message,
  }, message);
}

function ensureSubagent(
  snapshot: WorkflowToolDetails,
  profiles: ReturnType<typeof getSubagentProfiles>,
  event: { index: number; label: string; phase?: string; profile: string; sessionKey?: string },
): WorkflowSubagentSnapshot {
  let subagent = snapshot.subagents.find((candidate) => candidate.index === event.index);
  if (!subagent) {
    subagent = {
      index: event.index,
      label: event.label,
      phase: event.phase,
      profile: event.profile,
      backend: profiles.get(event.profile)?.backend,
      sessionKey: event.sessionKey,
      status: "queued",
      startedAt: Date.now(),
      activity: [],
      activityCount: 0,
    };
    snapshot.subagents.push(subagent);
  }
  snapshot.subagentCount = Math.max(snapshot.subagentCount, snapshot.subagents.length, event.index);
  return subagent;
}

async function executeWorkflowCall(params: {
  options: CreateRunWorkflowToolOptions;
  name: string;
  toolParams: WorkflowToolParams;
  signal: AbortSignal;
  onUpdate: ((result: ReturnType<typeof workflowSnapshotResult>) => void) | undefined;
  ctx: ExtensionContext;
}): Promise<WorkflowExecutionResult> {
  const { options, name, toolParams, signal, onUpdate, ctx } = params;
  const snapshot: WorkflowToolDetails = {
    name,
    status: "running",
    subagentCount: 0,
    subagentStatusCounts: emptySubagentStatusCounts(),
    phaseCount: 0,
    phases: [],
    phaseSummaries: [],
    subagents: [],
    logCount: 0,
    logs: [],
  };
  const emit = () => {
    if (!onUpdate) return;
    const aggregate = aggregateWorkflowUsage(snapshot.subagents);
    const details = boundedWorkflowSnapshot(snapshot, aggregate.telemetry);
    const displayName = boundedTextPreview(name, WORKFLOW_METADATA_PREVIEW_CHARS);
    onUpdate(workflowSnapshotResult(`Workflow "${displayName}" running.`, details, aggregate.usage, true));
  };

  signal.throwIfAborted();
  const prepared = prepareWorkflowToolSource(toolParams, ctx);
  if (!prepared.ok) {
    return workflowErrorDetails(name, prepared.details.error);
  }

  const { script, meta } = prepared.value;
  snapshot.plannedPhases = meta.phases?.map((phase) => ({ ...phase }));
  const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
  const runner = createWorkflowSubagentRunner({
    profiles,
    ctx,
    thinkingLevel: options.getThinkingLevel(),
    timeoutMs: options.getSubagentTimeoutMs(),
    onUsage: (index, usage, telemetry) => {
      const subagent = snapshot.subagents.find((candidate) => candidate.index === index);
      if (!subagent) {
        return;
      }
      subagent.usage = usage;
      subagent.telemetry = telemetry;
      emit();
    },
    onProgress: (index, details, usage) => {
      const subagent = snapshot.subagents.find((candidate) => candidate.index === index);
      if (!subagent) {
        return;
      }
      const progress = details.progress;
      subagent.status = details.status;
      subagent.result = displayResultPreview(details.result);
      subagent.error = details.error;
      subagent.usage = usage ?? subagent.usage;
      subagent.telemetry = details.telemetry ?? progress?.telemetry ?? subagent.telemetry;
      if (progress) {
        subagent.startedAt = progress.startedAt;
        subagent.endedAt = progress.endedAt;
        subagent.activity = activityPreview(progress.activity);
        subagent.activityCount = progress.activityCount;
      }
      emit();
    },
  });

  const heartbeat = ctx.mode === "tui" && onUpdate
    ? setInterval(() => {
        if (snapshot.status === "running" && snapshot.subagents.some((subagent) => isActiveSubagentStatus(subagent.status))) {
          snapshot.frame = (snapshot.frame ?? 0) + 1;
          emit();
        }
      }, SPINNER_INTERVAL_MS)
    : undefined;
  heartbeat?.unref?.();

  try {
    const result = await runWorkflow(script, {
      args: toolParams.args,
      cwd: ctx.cwd,
      signal,
      limiter: options.getLimiter(),
      parsedWorkflow: prepared.value,
      serializeSubagent: runner.serializeSubagent,
      runSubagent: runner.runSubagent,
      onLog: (message) => {
        snapshot.logs.push(message);
        emit();
      },
      onPhase: (title) => {
        if (!snapshot.phases.includes(title)) {
          snapshot.phases.push(title);
        }
        snapshot.currentPhase = title;
        emit();
      },
      onSubagentQueued: (event) => {
        ensureSubagent(snapshot, profiles, event);
        emit();
      },
      onSubagentStart: (event) => {
        const subagent = ensureSubagent(snapshot, profiles, event);
        subagent.sessionKey = event.sessionKey ?? subagent.sessionKey;
        subagent.status = "running";
        subagent.startedAt = Date.now();
        emit();
      },
      onSubagentEnd: (event) => {
        const subagent = snapshot.subagents.find((candidate) => candidate.index === event.index);
        if (!subagent) {
          return;
        }
        const aborted = event.failed && (signal.aborted || subagent.status === "aborted");
        subagent.status = event.failed ? (aborted ? "aborted" : "error") : "done";
        subagent.endedAt = Date.now();
        subagent.result = displayResultPreview(event.result);
        if (aborted && signal.aborted) {
          subagent.error = abortReason(signal, "workflow aborted");
        } else if (event.failed && !subagent.error) {
          subagent.error = aborted ? "subagent aborted" : "subagent failed";
        }
        emit();
      },
    });

    snapshot.status = "completed";
    snapshot.subagentCount = result.subagentCount;
    snapshot.result = resultPreview(result.result);
    return workflowExecutionSnapshot(snapshot, workflowContent(result.result));
  } catch (error) {
    const aborted = signal.aborted || isWorkflowAbortError(error);
    const message = signal.aborted ? abortReason(signal, error) : errorMessage(error);
    snapshot.status = aborted ? "aborted" : "error";
    snapshot.error = message;
    for (const subagent of snapshot.subagents) {
      if (isActiveSubagentStatus(subagent.status)) {
        subagent.status = aborted ? "aborted" : "error";
        subagent.error = message;
        subagent.endedAt = Date.now();
      }
    }
    return workflowExecutionSnapshot(snapshot, message);
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
  }
}

export function createRunWorkflowTool(
  options: CreateRunWorkflowToolOptions,
): ToolDefinition<typeof workflowToolParameters, WorkflowToolDetails> {
  return defineTool({
    name: "run_workflow",
    label: "Run Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
    parameters: workflowToolParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const name = requiredWorkflowName(params);
      const normalizedParams = { ...params, name };
      const managed = await options.getTaskManager().run({
        signal,
        execute: async (taskSignal) => {
          let value: WorkflowExecutionResult;
          try {
            value = await executeWorkflowCall({
              options,
              name,
              toolParams: normalizedParams,
              signal: taskSignal,
              onUpdate,
              ctx,
            });
          } catch (error) {
            value = workflowErrorDetails(
              name,
              taskSignal.aborted ? abortReason(taskSignal, error) : error,
              taskSignal.aborted,
            );
          }
          return {
            status: value.details.status === "completed" ? "completed" : "failed",
            value,
          };
        },
      });

      let execution = managed.value;
      if (managed.status === "failed" && execution.details.status === "completed") {
        const reason = managed.abortReason ?? "Workflow aborted";
        const details = cloneWorkflowSnapshot(execution.details);
        details.status = "aborted";
        details.error = reason;
        for (const subagent of details.subagents) {
          if (isActiveSubagentStatus(subagent.status)) {
            subagent.status = "aborted";
            subagent.error = reason;
            subagent.endedAt = Date.now();
          }
        }
        execution = { details, terminalContent: reason, usage: execution.usage };
      }
      const envelope: WorkflowTerminalTaskEnvelope = {
        task_type: "workflow",
        status: managed.status,
        name: boundedTextPreview(name, WORKFLOW_METADATA_PREVIEW_CHARS),
        content: boundedTextPreview(execution.terminalContent, MAX_MODEL_VISIBLE_TEXT_CHARS),
      };
      const result = workflowSnapshotResult(
        JSON.stringify(envelope),
        execution.details,
        execution.usage,
      );
      return {
        ...result,
        content: taskEnvelopeContent(envelope),
      };
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
      return new Text(`${theme.bold("Workflow")}${theme.fg("muted", `(${name})`)}`, 0, 0);
    },
    renderResult(result, _renderOptions, theme) {
      const details = result.details as WorkflowToolDetails;
      return renderWorkflowSnapshot(details, theme, details.frame ?? 0);
    },
  });
}

function requiredWorkflowName(params: WorkflowToolParams): string {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) {
    throw new Error("Workflow name must contain non-whitespace characters");
  }
  return name;
}

function workflowContent(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result) ?? "null";
}

function subagentRenderPriority(subagent: WorkflowSubagentSnapshot): number {
  if (subagent.status === "error" || subagent.status === "aborted") return 0;
  if (subagent.status === "running") return 1;
  if (subagent.status === "queued") return 2;
  return 3;
}

function selectSubagentsForRender(subagents: WorkflowSubagentSnapshot[], max = 6): WorkflowSubagentSnapshot[] {
  return subagents
    .map((subagent, index) => ({ subagent, index }))
    .sort((left, right) =>
      subagentRenderPriority(left.subagent) - subagentRenderPriority(right.subagent) || left.index - right.index)
    .slice(0, max)
    .sort((left, right) => left.index - right.index)
    .map((item) => item.subagent);
}

function orderedPhases(details: WorkflowToolDetails): (string | undefined)[] {
  const seen = new Set<string>();
  const order: (string | undefined)[] = [];
  for (const planned of details.plannedPhases ?? []) {
    if (!seen.has(planned.title)) {
      seen.add(planned.title);
      order.push(planned.title);
    }
  }
  for (const phase of details.phases) {
    if (!seen.has(phase)) {
      seen.add(phase);
      order.push(phase);
    }
  }
  for (const subagent of details.subagents) {
    if (subagent.phase && !seen.has(subagent.phase)) {
      seen.add(subagent.phase);
      order.push(subagent.phase);
    }
  }
  if (details.subagents.some((subagent) => !subagent.phase)) {
    order.push(undefined);
  }
  return order;
}

function workflowRunningCount(details: WorkflowToolDetails): number {
  return details.subagentStatusCounts?.running
    ?? details.subagents.filter((subagent) => subagent.status === "running").length;
}

function phaseSummariesForRender(details: WorkflowToolDetails): WorkflowPhaseSnapshot[] {
  if (details.phaseSummaries?.length) {
    return details.phaseSummaries;
  }
  return orderedPhases(details).map((title, index) => {
    const subagents = details.subagents.filter((subagent) => subagent.phase === title);
    return {
      id: index + 1,
      title,
      planned: title !== undefined && Boolean(details.plannedPhases?.some((phase) => phase.title === title)),
      reached: title === undefined || (title !== undefined && details.phases.includes(title)),
      current: title !== undefined && details.currentPhase === title,
      subagentCount: subagents.length,
      statusCounts: countSubagentStatuses(subagents),
    };
  });
}

function subagentsForPhase(
  details: WorkflowToolDetails,
  phase: WorkflowPhaseSnapshot,
): WorkflowSubagentSnapshot[] {
  return details.subagents.filter((subagent) =>
    subagent.phaseId !== undefined ? subagent.phaseId === phase.id : subagent.phase === phase.title);
}

type WorkflowPhaseRenderStatus = "planned" | "running" | "done" | "partial" | "failed";

function phaseRenderMarker(status: WorkflowPhaseRenderStatus): string {
  if (status === "failed") return "✗";
  if (status === "partial") return "⚠";
  if (status === "done") return "✓";
  if (status === "running") return "▶";
  return "·";
}

function phaseRenderColor(status: WorkflowPhaseRenderStatus, failedSubagentCount: number): ThemeColor {
  if (status === "failed") return "error";
  if (status === "partial" || failedSubagentCount > 0) return "warning";
  return "muted";
}

function phaseRenderStatus(details: WorkflowToolDetails, phase: WorkflowPhaseSnapshot): WorkflowPhaseRenderStatus {
  const failed = phase.statusCounts.error + phase.statusCounts.aborted;
  const workflowRunning = details.status === "running";
  const workflowFailed = details.status === "error" || details.status === "aborted";
  if (
    (workflowFailed && phase.current && phase.subagentCount === 0) ||
    (phase.subagentCount > 0 && failed === phase.subagentCount)
  ) {
    return "failed";
  }
  if (
    phase.statusCounts.running > 0 ||
    phase.statusCounts.queued > 0 ||
    (workflowRunning && phase.current)
  ) {
    return "running";
  }
  if (failed > 0) return "partial";
  if (phase.subagentCount > 0 || phase.reached) return "done";
  return "planned";
}

function renderPhaseTree(container: Container, details: WorkflowToolDetails, theme: Theme, frame: number): void {
  const runningCount = workflowRunningCount(details);
  const summaries = phaseSummariesForRender(details);
  for (const phase of summaries) {
    const phaseStatus = phaseRenderStatus(details, phase);
    // Planned phases are a running-only roadmap; unreached declarations vanish once the workflow ends.
    if (phaseStatus === "planned" && details.status !== "running") {
      continue;
    }
    const subagents = subagentsForPhase(details, phase);
    const failed = phase.statusCounts.error + phase.statusCounts.aborted;
    const header = `${phaseRenderMarker(phaseStatus)} ${phase.title ?? "unphased"} ${phaseStatus} · ${phase.statusCounts.done}/${phase.subagentCount}`;
    container.addChild(new Text(`  ${theme.fg(phaseRenderColor(phaseStatus, failed), header)}`, 0, 0));
    const shown = selectSubagentsForRender(subagents);
    for (const subagent of shown) {
      container.addChild(renderSubagentNode(subagent, theme, frame, runningCount, "    "));
    }
    const hidden = Math.max(0, phase.subagentCount - shown.length);
    if (hidden > 0) {
      container.addChild(new Text(`    ${theme.fg("muted", `... ${hidden} more`)}`, 0, 0));
    }
  }
  const displayedPhaseCount = summaries.filter((phase) => phase.title !== undefined).length;
  const hiddenPhaseCount = Math.max(0, (details.phaseCount ?? displayedPhaseCount) - displayedPhaseCount);
  if (hiddenPhaseCount > 0) {
    container.addChild(new Text(`  ${theme.fg("muted", `... ${hiddenPhaseCount} more phase(s)`)}`, 0, 0));
  }
}

function renderFlatSubagents(container: Container, details: WorkflowToolDetails, theme: Theme, frame: number): void {
  const runningCount = workflowRunningCount(details);
  const shown = selectSubagentsForRender(details.subagents);
  for (const subagent of shown) {
    container.addChild(renderSubagentNode(subagent, theme, frame, runningCount, "  "));
  }
  const hidden = Math.max(0, details.subagentCount - shown.length);
  if (hidden > 0) {
    container.addChild(new Text(`  ${theme.fg("muted", `... ${hidden} subagent(s) not shown`)}`, 0, 0));
  }
}

function renderWorkflowSnapshot(details: WorkflowToolDetails, theme: Theme, frame: number): Container {
  const container = new Container();
  const done = details.subagentStatusCounts?.done
    ?? details.subagents.filter((subagent) => isCompletedSubagentStatus(subagent.status)).length;
  const subagentCount = details.subagentCount ?? details.subagents.length;
  container.addChild(
    new Text(
      `${theme.bold(`Workflow(${details.name})`)} ${theme.fg("dim", `${details.status} · ${done}/${subagentCount}`)}`,
      0,
      0,
    ),
  );

  const phaseCount = details.phaseCount ?? orderedPhases(details).filter((phase) => phase !== undefined).length;
  if (phaseCount > 0) {
    renderPhaseTree(container, details, theme, frame);
  } else {
    renderFlatSubagents(container, details, theme, frame);
  }

  const hiddenLogCount = Math.max(0, (details.logCount ?? details.logs.length) - details.logs.length);
  if (hiddenLogCount > 0) {
    container.addChild(new Text(`  ${theme.fg("muted", `... ${hiddenLogCount} earlier log(s) not shown`)}`, 0, 0));
  }
  for (const line of details.logs.slice(-WORKFLOW_DISPLAY_LOG_LIMIT)) {
    container.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
  }
  if (details.error) {
    container.addChild(new Text(`  ${theme.fg("error", details.error)}`, 0, 0));
  }
  return container;
}
