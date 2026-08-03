import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionManager,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import { getBackendAgentLabel } from "./core/display.ts";
import { filterProfilesForModelRegistry, resolveProfileModel, usesPiBackend } from "./core/model.ts";
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
import { formatUsage } from "./core/subagent-render.ts";
import {
  BackgroundTaskManager,
  TASK_NOTIFICATION_CUSTOM_TYPE,
  taskToolResult,
  type AgentAcceptedTaskEnvelope,
  type TaskCounts,
  type TerminalTaskEnvelope,
} from "./core/task-manager.ts";
import { buildFlowPrompt } from "./prompts.ts";
import { getSubagentProfiles } from "./profiles.ts";
import type {
  SubagentBackend,
  SubagentExtensionOptions,
  SubagentProfile,
  SubagentTelemetry,
  SubagentToolDetails,
  SubagentType,
  SubagentUsage,
} from "./types.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";
import { createWorkflowTool } from "./workflow/tool.ts";

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 12;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT_SUBAGENTS_FLAG = "max-concurrent-subagents";
const SUBAGENT_TIMEOUT_MS_FLAG = "subagent-timeout-ms";
const STATUS_KEY = "pi-flow";

const AGENT_PROMPT_SNIPPET = "Launch one focused background subagent task";

const agentToolParameters = Type.Object({
  description: Type.String({
    description: "Short task name, ideally 3-5 words; not sent as the child task.",
  }),
  prompt: Type.String({
    description:
      "Complete task briefing sent to the child. Include needed paths, constraints, and expected result because fresh calls do not inherit the parent conversation.",
  }),
  subagent_type: Type.Optional(
    Type.String({
      description:
        "Registered profile name. Defaults to general-purpose; selects the backend, model, thinking level, role prompt, and Pi tool allowlist.",
    }),
  ),
  session_key: Type.Optional(
    Type.String({
      description:
        "Optional subagent conversation key. Reuse a session_key returned by an earlier Agent call to continue that child conversation. Omit to start a new conversation; the effective session_key is returned.",
    }),
  ),
});

type AgentToolParams = Static<typeof agentToolParameters>;

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  sessionBindings: Map<string, SessionKeyBinding>;
  sessionKeyLocks: SessionKeyLocks;
}

interface FlowStatusState {
  calls: Map<string, { usage: SubagentUsage; telemetry: SubagentTelemetry }>;
  tasks: TaskCounts;
}

interface CreateAgentToolOptions {
  getTaskManager: () => BackgroundTaskManager;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  updateStatus: (ctx: ExtensionContext, taskId: string, usage: SubagentUsage, telemetry: SubagentTelemetry) => void;
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

function normalizeSubagentType(value: string | undefined): SubagentType {
  if (value === undefined || value.trim() === "") {
    return "general-purpose";
  }
  return value.trim();
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
    existing.subagentType === binding.subagentType &&
    existing.backend === binding.backend
  ) {
    return;
  }
  persistSessionKeyBinding(ctx, binding);
}

function formatProfileNames(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.keys()].join(", ");
}

function getProfileBackend(subagentType: SubagentType): SubagentBackend | undefined {
  return getSubagentProfiles(getAgentDir()).get(subagentType)?.backend;
}

function createFlowStatusState(): FlowStatusState {
  return {
    calls: new Map(),
    tasks: {
      agent: { finished: 0, total: 0 },
      workflow: { finished: 0, total: 0 },
    },
  };
}

