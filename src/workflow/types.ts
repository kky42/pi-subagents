import type { ConcurrencyLimiter } from "../core/concurrency.ts";

export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: WorkflowMetaPhase[];
}

export interface WorkflowSubagentCall {
  index?: number;
  prompt: string;
  label: string;
  phase?: string;
  profile: string;
  backend?: string;
  /** Caller-chosen key for a resumable child conversation. */
  sessionKey?: string;
  /** Backend-native session/thread id captured for workflow replay bookkeeping. */
  sessionId?: string;
  /** Portable strict JSON Schema for structured output from the child subagent. */
  schema?: unknown;
}

export interface WorkflowCachedSubagentResult {
  index: number;
  fingerprint: string;
  result: unknown;
  failed?: boolean;
  error?: string;
  sessionKey?: string;
  sessionId?: string;
  profile?: string;
  backend?: string;
}

export interface WorkflowSubagentResultEvent extends WorkflowCachedSubagentResult {
  label: string;
  phase?: string;
  profile: string;
  prompt: string;
  schema?: unknown;
  cached: boolean;
}

/**
 * Runs one subagent and resolves with its final text. The run_workflow tool
 * supplies the real implementation (profile resolution + spawnSubagent); tests
 * inject a fake. Throwing is treated as a per-subagent failure (the branch becomes
 * null and is logged) unless the workflow signal aborted.
 */
export type WorkflowSubagentRunner = (
  call: WorkflowSubagentCall,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

export interface WorkflowLimits {
  /** Hard cap on run_agent() calls per workflow run, including cached calls. */
  maxSubagentCalls: number;
  /** Retained workflow log lines. Further logs are summarized/truncated. */
  maxLogs: number;
  /** Maximum retained characters per workflow log line. */
  maxLogLength: number;
  /** Heartbeat sent by the isolated script worker. */
  workerHeartbeatIntervalMs: number;
  /** Kill the isolated script worker only after this much heartbeat silence. */
  workerStallTimeoutMs: number;
  /** Kill a responsive script that makes no workflow progress and has no active subagent calls. */
  workerIdleTimeoutMs: number;
  /** Initial synchronous vm execution timeout before the script's first await. */
  syncExecutionTimeoutMs: number;
  /** Old-generation V8 heap cap for the workflow script worker. */
  workerMaxOldGenerationSizeMb: number;
  /** Young-generation V8 heap cap for the workflow script worker. */
  workerMaxYoungGenerationSizeMb: number;
  /** Worker stack cap. */
  workerStackSizeMb: number;
  /** Cooperative abort grace period before terminating an unresponsive worker. */
  abortGraceMs: number;
}

export interface RunWorkflowOptions {
  args?: unknown;
  cwd: string;
  signal?: AbortSignal;
  /** Shared global concurrency cap; run_agent() queues on this. */
  limiter: ConcurrencyLimiter;
  /** Optional per-call serializer, used to keep equal session_key calls from consuming global slots while waiting. */
  serializeSubagent?: <T>(sessionKey: string | undefined, task: () => Promise<T>) => Promise<T>;
  runSubagent: WorkflowSubagentRunner;
  defaultProfile?: string;
  limits?: Partial<WorkflowLimits>;
  onLog?: (message: string) => void;
  onPhase?: (title: string) => void;
  resumeSubagentResults?: WorkflowCachedSubagentResult[];
  onSubagentQueued?: (event: { index: number; label: string; phase?: string; profile: string; sessionKey?: string; prompt: string }) => void;
  onSubagentStart?: (event: { index: number; label: string; phase?: string; profile: string; sessionKey?: string; prompt: string; cached?: boolean }) => void;
  onSubagentEnd?: (event: { index: number; label: string; phase?: string; result: unknown; cached?: boolean; failed?: boolean }) => void;
  onSubagentResult?: (event: WorkflowSubagentResultEvent) => void | Promise<void>;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  subagentCount: number;
}
