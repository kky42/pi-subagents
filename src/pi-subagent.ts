import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import {
  getAgentDisplayDescriptor,
  getBackendAgentLabel,
  type AgentDisplayMetadata,
} from "./core/display.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "./core/model.ts";
import {
  boundedProgressText,
  createProgressNode,
  MAX_MODEL_VISIBLE_TEXT_CHARS,
  subagentDisplayDetails,
  textResult,
  type SubagentToolResult,
} from "./core/progress.ts";
import {
  assertBindingMatchesProfile,
  createSessionKey,
  getPersistedSessionKeyBinding,
  normalizeSessionKey,
  persistSessionKeyBinding,
  SessionKeyLocks,
  type SessionKeyBinding,
} from "./core/session-key.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import { renderSubagentNode } from "./core/subagent-render.ts";
import { normalizeProfileName, normalizeSubagentLabel } from "./core/subagent-values.ts";
import {
  SynchronousTaskManager,
  taskEnvelopeContent,
  type AgentTerminalTaskEnvelope,
} from "./core/task-manager.ts";
import { createRunWorkflowTool } from "./pi-workflow.ts";
import { buildFlowPrompt } from "./prompts.ts";
import { getSubagentProfiles } from "./profiles.ts";
import type {
  SubagentBackend,
  SubagentExtensionOptions,
  SubagentProfile,
  SubagentProfileName,
  SubagentProgressNode,
  SubagentToolDetails,
  SubagentUsage,
} from "./types.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 12;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT_SUBAGENTS_FLAG = "max-concurrent-subagents";
const SUBAGENT_TIMEOUT_MS_FLAG = "subagent-timeout-ms";
const FLOW_UI_KEY = "pi-flow";
const RUN_AGENT_PROMPT_SNIPPET = "Delegate one focused task to a subagent";
const RUN_AGENT_PROMPT_GUIDELINES = [
  "Use run_agent only when delegation adds value; keep narrow local work in the foreground.",
  "Launch independent run_agent tasks in parallel when they do not depend on each other.",
  "Use profiles backed by external CLIs only in trusted repositories.",
];

const runAgentToolParameters = Type.Object({
  label: Type.String({
    minLength: 1,
    pattern: ".*\\S.*",
    description: "Short UI task label, ideally 3-5 words; not sent to the subagent.",
  }),
  prompt: Type.String({
    description:
      "Complete task briefing sent to the subagent. Include needed paths, constraints, and expected result because fresh calls do not inherit parent context.",
  }),
  profile: Type.Optional(
    Type.String({
      description: "Registered profile name; defaults to general-purpose.",
    }),
  ),
  session_key: Type.Optional(
    Type.String({
      description:
        "Prior run_agent session_key to continue. Omit to start a new subagent conversation; the effective key is returned once the subagent starts.",
    }),
  ),
}, { additionalProperties: false });

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  sessionBindings: Map<string, SessionKeyBinding>;
  sessionKeyLocks: SessionKeyLocks;
  activeRuns: Map<string, ActiveAgentRun>;
  frame: number;
}

interface ActiveAgentRun {
  sessionKey: string;
  progress: SubagentProgressNode;
  usage?: SubagentUsage;
  onUpdate: ((result: AgentToolResult<RunAgentToolDetails>) => void) | undefined;
}

interface RunAgentToolDetails extends SubagentToolDetails {
  sessionKey?: string;
  usage?: SubagentUsage;
}