function getUsageTotals(state: FlowStatusState): { usage: SubagentUsage; telemetry: SubagentTelemetry } {
  const usage: SubagentUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
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

function publishFlowStatus(ctx: ExtensionContext, state: FlowStatusState): void {
  if (!ctx.hasUI) {
    return;
  }
  const { agent, workflow } = state.tasks;
  const totals = getUsageTotals(state);
  if (agent.total === 0 && workflow.total === 0 && totals.usage.totalTokens === 0 && totals.usage.cost.total === 0) {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    return;
  }
  const tasks = `[${agent.finished}/${agent.total}] agents [${workflow.finished}/${workflow.total}] workflows`;
  const usage = totals.usage.totalTokens > 0 || totals.usage.cost.total > 0
    ? ` ${formatUsage(totals.usage, totals.telemetry)}`
    : "";
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", `pi-flow ${tasks}${usage}`));
}

function renderTaskNotification(envelope: TerminalTaskEnvelope, expanded: boolean, theme: Theme): Text {
  const label = envelope.task_type === "agent" ? "Agent" : "Workflow";
  const color = envelope.status === "completed" ? "success" : "error";
  const summary = `${theme.fg(color, envelope.status === "completed" ? "✓" : "✗")} ${theme.bold(label)} ${theme.fg("muted", envelope.name)} ${theme.fg("dim", envelope.task_id)}`;
  const text = expanded || envelope.status === "failed" ? `${summary}\n${envelope.content}` : summary;
  return new Text(text, 0, 0);
}

function createAgentTool(
  getState: () => DelegationState,
  options: CreateAgentToolOptions,
): ToolDefinition<typeof agentToolParameters, AgentAcceptedTaskEnvelope> {
  return defineTool({
    name: "Agent",
    label: "Agent",
    description:
      "Launch one background subagent task in the current working directory and return its task ID immediately. The task sends one completion or failure notification later. Calls without `session_key` start a new resumable conversation and return its generated key. Calls with the same key continue that child and are serialized. Subagent concurrency is bounded and queued. Pi-backed children cannot invoke PiFlow delegation tools. External-backend profiles use their CLI permission surface and should run only in trusted repositories.",
    promptSnippet: AGENT_PROMPT_SNIPPET,
    parameters: agentToolParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      const subagentType = normalizeSubagentType(params.subagent_type);
      const sessionKey = normalizeSessionKey(params.session_key) ?? createSessionKey();
      const name = params.description.trim() || params.description;
      const accepted = options.getTaskManager().start({
        taskType: "agent",
        name,
        sessionKey,
        run: async (signal, taskId) => {
          const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
          const profile = profiles.get(subagentType);
          if (!profile) {
            throw new Error(`Unknown subagent_type "${params.subagent_type}". Available agents: ${formatProfileNames(profiles)}.`);
          }
          const model = resolveProfileModel(profile, ctx);
          if (usesPiBackend(profile) && !model) {
            throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");
          }

          return state.sessionKeyLocks.run(sessionKey, async () => {
            const binding = getSessionKeyBinding(state, ctx, sessionKey);
            if (binding) {
              assertBindingMatchesProfile(binding, { subagentType, backend: profile.backend });
            }
            const release = await state.limiter.acquire(signal);
            try {
              const spawned = await spawnSubagent({
                toolCallId: taskId,
                description: name,
                prompt: params.prompt,
                profile,
                model,
                thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
                ctx,
                signal,
                timeoutMs: options.getSubagentTimeoutMs(),
                progressEnabled: false,
                onProgress: undefined,
                onUsage: (usage, telemetry) => options.updateStatus(ctx, taskId, usage, telemetry),
                excludeTools: CHILD_EXCLUDED_TOOLS,
                sessionId: binding?.sessionId,
                persistSession: true,
              });
              const details = spawned.details as SubagentToolDetails;
              if (details.sessionId) {
                rememberSessionKeyBinding(state, ctx, {
                  key: sessionKey,
                  sessionId: details.sessionId,
                  subagentType,
                  backend: profile.backend,
                });
              }
              signal.throwIfAborted();
              if (details.status !== "done") {
                throw new Error(details.error ?? "Subagent failed");
              }
              if (!details.sessionId) {
                throw new Error("Subagent completed without a resumable session ID");
              }
              return details.result ?? "";
            } finally {
              release();
            }
          });
        },
      });
      return taskToolResult(accepted);
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const subagentType = normalizeSubagentType(args.subagent_type);
      const backend = getProfileBackend(subagentType);
      const description = typeof args.description === "string" ? args.description.trim() : "";
      return new Text(
        `${theme.bold(getBackendAgentLabel(backend))} ${theme.fg("muted", subagentType)}${description ? ` ${theme.fg("dim", description)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const details = result.details as AgentAcceptedTaskEnvelope;
      return new Text(
        `${theme.bold("Agent")} ${theme.fg("muted", details.name)} ${theme.fg("dim", `accepted ${details.task_id}`)}`,
        0,
        0,
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
    };
    const statusState = createFlowStatusState();
    const pendingNotifications = new Map<string, { envelope: TerminalTaskEnvelope; submitted: boolean }>();
    let statusContext: ExtensionContext | undefined;
    let notificationSessionManager: SessionManager | undefined;
    let notificationDeliveryPaused = false;
    const taskNotificationMessage = (envelope: TerminalTaskEnvelope) => ({
      customType: TASK_NOTIFICATION_CUSTOM_TYPE,
      content: JSON.stringify(envelope),
      display: true,
      details: envelope,
    });
    const persistTaskNotification = (sessionManager: SessionManager, envelope: TerminalTaskEnvelope) => {
      sessionManager.appendCustomMessageEntry(
        TASK_NOTIFICATION_CUSTOM_TYPE,
        JSON.stringify(envelope),
        true,
        envelope,
      );
    };
    const sendTaskNotification = (envelope: TerminalTaskEnvelope) => {
      pi.sendMessage(taskNotificationMessage(envelope), {
        deliverAs: "steer",
        triggerTurn: true,
      });
    };
    const submitTaskNotifications = (includeSubmitted: boolean) => {
      if (notificationSessionManager) {
        return;
      }
      const batch = [...pendingNotifications.values()]
        .filter((notification) => includeSubmitted || !notification.submitted);
      for (const notification of batch) {
        notification.submitted = true;
      }
      for (const notification of batch) {
        sendTaskNotification(notification.envelope);
      }
    };
    const persistPendingNotifications = (sessionManager: SessionManager) => {
      for (const notification of pendingNotifications.values()) {
        persistTaskNotification(sessionManager, notification.envelope);
      }
      pendingNotifications.clear();
    };
    const createTaskManager = () => new BackgroundTaskManager({
      notify: (envelope) => {
        if (notificationSessionManager) {
          persistTaskNotification(notificationSessionManager, envelope);
          return;
        }
        pendingNotifications.set(envelope.task_id, { envelope, submitted: false });
        if (!notificationDeliveryPaused) {
          submitTaskNotifications(false);
        }
      },
      onCountsChange: (counts) => {
        statusState.tasks = counts;
        if (statusContext) {
          publishFlowStatus(statusContext, statusState);
        }
      },
    });
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
    const updateStatus = (
      ctx: ExtensionContext,
      taskId: string,
      usage: SubagentUsage,
      telemetry: SubagentTelemetry,
    ) => {
      statusContext = ctx;
      statusState.calls.set(taskId, { usage, telemetry });
      publishFlowStatus(ctx, statusState);
    };

    pi.registerMessageRenderer<TerminalTaskEnvelope>(TASK_NOTIFICATION_CUSTOM_TYPE, (message, { expanded }, theme) => {
      const envelope = message.details as TerminalTaskEnvelope;
      return renderTaskNotification(envelope, expanded, theme);
    });
    pi.registerTool(createAgentTool(syncRuntimeOptions, {
      getTaskManager,
      getThinkingLevel: () => pi.getThinkingLevel(),
      getSubagentTimeoutMs: () => syncRuntimeOptions().subagentTimeoutMs,
      updateStatus,
    }));
    if (workflowEnabled) {
      pi.registerTool(
        createWorkflowTool({
          getTaskManager,
          getLimiter: () => syncRuntimeOptions().limiter,
          getThinkingLevel: () => pi.getThinkingLevel(),
          getSubagentTimeoutMs: () => syncRuntimeOptions().subagentTimeoutMs,
          updateStatus,
        }),
      );
    }

    pi.on("session_start", (_event, ctx) => {
      if (taskManagerNeedsReset) {
        taskManager = createTaskManager();
        taskManagerNeedsReset = false;
      }
      pendingNotifications.clear();
      notificationSessionManager = undefined;
      notificationDeliveryPaused = false;
      statusContext = ctx;
      syncRuntimeOptions();
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      statusState.calls.clear();
      statusState.tasks = getTaskManager().getCounts();
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    });

    pi.on("message_end", (event) => {
      if (
        event.message.role === "custom" &&
        event.message.customType === TASK_NOTIFICATION_CUSTOM_TYPE &&
        typeof event.message.details === "object" &&
        event.message.details !== null &&
        "task_id" in event.message.details
      ) {
        pendingNotifications.delete(String(event.message.details.task_id));
      }
    });

    pi.on("agent_start", () => {
      notificationDeliveryPaused = false;
      submitTaskNotifications(false);
    });

    pi.on("agent_settled", () => {
      notificationDeliveryPaused = false;
      submitTaskNotifications(true);
    });

    pi.on("session_before_tree", async (_event, ctx) => {
      const manager = getTaskManager();
      if (!manager.hasActiveTasks() && pendingNotifications.size === 0) {
        return;
      }
      const hadActiveTasks = manager.hasActiveTasks();
      const sessionManager = ctx.sessionManager as SessionManager;
      notificationSessionManager = sessionManager;
      try {
        await manager.abortAll("Pi session tree changed");
        persistPendingNotifications(sessionManager);
      } finally {
        notificationSessionManager = undefined;
      }
      if (hadActiveTasks && ctx.hasUI) {
        ctx.ui.notify("PiFlow aborted background tasks before changing branches", "warning");
      }
    });

    pi.on("session_tree", (_event, ctx) => {
      taskManager = createTaskManager();
      pendingNotifications.clear();
      notificationDeliveryPaused = false;
      statusContext = ctx;
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      statusState.calls.clear();
      statusState.tasks = taskManager.getCounts();
      publishFlowStatus(ctx, statusState);
    });

    pi.on("agent_end", async (_event, ctx) => {
      notificationDeliveryPaused = true;
      if (ctx.mode === "print" || ctx.mode === "json") {
        await getTaskManager().waitForIdle();
        submitTaskNotifications(false);
      }
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      const endingTaskManager = getTaskManager();
      taskManagerNeedsReset = true;
      const sessionManager = ctx.sessionManager as SessionManager;
      notificationSessionManager = sessionManager;
      try {
        await endingTaskManager.shutdown();
        persistPendingNotifications(sessionManager);
      } finally {
        notificationSessionManager = undefined;
      }
      if (ctx.hasUI) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      statusContext = undefined;
    });

    pi.on("before_agent_start", (event, ctx) => {
      notificationDeliveryPaused = true;
      statusContext = ctx;
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
