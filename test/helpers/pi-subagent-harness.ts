import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type Context,
  type FauxProviderHandle,
  type Model,
  type MutableModels,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach } from "vitest";
import { createSubagentExtension } from "../../src/pi-subagent.ts";

export const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export type FauxModelDef = { id: string; name: string; reasoning: boolean };
export type TestFauxProvider = FauxProviderHandle & { unregister: () => void };
export type TaskEnvelope = {
  task_id: string;
  task_type: "agent" | "workflow";
  status: "accepted" | "completed" | "failed";
  name: string;
  session_key?: string;
  content?: string;
};
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type CreateSessionOptions = {
  maxConcurrentSubagents?: number;
  maxConcurrentSubagentsFlag?: string;
  subagentTimeoutMs?: number;
  subagentTimeoutMsFlag?: string;
  models?: FauxModelDef[];
  defaultModelId?: string;
  thinkingLevel?: ThinkingLevel;
  systemPrompt?: string;
  mode?: "tui" | "rpc" | "json" | "print";
};

export type HarnessState = {
  tempDir: string;
  cwd: string;
  agentDir: string;
  originalPathEnv: string | undefined;
  registrations: Array<{ unregister: () => void }>;
  sessions: Array<{ dispose: () => void }>;
};

const DEFAULT_MODEL_DEFS: FauxModelDef[] = [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }];

export function installFauxProvider(
  modelRegistry: ModelRegistry,
  faux: FauxProviderHandle,
): TestFauxProvider {
  const models: MutableModels = createModels();
  models.setProvider(faux.provider);
  modelRegistry.registerProvider(faux.provider.id, {
    api: faux.api,
    streamSimple: (model, context, streamOptions) => models.streamSimple(model, context, streamOptions),
  });
  return Object.assign(faux, {
    unregister: () => {
      modelRegistry.unregisterProvider(faux.provider.id);
      models.deleteProvider(faux.provider.id);
    },
  });
}

