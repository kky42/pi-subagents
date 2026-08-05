import { assertPortableOutputSchema } from "./output-schema.ts";
import { parseWorkflowScript } from "./script-validation.ts";
import { fingerprintWorkflowSubagentCall } from "./replay-cache.ts";
import { createWorkflowScriptWorker, type ParentToWorkerMessage, type WorkerToParentMessage } from "./script-worker.ts";
import {
  defaultSubagentLabel,
  normalizeSubagentOptions,
  normalizeJsonSerializable,
  requireString,
  truncateLogLine,
} from "./runtime-values.ts";
import type {
  RunWorkflowOptions,
  WorkflowSubagentResultEvent,
  WorkflowLimits,
  WorkflowRunResult,
} from "./types.ts";

export type {
  RunWorkflowOptions,
  WorkflowSubagentCall,
  WorkflowSubagentResultEvent,
  WorkflowSubagentRunner,
  WorkflowCachedSubagentResult,
  WorkflowLimits,
  WorkflowMeta,
  WorkflowMetaPhase,
  WorkflowRunResult,
} from "./types.ts";
export { parseWorkflowScript } from "./script-validation.ts";
export { fingerprintWorkflowSubagentCall, hashStableValue } from "./replay-cache.ts";

interface RuntimeState {
  currentPhase?: string;
  logs: string[];
  phases: string[];
  subagentCount: number;
  resumePrefixActive: boolean;
}

const DEFAULT_PROFILE = "general-purpose";

const DEFAULT_WORKFLOW_LIMITS: WorkflowLimits = {
  maxSubagentCalls: 1_000,
  maxLogs: 500,
  maxLogLength: 4_000,
  workerHeartbeatIntervalMs: 250,
  workerStallTimeoutMs: 60_000,
  workerIdleTimeoutMs: 300_000,
  syncExecutionTimeoutMs: 5_000,
  workerMaxOldGenerationSizeMb: 512,
  workerMaxYoungGenerationSizeMb: 32,
  workerStackSizeMb: 4,
  abortGraceMs: 1_000,
};

class WorkflowFatalError extends Error {
  readonly workflowFatal = true;
}

export class WorkflowAbortError extends WorkflowFatalError {
  readonly workflowAbort = true;
}

function isWorkflowFatalError(error: unknown): error is WorkflowFatalError {
  return error instanceof WorkflowFatalError;
}

export function isWorkflowAbortError(error: unknown): error is WorkflowAbortError {
  return error instanceof WorkflowAbortError;
}

