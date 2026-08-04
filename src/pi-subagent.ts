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
import { Type } from "typebox";
import { normalizeSubagentLabel, normalizeProfileName } from "./core/subagent-values.ts";
import { ConcurrencyLimiter } from "./core/concurrency.ts";
import {
  getAgentDisplayDescriptor,
  getBackendAgentLabel,
  type AgentDisplayMetadata,
} from "./core/display.ts";
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
import {
  clearActiveFlowTasks,
  createFlowStatusState,
  FLOW_STATUS_KEY,
  publishFlowStatus,
  recordFlowUsage,
  type QueuedSubagentStatus,
} from "./core/flow-status.ts";
import {
  BackgroundTaskManager,
  TASK_NOTIFICATION_CUSTOM_TYPE,
  TASK_STATE_EVENT,
  taskToolResult,
  type AgentAcceptedTaskEnvelope,
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
  SubagentProfileName,
  SubagentUsage,
} from "./types.ts";
import { listSavedWorkflows } from "./workflow/registry.ts";
import { createRunWorkflowTool } from "./workflow/tool.ts";

const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 12;
const DEFAULT_SUBAGENT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_CONCURRENT_SUBAGENTS_FLAG = "max-concurrent-subagents";
const SUBAGENT_TIMEOUT_MS_FLAG = "subagent-timeout-ms";
const RUN_AGENT_PROMPT_SNIPPET = "Delegate one focused task to a specialist";
const RUN_AGENT_PROMPT_GUIDELINES = [
  "Use run_agent only when delegation adds value; keep narrow local work in the foreground.",
  "Launch independent run_agent tasks in parallel when they do not depend on each other.",
  "Use profiles backed by external CLIs only in trusted repositories.",
];

const runAgentToolParameters = Type.Object({
  label: Type.String({
    minLength: 1,
    description: "Short UI task label, ideally 3-5 words; not sent to the child.",
  }),
  prompt: Type.String({
    description:
      "Complete task briefing sent to the child. Include needed paths, constraints, and expected result because fresh calls do not inherit parent context.",
  }),
  profile: Type.Optional(
    Type.String({
      description: "Registered profile name; defaults to general-purpose.",
    }),
  ),
  session_key: Type.Optional(
    Type.String({
      description:
        "Prior run_agent session_key to continue. Omit to start a new child conversation; the effective key is returned.",
    }),
  ),
}, { additionalProperties: false });

interface DelegationState {
  limiter: ConcurrencyLimiter;
  maxConcurrentSubagents: number;
  subagentTimeoutMs: number;
  sessionBindings: Map<string, SessionKeyBinding>;
  sessionKeyLocks: SessionKeyLocks;
}

interface AgentAcceptedTaskUiDetails extends AgentAcceptedTaskEnvelope {
  display?: AgentDisplayMetadata;
}

type TaskNotificationUiDetails = TerminalTaskEnvelope & {
  display?: AgentDisplayMetadata;
};