export function setupPiSubagentTestHarness(onSetup?: (state: HarnessState) => void) {
  let tempDir = "";
  let cwd = "";
  let agentDir = "";
  let registrations: Array<{ unregister: () => void }> = [];
  let sessions: Array<{ dispose: () => void }> = [];
  let originalAgentDirEnv: string | undefined;
  let originalPathEnv: string | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `pi-subagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(tempDir, "project");
    agentDir = join(tempDir, "agent");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
    originalPathEnv = process.env.PATH;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    registrations = [];
    sessions = [];
    onSetup?.({ tempDir, cwd, agentDir, originalPathEnv, registrations, sessions });
  });

  afterEach(() => {
    for (const session of sessions.splice(0)) {
      session.dispose();
    }
    for (const registration of registrations.splice(0)) {
      registration.unregister();
    }
    if (originalAgentDirEnv === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
    }
    if (originalPathEnv === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPathEnv;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function trackSession<T extends { dispose: () => void }>(session: T): T {
    sessions.push(session);
    return session;
  }

  function disposeSession(session: { dispose: () => void }): void {
    const index = sessions.indexOf(session);
    if (index !== -1) {
      sessions.splice(index, 1);
    }
    session.dispose();
  }

  function writeModelsJson(models: Array<Model<string>>) {
    if (models.length === 0) {
      return;
    }
    const toModelDef = (m: Model<string>) => ({
      id: m.id,
      name: m.name,
      api: m.api,
      baseUrl: m.baseUrl,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    });
    const provider = models[0].provider;
    const config = {
      providers: {
        [provider]: {
          apiKey: "test-api-key",
          api: models[0].api,
          baseUrl: models[0].baseUrl,
          models: models.map(toModelDef),
        },
      },
    };
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(config, null, 2));
  }

  async function createSession(options: CreateSessionOptions = {}) {
    const {
      maxConcurrentSubagents,
      maxConcurrentSubagentsFlag,
      subagentTimeoutMs,
      subagentTimeoutMsFlag,
      models: modelDefs = DEFAULT_MODEL_DEFS,
      defaultModelId,
      thinkingLevel = "high",
      systemPrompt,
      mode = "tui",
    } = options;
    const faux = fauxProvider({ models: modelDefs });
    const models = modelDefs.map((def) => faux.getModel(def.id) as Model<string>);
    const model = defaultModelId ? (faux.getModel(defaultModelId) as Model<string>) : models[0];

    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    authStorage.setRuntimeApiKey(model.provider, "test-api-key");
    writeModelsJson(models);
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const registration = installFauxProvider(modelRegistry, faux);
    registrations.push(registration);
    const settingsManager = SettingsManager.inMemory({});
    const sessionManager = SessionManager.inMemory(cwd);
    const extensionOptions = {
      ...(maxConcurrentSubagents === undefined ? {} : { maxConcurrentSubagents }),
      ...(subagentTimeoutMs === undefined ? {} : { subagentTimeoutMs }),
    };
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      extensionFactories: [createSubagentExtension(extensionOptions)],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
    });
    await resourceLoader.reload();
    if (maxConcurrentSubagentsFlag !== undefined) {
      resourceLoader.getExtensions().runtime.flagValues.set("max-concurrent-subagents", maxConcurrentSubagentsFlag);
    }
    if (subagentTimeoutMsFlag !== undefined) {
      resourceLoader.getExtensions().runtime.flagValues.set("subagent-timeout-ms", subagentTimeoutMsFlag);
    }

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      thinkingLevel,
      settingsManager,
      sessionManager,
      resourceLoader,
    });
    trackSession(session);
    await session.bindExtensions({ mode });

    return { session, registration, model, models, modelRegistry, sessionManager };
  }

  function setContextRoutingResponses(
    registration: FauxProviderHandle,
    response: (context: Context, options: SimpleStreamOptions, model: Model<string>) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
    count = 32,
  ): void {
    registration.setResponses(Array.from({ length: count }, () =>
      (context: Context, options: SimpleStreamOptions | undefined, _state: unknown, model: Model<string>) =>
        response(context, options ?? {}, model),
    ));
  }

  function taskNotifications(session: { messages: readonly unknown[] }, taskId?: string): TaskEnvelope[] {
    return session.messages
      .filter((message): message is { role: string; customType?: string; details?: unknown } =>
        typeof message === "object" && message !== null && "role" in message)
      .filter((message) => message.role === "custom" && message.customType === "pi-flow-task-notification")
      .map((message) => message.details as TaskEnvelope)
      .filter((envelope) => taskId === undefined || envelope.task_id === taskId);
  }

  async function waitForTaskNotification(
    session: { messages: readonly unknown[] },
    taskId: string,
    timeoutMs = 3000,
  ): Promise<TaskEnvelope> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const notification = taskNotifications(session, taskId)[0];
      if (notification) {
        return notification;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for task notification ${taskId}`);
  }

  async function executeAgentTask(
    session: { getToolDefinition: (name: string) => unknown; messages: readonly unknown[] },
    registration: FauxProviderHandle,
    context: unknown,
    toolArgs: Record<string, unknown>,
    childResponse: (context: Context, options: SimpleStreamOptions, model: Model<string>) => ReturnType<typeof fauxAssistantMessage> | Promise<ReturnType<typeof fauxAssistantMessage>>,
  ) {
    setContextRoutingResponses(registration, (providerContext, options, model) => {
      if (getToolNames(providerContext).includes("Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      return childResponse(providerContext, options, model);
    });
    const tool = session.getToolDefinition("Agent") as {
      execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details: TaskEnvelope }>;
    };
    const accepted = await tool.execute("agent-test-call", toolArgs, undefined, undefined, context);
    const terminal = await waitForTaskNotification(session, accepted.details.task_id);
    return { accepted, terminal };
  }

  async function delegateOnce(
    session: { prompt: (input: string) => Promise<unknown>; messages: readonly unknown[] },
    registration: FauxProviderHandle,
    toolArgs: Record<string, unknown>,
    opts: { childReply?: string; rootReply?: string; userPrompt?: string } = {},
  ) {
    const { childReply = "child done", rootReply = "reported", userPrompt = "Please delegate." } = opts;
    const captured: {
      childContext?: Context;
      childOptions?: SimpleStreamOptions;
      childModel?: Model<string>;
      rootContinuationContext?: Context;
    } = {};
    setContextRoutingResponses(registration, (context, options, model) => {
      if (!getToolNames(context).includes("Agent")) {
        captured.childContext = context;
        captured.childOptions = options;
        captured.childModel = model;
        return fauxAssistantMessage(childReply);
      }
      const serialized = JSON.stringify(context.messages);
      if (!serialized.includes('"toolName":"Agent"') && !serialized.includes("pi-flow-task-notification")) {
        return fauxAssistantMessage([fauxToolCall("Agent", toolArgs)], { stopReason: "toolUse" });
      }
      captured.rootContinuationContext = context;
      return fauxAssistantMessage(rootReply);
    });
    await session.prompt(userPrompt);
    const accepted = session.messages.find((message: any) =>
      message.role === "toolResult" && message.toolName === "Agent") as { details?: TaskEnvelope } | undefined;
    if (accepted?.details?.task_id) {
      await waitForTaskNotification(session, accepted.details.task_id);
    }
    return captured;
  }

  function makeMockTheme() {
    const theme = Object.create(Theme.prototype) as Theme;
    theme.fg = (_color, text) => text;
    theme.bold = (text) => text;
    return theme;
  }

  function stripAnsi(s: string) {
    return s.replace(/\x1b\[[0-9;]*m/g, "");
  }

  function renderToText(component: { render: (width: number) => string[] }) {
    return stripAnsi(component.render(200).join("\n"));
  }

  function formatTestTokens(count: number) {
    if (count < 1000) {
      return count.toString();
    }
    if (count < 10000) {
      return `${(count / 1000).toFixed(1)}k`;
    }
    if (count < 1000000) {
      return `${Math.round(count / 1000)}k`;
    }
    if (count < 10000000) {
      return `${(count / 1000000).toFixed(1)}M`;
    }
    return `${Math.round(count / 1000000)}M`;
  }

  function makeExecutionContext({
    hasUI,
    model,
    modelRegistry,
    tui = false,
    onStatus,
    projectTrusted = false,
    persistedSession = false,
    sessionManager,
  }: {
    hasUI: boolean;
    model: Model<string>;
    modelRegistry: ModelRegistry;
    tui?: boolean;
    onStatus?: (key: string, text: string | undefined) => void;
    projectTrusted?: boolean;
    persistedSession?: boolean;
    sessionManager?: SessionManager;
  }) {
    const theme = makeMockTheme();
    const sessionDir = join(tempDir, "sessions");
    return {
      hasUI,
      cwd,
      model,
      modelRegistry,
      sessionManager: sessionManager ?? (persistedSession
        ? {
            isPersisted: () => true,
            getSessionFile: () => join(sessionDir, "session.jsonl"),
            getSessionDir: () => sessionDir,
            getSessionId: () => "test-session",
          }
        : undefined),
      isProjectTrusted: () => projectTrusted,
      ui: {
        getAllThemes: () => (tui ? [{ name: "test", path: "test-theme.json" }] : []),
        setStatus: (key: string, text: string | undefined) => onStatus?.(key, text),
        theme,
      },
    };
  }

  function getToolNames(context: Context | undefined): string[] {
    return [...new Set((context?.tools ?? [])
      .map((tool: { name?: string } | undefined) => tool?.name)
      .filter((name): name is string => typeof name === "string"))].sort();
  }

  return {
    trackSession,
    disposeSession,
    createSession,
    setContextRoutingResponses,
    taskNotifications,
    waitForTaskNotification,
    executeAgentTask,
    delegateOnce,
    makeMockTheme,
    stripAnsi,
    renderToText,
    formatTestTokens,
    makeExecutionContext,
    getToolNames,
  };
}
