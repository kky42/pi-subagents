import type { Usage } from "@earendil-works/pi-ai";
import type { WorkflowMetaPhase } from "./workflow/types.ts";

export type SubagentProfileName = string;
export type SubagentBackend = "pi" | "codex" | "claude";
export type ThinkingLevel = string;

export interface SubagentProfile {
  name: string;
  description: string;
  backend: SubagentBackend;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  systemPrompt?: string;
}

export interface SubagentExtensionOptions {
  /**
   * Maximum number of subagents allowed to run concurrently across the whole
   * root run (a global in-flight cap, not a per-level fan-out width). A slot is
   * taken when a subagent launches and released when it completes, fails, or is
   * aborted. The cap is shared by the `run_agent` and `run_workflow` tools.
   */
  maxConcurrentSubagents?: number;
  /**
   * Maximum wall-clock runtime for each launched subagent, in milliseconds.
   * Defaults to a generous global guardrail. Set to 0 to disable. The limit is
   * shared by direct `run_agent` calls and workflow `run_agent()` calls, and can also
   * be overridden with `--subagent-timeout-ms`.
   */
  subagentTimeoutMs?: number;
  /**
   * Register the `run_workflow` tool alongside `run_agent`. Defaults to true:
   * one product, two entry points. Set to false for a subagents-only surface.
   */
  workflow?: boolean;
}

export type FlowExtensionOptions = SubagentExtensionOptions;

export type SubagentRunStatus = "queued" | "running" | "done" | "error" | "aborted";

export interface WorkflowSubagentStatusCounts {
  queued: number;
  running: number;
  done: number;
  error: number;
  aborted: number;
}

export interface WorkflowPhaseSnapshot {
  id: number;
  title?: string;
  planned: boolean;
  reached: boolean;
  current: boolean;
  subagentCount: number;
  statusCounts: WorkflowSubagentStatusCounts;
}

export interface WorkflowSubagentSnapshot {
  index: number;
  label: string;
  phase?: string;
  phaseId?: number;
  profile: string;
  backend?: SubagentBackend;
  sessionKey?: string;
  status: SubagentRunStatus;
  startedAt?: number;
  endedAt?: number;
  activity?: string[];
  activityCount?: number;
  result?: string;
  error?: string;
  usage?: SubagentUsage;
  telemetry?: SubagentTelemetry;
}

export interface WorkflowToolDetails {
  name: string;
  status: "running" | "completed" | "error" | "aborted";
  subagentCount: number;
  subagentStatusCounts: WorkflowSubagentStatusCounts;
  phaseCount: number;
  phases: string[];
  phaseSummaries: WorkflowPhaseSnapshot[];
  plannedPhases?: WorkflowMetaPhase[];
  currentPhase?: string;
  subagents: WorkflowSubagentSnapshot[];
  logCount: number;
  logs: string[];
  result?: unknown;
  error?: string;
  telemetry?: SubagentTelemetry & { missingUsageSubagentCount?: number };
  frame?: number;
}

export type SubagentUsage = Usage;

/** Data-quality metadata that Pi's standard Usage type cannot represent. */
export interface SubagentTelemetry {
  tokensKnown: boolean;
  costKnown: boolean;
  costBreakdownKnown: boolean;
  costEstimated?: boolean;
  partial?: boolean;
}

export interface SubagentProgressNode {
  label: string;
  profile: SubagentProfileName | "unknown";
  backend?: SubagentBackend;
  status: SubagentRunStatus;
  startedAt: number;
  endedAt?: number;
  activity: string[];
  activityCount: number;
  result?: string;
  error?: string;
  telemetry?: SubagentTelemetry;
}

export interface SubagentToolDetails {
  label: string;
  profile: SubagentProfileName | "unknown";
  backend?: SubagentBackend;
  status: SubagentRunStatus;
  result?: string;
  error?: string;
  telemetry?: SubagentTelemetry;
  /** Backend-native session/thread id used internally for session_key continuation. */
  sessionId?: string;
  /** Optional live-render snapshot; root fields remain canonical when progress updates are unavailable. */
  progress?: SubagentProgressNode;
  activeCount?: number;
  frame?: number;
}