interface CreateRunAgentToolOptions {
  getTaskManager: () => SynchronousTaskManager;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
}

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function normalizeMaxConcurrentSubagents(value: number | string | boolean | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function normalizeSubagentTimeoutMs(value: number | string | boolean | undefined, fallback: number, label: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function getSessionKeyBinding(
  state: DelegationState,
  ctx: ExtensionContext,
  sessionKey: string,
): SessionKeyBinding | undefined {
  const persisted = getPersistedSessionKeyBinding(ctx, sessionKey);
  if (persisted) {
    state.sessionBindings.set(sessionKey, persisted);
    return persisted;
  }
  return state.sessionBindings.get(sessionKey);
}

function rememberSessionKeyBinding(
  state: DelegationState,
  ctx: ExtensionContext,
  binding: SessionKeyBinding,
): void {
  const existing = getSessionKeyBinding(state, ctx, binding.key);
  state.sessionBindings.set(binding.key, binding);
  if (
    existing?.sessionId === binding.sessionId &&
    existing.profile === binding.profile &&
    existing.backend === binding.backend
  ) {
    return;
  }
  persistSessionKeyBinding(ctx, binding);
}

function formatProfileNames(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.keys()].join(", ");
}

function getProfileBackend(profileName: SubagentProfileName): SubagentBackend | undefined {
  return getSubagentProfiles(getAgentDir()).get(profileName)?.backend;
}

function renderAgentIdentity(display: AgentDisplayMetadata, label: string, theme: Theme): string {
  const backendLabel = getBackendAgentLabel(display.backend);
  const descriptor = getAgentDisplayDescriptor(display.profile, label);
  return `${theme.bold(backendLabel)}${theme.fg("muted", `(${descriptor})`)}`;
}

function runningRunCount(state: DelegationState): number {
  let count = 0;
  for (const run of state.activeRuns.values()) {
    if (run.progress.status === "running") {
      count++;
    }
  }
  return count;
}

function emitRunUpdate(state: DelegationState, run: ActiveAgentRun): void {
  const details = subagentDisplayDetails({
    label: run.progress.label,
    profile: run.progress.profile,
    backend: run.progress.backend,
    status: run.progress.status,
    result: run.progress.result,
    error: run.progress.error,
    telemetry: run.progress.telemetry,
    progress: run.progress,
    activeCount: runningRunCount(state),
    frame: state.frame,
  });
  const usage = run.usage
    ? { ...run.usage, cost: { ...run.usage.cost } }
    : undefined;
  run.onUpdate?.({
    content: [{ type: "text", text: `Subagent "${details.label}" (${details.profile}) ${details.status}.` }],
    details: {
      ...details,
      sessionKey: run.sessionKey,
      ...(usage ? { usage } : {}),
    },
    ...(usage ? { usage } : {}),
  });
}

function broadcastRunUpdates(state: DelegationState): void {
  for (const run of state.activeRuns.values()) {
    emitRunUpdate(state, run);
  }
}

function failedSubagentResult(
  label: string,
  profile: string,
  backend: SubagentBackend | undefined,
  error: unknown,
  signal?: AbortSignal,
): SubagentToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const status = signal?.aborted ? "aborted" : "error";
  const verb = status === "aborted" ? "aborted" : "failed";
  return textResult(`Subagent "${label}" (${profile}) ${verb}: ${message}`, {
    label,
    profile,
    ...(backend ? { backend } : {}),
    status,
    error: message,
  });
}

interface AgentCallOutcome {
  result: SubagentToolResult;
  /** True when a resumable child session was created for this call; the session key is only contractually valid then. */
  sessionStarted: boolean;
}