interface CreateRunAgentToolOptions {
  getTaskManager: () => BackgroundTaskManager;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  rememberAgentDisplay: (taskId: string, display: AgentDisplayMetadata) => void;
  queueSubagentStatus: (ctx: ExtensionContext, subagent: QueuedSubagentStatus) => void;
  startSubagentStatus: (ctx: ExtensionContext, taskId: string) => void;
  updateSubagentProgress: (ctx: ExtensionContext, taskId: string, eventCount: number) => void;
  finishTaskStatus: (taskId: string) => void;
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

function renderAgentIdentity(display: AgentDisplayMetadata | undefined, label: string, theme: Theme): string {
  if (!display) {
    return `${theme.bold("Agent")}${theme.fg("muted", `(${label})`)}`;
  }
  const backendLabel = getBackendAgentLabel(display.backend);
  const descriptor = getAgentDisplayDescriptor(display.profile, label);
  return `${theme.bold(backendLabel)}${theme.fg("muted", `(${descriptor})`)}`;
}

function renderWorkflowIdentity(name: string, theme: Theme): string {
  return `${theme.bold("Workflow")}${theme.fg("muted", `(${name})`)}`;
}

function renderTaskNotification(details: TaskNotificationUiDetails, expanded: boolean, theme: Theme): Text {
  const identity = details.task_type === "agent"
    ? renderAgentIdentity(details.display, details.label, theme)
    : renderWorkflowIdentity(details.name, theme);
  const color = details.status === "completed" ? "success" : "error";
  const summary = `${theme.fg(color, details.status === "completed" ? "✓" : "✗")} ${identity} ${theme.fg("dim", `${details.status} ${details.task_id}`)}`;
  const text = expanded || details.status === "failed" ? `${summary}\n${details.content}` : summary;
  return new Text(text, 0, 0);
}

function createRunAgentTool(
  getState: () => DelegationState,
  options: CreateRunAgentToolOptions,
): ToolDefinition<typeof runAgentToolParameters, AgentAcceptedTaskEnvelope> {
  return defineTool({
    name: "run_agent",
    label: "Run Agent",
    description:
      "Use run_agent to delegate one focused, self-contained task to a specialist. It is best for independent parallel work or context-heavy exploration whose intermediate context the foreground does not need. Subagents cannot invoke PiFlow delegation tools.",
    promptSnippet: RUN_AGENT_PROMPT_SNIPPET,
    promptGuidelines: RUN_AGENT_PROMPT_GUIDELINES,
    parameters: runAgentToolParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const state = getState();
      const profileName = normalizeProfileName(params.profile) ?? "general-purpose";
      const sessionKey = normalizeSessionKey(params.session_key) ?? createSessionKey();
      const label = normalizeSubagentLabel(params.label);
      if (!label) {
        throw new Error("Agent label must contain non-whitespace characters");
      }
      const display: AgentDisplayMetadata = {
        backend: getProfileBackend(profileName),
        profile: profileName,
      };
      const accepted = options.getTaskManager().start({
        taskType: "agent",
        label,
        sessionKey,
        run: async (signal, taskId) => {
          const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
          const profile = profiles.get(profileName);
          if (!profile) {
            throw new Error(`Unknown profile "${profileName}". Available profiles: ${formatProfileNames(profiles)}.`);
          }
          const model = resolveProfileModel(profile, ctx);
          if (usesPiBackend(profile) && !model) {
            throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");
          }

          options.queueSubagentStatus(ctx, {
            id: taskId,
            label,
            profile: profileName,
            backend: profile.backend,
            executionState: "queued",
            queuedAt: Date.now(),
          });
          try {
            return await state.sessionKeyLocks.run(sessionKey, async () => {
              const binding = getSessionKeyBinding(state, ctx, sessionKey);
              if (binding) {
                assertBindingMatchesProfile(binding, { profile: profileName, backend: profile.backend });
              }
              const release = await state.limiter.acquire(signal);
              try {
                options.startSubagentStatus(ctx, taskId);
                const spawned = await spawnSubagent({
                  toolCallId: taskId,
                  label,
                  prompt: params.prompt,
                  profile,
                  model,
                  thinkingLevel: profile.thinking ?? options.getThinkingLevel(),
                  ctx,
                  signal,
                  timeoutMs: options.getSubagentTimeoutMs(),
                  progressEnabled: ctx.hasUI,
                  onProgress: ctx.hasUI
                    ? (partial) => {
                        const progress = (partial.details as SubagentToolDetails).progress;
                        if (progress) {
                          options.updateSubagentProgress(ctx, taskId, progress.activityCount);
                        }
                      }
                    : undefined,
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
                    profile: profileName,
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
          } finally {
            options.finishTaskStatus(taskId);
          }
        },
      });
      options.rememberAgentDisplay(accepted.task_id, display);
      const result = taskToolResult(accepted);
      return {
        ...result,
        details: { ...accepted, display },
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
    renderResult(result, _options, theme) {
      const details = result.details as AgentAcceptedTaskUiDetails;
      return new Text(
        `${renderAgentIdentity(details.display, details.label, theme)} ${theme.fg("dim", `accepted ${details.task_id}`)}`,
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
    const pendingNotifications = new Map<string, TerminalTaskEnvelope>();
    const agentDisplayByTaskId = new Map<string, AgentDisplayMetadata>();
    let statusContext: ExtensionContext | undefined;
    let notificationSessionManager: SessionManager | undefined;
    const taskNotificationDetails = (envelope: TerminalTaskEnvelope): TaskNotificationUiDetails => {
      const display = envelope.task_type === "agent" ? agentDisplayByTaskId.get(envelope.task_id) : undefined;
      return display ? { ...envelope, display } : envelope;
    };
    const taskNotificationMessage = (envelope: TerminalTaskEnvelope) => ({
      customType: TASK_NOTIFICATION_CUSTOM_TYPE,
      content: JSON.stringify(envelope),
      display: true,
      details: taskNotificationDetails(envelope),
    });
    const persistTaskNotification = (sessionManager: SessionManager, envelope: TerminalTaskEnvelope) => {
      sessionManager.appendCustomMessageEntry(
        TASK_NOTIFICATION_CUSTOM_TYPE,
        JSON.stringify(envelope),
        true,
        taskNotificationDetails(envelope),
      );
    };
    const persistPendingNotifications = (sessionManager: SessionManager) => {
      for (const envelope of pendingNotifications.values()) {
        persistTaskNotification(sessionManager, envelope);
      }
      pendingNotifications.clear();
    };
    const createTaskManager = () => new BackgroundTaskManager({
      onTaskState: (event) => {
        pi.events.emit(TASK_STATE_EVENT, event);
      },
      notify: (envelope) => {
        statusState.activeSubagents.delete(envelope.task_id);
        statusState.activeWorkflows.delete(envelope.task_id);
        if (notificationSessionManager) {
          persistTaskNotification(notificationSessionManager, envelope);
          return;
        }
        pendingNotifications.set(envelope.task_id, envelope);
        pi.sendMessage(taskNotificationMessage(envelope), {
          deliverAs: "steer",
          triggerTurn: true,
        });
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
    const refreshStatus = (ctx: ExtensionContext) => {
      statusContext = ctx;
      publishFlowStatus(ctx, statusState);
    };
    const queueSubagentStatus = (ctx: ExtensionContext, subagent: QueuedSubagentStatus) => {
      statusState.activeSubagents.set(subagent.id, subagent);
      refreshStatus(ctx);
    };
    const startSubagentStatus = (ctx: ExtensionContext, taskId: string) => {
      const subagent = statusState.activeSubagents.get(taskId);
      if (subagent?.executionState === "queued") {
        statusState.activeSubagents.set(taskId, {
          ...subagent,
          executionState: "running",
          startedAt: Date.now(),
          eventCount: 0,
        });
      }
      refreshStatus(ctx);
    };
    const updateSubagentProgress = (ctx: ExtensionContext, taskId: string, eventCount: number) => {
      const subagent = statusState.activeSubagents.get(taskId);
      if (subagent?.executionState === "running") {
        subagent.eventCount = eventCount;
      }
      refreshStatus(ctx);
    };
    const startWorkflowStatus = (ctx: ExtensionContext, taskId: string, name: string) => {
      statusState.activeWorkflows.set(taskId, {
        id: taskId,
        name,
        startedAt: Date.now(),
        finishedSubagents: 0,
        totalSubagents: 0,
      });
      refreshStatus(ctx);
    };
    const queueWorkflowSubagent = (ctx: ExtensionContext, taskId: string) => {
      const workflow = statusState.activeWorkflows.get(taskId);
      if (workflow) {
        workflow.totalSubagents++;
      }
      refreshStatus(ctx);
    };
    const finishWorkflowSubagent = (ctx: ExtensionContext, taskId: string) => {
      const workflow = statusState.activeWorkflows.get(taskId);
      if (workflow) {
        workflow.finishedSubagents++;
      }
      refreshStatus(ctx);
    };
    const finishTaskStatus = (taskId: string) => {
      statusState.activeSubagents.delete(taskId);
      statusState.activeWorkflows.delete(taskId);
    };
    const updateStatus = (
      ctx: ExtensionContext,
      taskId: string,
      usage: SubagentUsage,
      telemetry: SubagentTelemetry,
    ) => {
      recordFlowUsage(statusState, taskId, usage, telemetry);
      refreshStatus(ctx);
    };

    pi.registerMessageRenderer<TaskNotificationUiDetails>(TASK_NOTIFICATION_CUSTOM_TYPE, (message, { expanded }, theme) => {
      const details = message.details as TaskNotificationUiDetails;
      return renderTaskNotification(details, expanded, theme);
    });
    pi.registerTool(createRunAgentTool(syncRuntimeOptions, {
      getTaskManager,
      getThinkingLevel: () => pi.getThinkingLevel(),
      getSubagentTimeoutMs: () => syncRuntimeOptions().subagentTimeoutMs,
      rememberAgentDisplay: (taskId, display) => agentDisplayByTaskId.set(taskId, display),
      queueSubagentStatus,
      startSubagentStatus,
      updateSubagentProgress,
      finishTaskStatus,
      updateStatus,
    }));
    if (workflowEnabled) {
      pi.registerTool(
        createRunWorkflowTool({
          getTaskManager,
          getLimiter: () => syncRuntimeOptions().limiter,
          getThinkingLevel: () => pi.getThinkingLevel(),
          getSubagentTimeoutMs: () => syncRuntimeOptions().subagentTimeoutMs,
          status: {
            start: startWorkflowStatus,
            queueSubagent: queueWorkflowSubagent,
            finishSubagent: finishWorkflowSubagent,
            refresh: refreshStatus,
            finish: finishTaskStatus,
          },
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
      agentDisplayByTaskId.clear();
      notificationSessionManager = undefined;
      statusContext = ctx;
      syncRuntimeOptions();
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      statusState.calls.clear();
      clearActiveFlowTasks(statusState);
      statusState.tasks = getTaskManager().getCounts();
      if (ctx.hasUI) {
        ctx.ui.setStatus(FLOW_STATUS_KEY, undefined);
        ctx.ui.setWidget(FLOW_STATUS_KEY, undefined);
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
        const taskId = String(event.message.details.task_id);
        pendingNotifications.delete(taskId);
        agentDisplayByTaskId.delete(taskId);
      }
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
      agentDisplayByTaskId.clear();
      statusContext = ctx;
      rootState.sessionBindings.clear();
      rootState.sessionKeyLocks = new SessionKeyLocks();
      statusState.calls.clear();
      clearActiveFlowTasks(statusState);
      statusState.tasks = taskManager.getCounts();
      publishFlowStatus(ctx, statusState);
    });

    pi.on("agent_end", async (_event, ctx) => {
      if (ctx.mode === "print" || ctx.mode === "json") {
        await getTaskManager().waitForIdle();
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
      clearActiveFlowTasks(statusState);
      agentDisplayByTaskId.clear();
      if (ctx.hasUI) {
        ctx.ui.setStatus(FLOW_STATUS_KEY, undefined);
        ctx.ui.setWidget(FLOW_STATUS_KEY, undefined);
      }
      statusContext = undefined;
    });

    pi.on("before_agent_start", (event, ctx) => {
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