export async function runWorkflow<T = unknown>(
  script: string,
  options: RunWorkflowOptions,
): Promise<WorkflowRunResult<T>> {
  const { meta, body } = parseWorkflowScript(script);
  const limits = normalizeWorkflowLimits(options.limits);
  const state: RuntimeState = {
    logs: [],
    phases: [],
    subagentCount: 0,
    resumePrefixActive: Boolean(options.resumeSubagentResults?.length),
  };
  const resumeSubagentResults = options.resumeSubagentResults ?? [];
  const limiter = options.limiter;
  const defaultProfile = options.defaultProfile ?? DEFAULT_PROFILE;
  const runtimeAbortController = new AbortController();
  const compositeSignal = AbortSignal.any(
    [options.signal, runtimeAbortController.signal].filter((signal): signal is AbortSignal => Boolean(signal)),
  );
  let abortReason = "workflow aborted";
  let fatalError: Error | undefined;

  const rememberFatal = (error: Error) => {
    if (!fatalError) {
      fatalError = error;
    }
    abortReason = error.message || abortReason;
  };

  const abortRuntime = (error: Error) => {
    rememberFatal(error);
    if (!runtimeAbortController.signal.aborted) {
      runtimeAbortController.abort();
    }
  };

  const throwIfAborted = () => {
    if (options.signal?.aborted || runtimeAbortController.signal.aborted) {
      throw fatalError ?? new WorkflowFatalError(abortReason);
    }
  };

  const log = (message: unknown) => {
    const text = truncateLogLine(String(message), limits.maxLogLength);
    if (state.logs.length < limits.maxLogs) {
      state.logs.push(text);
      options.onLog?.(text);
      return;
    }
    if (state.logs.length === limits.maxLogs) {
      const truncated = `workflow logs truncated after ${limits.maxLogs} entries`;
      state.logs.push(truncated);
      options.onLog?.(truncated);
    }
  };

  const phase = (title: unknown) => {
    const text = requireString(title, "phase title");
    state.currentPhase = text;
    if (!state.phases.includes(text)) {
      state.phases.push(text);
    }
    options.onPhase?.(text);
  };

  const recordSubagentResult = async (event: WorkflowSubagentResultEvent) => {
    try {
      await options.onSubagentResult?.(event);
    } catch (error) {
      log(`workflow subagent-result hook failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runSubagentCall = async (prompt: unknown, subagentOptions: unknown = {}) => {
    throwIfAborted();
    if (state.subagentCount >= limits.maxSubagentCalls) {
      const error = new WorkflowFatalError(`maximum workflow run_agent calls exceeded (${limits.maxSubagentCalls})`);
      abortRuntime(error);
      throw error;
    }
    const taskPrompt = requireString(prompt, "run_agent prompt");
    const opts = normalizeSubagentOptions(subagentOptions);
    if (opts.schema != null) {
      try {
        assertPortableOutputSchema(opts.schema);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const fatal = new WorkflowFatalError(`Workflow schema validation failed before launching subagent: ${detail}`);
        abortRuntime(fatal);
        throw fatal;
      }
    }
    const assignedPhase = opts.phase ?? state.currentPhase;
    const profile = opts.profile ?? defaultProfile;

    const index = ++state.subagentCount;
    const label = opts.label || defaultSubagentLabel(assignedPhase, index);
    const call = {
      index,
      prompt: taskPrompt,
      label,
      phase: assignedPhase,
      profile,
      backend: undefined as string | undefined,
      sessionKey: opts.sessionKey,
      sessionId: undefined as string | undefined,
      schema: opts.schema,
    };
    const fingerprint = fingerprintWorkflowSubagentCall(call);
    options.onSubagentQueued?.({ index, label, phase: assignedPhase, profile, sessionKey: opts.sessionKey, prompt: taskPrompt });
    const cachedResult = state.resumePrefixActive ? resumeSubagentResults[index - 1] : undefined;
    if (cachedResult?.index === index && cachedResult.fingerprint === fingerprint && !cachedResult.failed) {
      call.sessionId = cachedResult.sessionId;
      call.backend = cachedResult.backend;
      options.onSubagentStart?.({ index, label, phase: assignedPhase, profile, sessionKey: opts.sessionKey, prompt: taskPrompt, cached: true });
      options.onSubagentEnd?.({ index, label, phase: assignedPhase, result: cachedResult.result, cached: true, failed: false });
      await recordSubagentResult({ ...call, index, fingerprint, result: cachedResult.result, failed: false, cached: true });
      return cachedResult.result;
    }
    state.resumePrefixActive = false;

    // Queue on session_key serialization first, then on the shared global cap.
    // Same-key followers stay queued and do not occupy a global subagent slot
    // while waiting for the earlier turn in that child conversation to finish.
    const runLiveSubagent = async () => {
      const release = await limiter.acquire(compositeSignal);
      try {
        options.onSubagentStart?.({ index, label, phase: assignedPhase, profile, sessionKey: opts.sessionKey, prompt: taskPrompt });
        throwIfAborted();
        const liveResult = await options.runSubagent(call, compositeSignal);
        throwIfAborted();
        return normalizeJsonSerializable(liveResult, "subagent result");
      } finally {
        release();
      }
    };

    let result: unknown;
    let failed = false;
    let failureMessage: string | undefined;
    let ended = false;
    const endSubagent = () => {
      if (ended) {
        return;
      }
      ended = true;
      options.onSubagentEnd?.({ index, label, phase: assignedPhase, result, failed, cached: false });
    };
    try {
      result = options.serializeSubagent
        ? await options.serializeSubagent(opts.sessionKey, runLiveSubagent, compositeSignal)
        : await runLiveSubagent();
    } catch (error) {
      failed = true;
      if (options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error)) {
        try {
          endSubagent();
        } catch {}
        throw error;
      }
      failureMessage = error instanceof Error ? error.message : String(error);
      log(`subagent ${label} failed: ${failureMessage}`);
      result = null;
    }
    endSubagent();
    await recordSubagentResult({ ...call, index, fingerprint, result, failed, error: failureMessage, cached: false });
    return result;
  };

  const worker = createWorkflowScriptWorker({
    body,
    metaName: meta.name || "workflow",
    args: options.args,
    cwd: options.cwd,
    limits,
  });

  return await new Promise<WorkflowRunResult<T>>((resolve, reject) => {
    let finished = false;
    let lastHeartbeat = Date.now();
    let lastProgressAt = Date.now();
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setInterval> | undefined;
    const activeSubagentTasks = new Set<Promise<void>>();

    const cleanup = () => {
      if (options.signal && onExternalAbort) {
        options.signal.removeEventListener("abort", onExternalAbort);
      }
      if (abortTimer) {
        clearTimeout(abortTimer);
      }
      if (stallTimer) {
        clearInterval(stallTimer);
      }
      worker.removeAllListeners();
    };

    const drainRuntime = async () => {
      cleanup();
      await Promise.allSettled([worker.terminate(), ...activeSubagentTasks]);
    };

    const finishReject = (error: Error) => {
      if (finished) {
        return;
      }
      finished = true;
      abortRuntime(isWorkflowFatalError(error) ? error : new WorkflowFatalError(error.message));
      void drainRuntime().then(() => reject(error));
    };

    const finishResolve = (result: unknown) => {
      if (finished) {
        return;
      }
      let normalizedResult: unknown;
      try {
        throwIfAborted();
        if (fatalError) {
          throw fatalError;
        }
        if (state.subagentCount === 0) {
          throw new Error("workflow must call run_agent() at least once");
        }
        normalizedResult = normalizeJsonSerializable(result, "workflow result");
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      finished = true;
      void drainRuntime().then(() => resolve({
        meta,
        result: normalizedResult as T,
        logs: state.logs,
        phases: state.phases,
        subagentCount: state.subagentCount,
      }));
    };

    const abortWorkflow = (reason: string) => {
      if (finished) {
        return;
      }
      const error = new WorkflowAbortError(reason);
      abortRuntime(error);
      postToWorker({ type: "abort", reason });
      if (!abortTimer) {
        abortTimer = setTimeout(() => {
          finishReject(error);
        }, limits.abortGraceMs);
        abortTimer.unref?.();
      }
    };

    const onExternalAbort = () => {
      const reason = options.signal?.reason;
      abortWorkflow(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "workflow aborted");
    };
    if (options.signal?.aborted) {
      abortWorkflow("workflow aborted");
    } else {
      options.signal?.addEventListener("abort", onExternalAbort, { once: true });
    }

    const watchdogIntervalMs = Math.max(
      10,
      Math.min(1_000, Math.floor(Math.min(limits.workerStallTimeoutMs, limits.workerIdleTimeoutMs) / 4)),
    );
    stallTimer = setInterval(() => {
      if (finished) {
        return;
      }
      const now = Date.now();
      const silentFor = now - lastHeartbeat;
      if (silentFor >= limits.workerStallTimeoutMs) {
        finishReject(new WorkflowFatalError(`workflow script worker stalled for ${silentFor}ms`));
        return;
      }
      const idleFor = now - lastProgressAt;
      if (activeSubagentTasks.size === 0 && idleFor >= limits.workerIdleTimeoutMs) {
        finishReject(new WorkflowFatalError(`workflow script made no progress for ${idleFor}ms`));
      }
    }, watchdogIntervalMs);
    stallTimer.unref?.();

    function postToWorker(message: ParentToWorkerMessage): void {
      if (finished) {
        return;
      }
      try {
        worker.postMessage(message);
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    function handleSubagentRequest(message: Extract<WorkerToParentMessage, { type: "subagent" }>): void {
      const task = (async () => {
        try {
          const result = await runSubagentCall(message.prompt, message.options);
          lastProgressAt = Date.now();
          postToWorker({ type: "subagentResult", id: message.id, ok: true, result });
        } catch (error) {
          const fatal = options.signal?.aborted || runtimeAbortController.signal.aborted || isWorkflowFatalError(error);
          if (fatal) {
            rememberFatal(error instanceof Error ? error : new WorkflowFatalError(String(error)));
          }
          lastProgressAt = Date.now();
          postToWorker({
            type: "subagentResult",
            id: message.id,
            ok: false,
            fatal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })().finally(() => {
        activeSubagentTasks.delete(task);
      });
      activeSubagentTasks.add(task);
    }

    worker.on("message", (message: WorkerToParentMessage) => {
      if (finished || !message || typeof message !== "object") {
        return;
      }
      try {
        switch (message.type) {
          case "heartbeat":
            lastHeartbeat = Date.now();
            break;
          case "subagent":
            lastProgressAt = Date.now();
            handleSubagentRequest(message);
            break;
          case "log":
            lastProgressAt = Date.now();
            log(message.message);
            break;
          case "phase":
            lastProgressAt = Date.now();
            phase(message.title);
            break;
          case "fatal":
            lastProgressAt = Date.now();
            abortRuntime(new WorkflowFatalError(message.error));
            break;
          case "complete":
            lastProgressAt = Date.now();
            finishResolve(message.result);
            break;
          case "error":
            finishReject(fatalError ?? new Error(message.error));
            break;
        }
      } catch (error) {
        finishReject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    worker.on("error", (error) => {
      finishReject(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on("exit", (code) => {
      if (!finished && code !== 0) {
        finishReject(fatalError ?? new Error(`workflow script worker exited with code ${code}`));
      }
    });
  });
}

function normalizeWorkflowLimits(limits: Partial<WorkflowLimits> | undefined): WorkflowLimits {
  const normalized = { ...DEFAULT_WORKFLOW_LIMITS, ...(limits ?? {}) };
  for (const [key, value] of Object.entries(normalized)) {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
      throw new Error(`workflow limit ${key} must be a positive integer`);
    }
  }
  return normalized;
}