async function executeAgentCall(params: {
  state: DelegationState;
  options: CreateRunAgentToolOptions;
  toolCallId: string;
  label: string;
  prompt: string;
  profileName: string;
  sessionKey: string;
  signal: AbortSignal;
  onUpdate: ((result: AgentToolResult<RunAgentToolDetails>) => void) | undefined;
  ctx: ExtensionContext;
}): Promise<AgentCallOutcome> {
  const { state, options, toolCallId, label, profileName, sessionKey, signal, onUpdate, ctx } = params;
  const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
  const profile = profiles.get(profileName);
  if (!profile) {
    return {
      sessionStarted: false,
      result: failedSubagentResult(
        label,
        profileName,
        undefined,
        `Unknown profile "${profileName}". Available profiles: ${formatProfileNames(profiles)}.`,
        signal,
      ),
    };
  }
  const model = resolveProfileModel(profile, ctx);
  if (usesPiBackend(profile) && !model) {
    return {
      sessionStarted: false,
      result: failedSubagentResult(
        label,
        profileName,
        profile.backend,
        profile.model ? `Profile model not found: ${profile.model}` : "No model is selected",
        signal,
      ),
    };
  }

  const run: ActiveAgentRun | undefined = onUpdate
    ? {
        sessionKey,
        progress: createProgressNode(label, profileName, "queued", profile.backend),
        onUpdate,
      }
    : undefined;
  if (run) {
    state.activeRuns.set(toolCallId, run);
    broadcastRunUpdates(state);
  }

  try {
    let outcome: AgentCallOutcome;
    try {
      outcome = await state.sessionKeyLocks.run(sessionKey, async () => {
        signal.throwIfAborted();
        const binding = getSessionKeyBinding(state, ctx, sessionKey);
        if (binding) {
          assertBindingMatchesProfile(binding, { profile: profileName, backend: profile.backend });
        }
        const release = await state.limiter.acquire(signal);
        try {
          if (run) {
            run.progress.status = "running";
            run.progress.startedAt = Date.now();
            state.frame++;
            broadcastRunUpdates(state);
          }
          const spawned = await spawnSubagent({
            label,
            prompt: params.prompt,
            profile,
            model,
            thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
            ctx,
            signal,
            timeoutMs: options.getSubagentTimeoutMs(),
            progressEnabled: Boolean(run),
            onProgress: run
              ? (partial) => {
                  const details = partial.details as SubagentToolDetails;
                  if (details.progress) {
                    run.progress = details.progress;
                  }
                  run.usage = partial.usage;
                  state.frame++;
                  emitRunUpdate(state, run);
                }
              : undefined,
            onUsage: () => {},
            excludeTools: CHILD_EXCLUDED_TOOLS,
            sessionId: binding?.sessionId,
            persistSession: true,
          });
          const details = spawned.details as SubagentToolDetails;
          if (details.sessionId) {
            rememberSessionKeyBinding(state, ctx, {
              key: sessionKey,
              sessionId: details.sessionId,
              profile: profileName,
              backend: profile.backend,
            });
          }
          if (details.status === "done" && !details.sessionId) {
            return {
              sessionStarted: false,
              result: textResult(`Subagent "${label}" (${profileName}) failed: Subagent completed without a resumable session ID`, {
                ...details,
                status: "error",
                error: "Subagent completed without a resumable session ID",
              }, spawned.usage),
            };
          }
          return { sessionStarted: Boolean(details.sessionId), result: spawned };
        } finally {
          release();
        }
      }, signal);
    } catch (error) {
      return {
        sessionStarted: false,
        result: failedSubagentResult(label, profileName, profile.backend, error, signal),
      };
    }

    const details = { ...(outcome.result.details as SubagentToolDetails) };
    delete details.sessionId;
    if (run) {
      if (details.progress) {
        run.progress = details.progress;
      } else {
        run.progress.status = details.status;
        run.progress.result = details.result;
        run.progress.error = details.error;
        run.progress.telemetry = details.telemetry;
        run.progress.endedAt = Date.now();
        details.progress = run.progress;
      }
      run.usage = outcome.result.usage;
      details.activeCount = runningRunCount(state);
      details.frame = state.frame;
      broadcastRunUpdates(state);
    }
    return { result: { ...outcome.result, details }, sessionStarted: outcome.sessionStarted };
  } finally {
    if (run) {
      state.activeRuns.delete(toolCallId);
      state.frame++;
      broadcastRunUpdates(state);
    }
  }
}

function createRunAgentTool(
  getState: () => DelegationState,
  options: CreateRunAgentToolOptions,
): ToolDefinition<typeof runAgentToolParameters, RunAgentToolDetails> {
  return defineTool({
    name: "run_agent",
    label: "Run Agent",
    description:
      "Use run_agent to delegate one focused, self-contained task to a subagent. It is best for independent parallel work or context-heavy exploration whose intermediate context the foreground does not need. Subagents cannot invoke PiFlow delegation tools.",
    promptSnippet: RUN_AGENT_PROMPT_SNIPPET,
    promptGuidelines: RUN_AGENT_PROMPT_GUIDELINES,
    parameters: runAgentToolParameters,
    executionMode: "parallel",
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const state = getState();
      const profileName = normalizeProfileName(params.profile) ?? "general-purpose";
      const sessionKey = normalizeSessionKey(params.session_key) ?? createSessionKey();
      const label = normalizeSubagentLabel(params.label) ?? params.label.trim();
      const managed = await options.getTaskManager().run({
        signal,
        execute: async (taskSignal) => {
          const outcome = label
            ? await executeAgentCall({
                state,
                options,
                toolCallId,
                label,
                prompt: params.prompt,
                profileName,
                sessionKey,
                signal: taskSignal,
                onUpdate,
                ctx,
              })
            : {
                sessionStarted: false,
                result: failedSubagentResult("unnamed", profileName, undefined, "Subagent label must contain non-whitespace characters", taskSignal),
              };
          const details = outcome.result.details as SubagentToolDetails;
          return {
            status: details.status === "done" ? "completed" : "failed",
            value: outcome,
          };
        },
      });

      let { result, sessionStarted } = managed.value;
      let details = result.details as SubagentToolDetails;
      if (managed.abortReason && (details.status === "done" || details.status === "aborted")) {
        details = {
          ...details,
          status: "aborted",
          result: undefined,
          error: managed.abortReason,
          ...(details.progress
            ? {
                progress: {
                  ...details.progress,
                  status: "aborted",
                  result: undefined,
                  error: managed.abortReason,
                },
              }
            : {}),
        };
        result = { ...result, details };
      }
      const envelope: AgentTerminalTaskEnvelope = {
        task_type: "agent",
        status: managed.status,
        ...(sessionStarted ? { session_key: sessionKey } : {}),
        label: label || "unnamed",
        content: managed.status === "completed"
          ? boundedProgressText(details.result ?? "", MAX_MODEL_VISIBLE_TEXT_CHARS)
          : boundedProgressText(details.error ?? managed.abortReason ?? "Subagent failed", MAX_MODEL_VISIBLE_TEXT_CHARS),
      };
      return {
        ...result,
        content: taskEnvelopeContent(envelope),
        details: {
          ...subagentDisplayDetails(details),
          ...(sessionStarted ? { sessionKey } : {}),
          ...(result.usage ? { usage: { ...result.usage, cost: { ...result.usage.cost } } } : {}),
        },
      };
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const profile = normalizeProfileName(args.profile) ?? "general-purpose";
      const display = { backend: getProfileBackend(profile), profile };
      const label = normalizeSubagentLabel(args.label) ?? "";
      return new Text(renderAgentIdentity(display, label, theme), 0, 0);
    },
    renderResult(result, _renderOptions, theme) {
      const details = result.details as RunAgentToolDetails;
      const usage = details.usage ?? (result as typeof result & { usage?: SubagentUsage }).usage;
      return renderSubagentNode(
        details.progress
          ? {
              ...details.progress,
              usage,
              telemetry: details.telemetry ?? details.progress.telemetry,
            }
          : {
              label: details.label,
              profile: details.profile,
              backend: details.backend,
              status: details.status,
              result: details.result,
              error: details.error,
              usage,
              telemetry: details.telemetry,
            },
        theme,
        details.frame ?? 0,
        details.activeCount ?? (details.status === "running" ? 1 : 0),
      );
    },
  });
}

export function createSubagentExtension(options: SubagentExtensionOptions = {}): ExtensionFactory {
  const defaultMaxConcurrentSubagents = normalizeMaxConcurrentSubagents(
    options.maxConcurrentSubagents,
    DEFAULT_MAX_CONCURRENT_SUBAGENTS,
    "maxConcurrentSubagents",
  );
  const defaultSubagentTimeoutMs = normalizeSubagentTimeoutMs(
    options.subagentTimeoutMs,
    DEFAULT_SUBAGENT_TIMEOUT_MS,
    "subagentTimeoutMs",
  );
  const workflowEnabled = options.workflow !== false;

  return function subagentExtension(pi: ExtensionAPI) {
    pi.registerFlag(MAX_CONCURRENT_SUBAGENTS_FLAG, {
      description: `Maximum number of pi-flow subagents that may run concurrently (default: ${defaultMaxConcurrentSubagents})`,
      type: "string",
      default: String(defaultMaxConcurrentSubagents),
    });
    pi.registerFlag(SUBAGENT_TIMEOUT_MS_FLAG, {
      description: `Maximum wall-clock runtime for each pi-flow subagent in milliseconds; set 0 to disable (default: ${defaultSubagentTimeoutMs})`,
      type: "string",
      default: String(defaultSubagentTimeoutMs),
    });

    const rootState: DelegationState = {
      limiter: new ConcurrencyLimiter(defaultMaxConcurrentSubagents),
      maxConcurrentSubagents: defaultMaxConcurrentSubagents,
      subagentTimeoutMs: defaultSubagentTimeoutMs,
      sessionBindings: new Map(),
      sessionKeyLocks: new SessionKeyLocks(),
      activeRuns: new Map(),
      frame: 0,
    };
    const createTaskManager = () => new SynchronousTaskManager();
    let taskManager = createTaskManager();
    let taskManagerNeedsReset = false;
    const getTaskManager = () => taskManager;
    const syncRuntimeOptions = () => {
      const current = normalizeMaxConcurrentSubagents(
        pi.getFlag(MAX_CONCURRENT_SUBAGENTS_FLAG),
        defaultMaxConcurrentSubagents,
        `--${MAX_CONCURRENT_SUBAGENTS_FLAG}`,
      );
      if (current !== rootState.maxConcurrentSubagents) {
        rootState.limiter = new ConcurrencyLimiter(current);
        rootState.maxConcurrentSubagents = current;
      }
      rootState.subagentTimeoutMs = normalizeSubagentTimeoutMs(
        pi.getFlag(SUBAGENT_TIMEOUT_MS_FLAG),
        defaultSubagentTimeoutMs,
        `--${SUBAGENT_TIMEOUT_MS_FLAG}`,
      );
      return rootState;
    };

    pi.registerTool(createRunAgentTool(syncRuntimeOptions, {
      getTaskManager,
      getThinkingLevel: () => pi.getThinkingLevel(),
      getSubagentTimeoutMs: () => syncRuntimeOptions().subagentTimeoutMs,
    }));
    if (workflowEnabled) {
      pi.registerTool(createRunWorkflowTool({
        getTaskManager,
        getLimiter: () => syncRuntimeOptions().limiter,
        getThinkingLevel: () => pi.getThinkingLevel(),
        getSubagentTimeoutMs: () => syncRuntimeOptions().subagentTimeoutMs,
      }));
    }

    pi.on("session_start", (_event, ctx) => {
      if (taskManagerNeedsReset) {
        taskManager = createTaskManager();
        taskManagerNeedsReset = false;
      }
      syncRuntimeOptions();
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      rootState.activeRuns.clear();
      rootState.frame = 0;
      if (ctx.hasUI) {
        ctx.ui.setStatus(FLOW_UI_KEY, undefined);
        ctx.ui.setWidget(FLOW_UI_KEY, undefined);
      }
    });

    pi.on("session_before_compact", (event, ctx) => {
      if (event.reason !== "manual" || !getTaskManager().hasActiveTasks()) {
        return;
      }
      if (ctx.hasUI) {
        ctx.ui.notify("Wait for active PiFlow calls to finish before compacting", "warning");
      }
      return { cancel: true };
    });

    pi.on("session_before_tree", async (_event, ctx) => {
      if (!getTaskManager().hasActiveTasks()) {
        return;
      }
      await getTaskManager().abortAll("Pi session tree changed");
      if (ctx.hasUI) {
        ctx.ui.notify("PiFlow aborted active calls before changing branches", "warning");
      }
    });

    pi.on("session_tree", () => {
      taskManager = createTaskManager();
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      rootState.activeRuns.clear();
      rootState.frame = 0;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      taskManagerNeedsReset = true;
      await getTaskManager().shutdown();
      rootState.activeRuns.clear();
      if (ctx.hasUI) {
        ctx.ui.setStatus(FLOW_UI_KEY, undefined);
        ctx.ui.setWidget(FLOW_UI_KEY, undefined);
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
      const savedWorkflows = listSavedWorkflows({
        agentDir: getAgentDir(),
        cwd: ctx.cwd,
        projectTrusted: isProjectTrusted(ctx),
      });
      return {
        systemPrompt: [event.systemPrompt, buildFlowPrompt(profiles, savedWorkflows)].join("\n\n"),
      };
    });
  };
}

export const createFlowExtension = createSubagentExtension;

export default createFlowExtension();
