import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { hashStableValue } from "./replay-cache.ts";
import type { WorkflowAgentResultEvent, WorkflowCachedAgentResult } from "./types.ts";

const JOURNAL_VERSION = 2;
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

interface WorkflowSessionManagerLike {
  isPersisted?: () => boolean;
  getSessionFile?: () => string | undefined;
  getSessionDir?: () => string | undefined;
  getSessionId?: () => string | undefined;
}

export interface WorkflowSessionContextLike {
  sessionManager?: WorkflowSessionManagerLike;
}

export interface WorkflowTaskIdentity {
  taskId: string;
  scriptHash: string;
  argsHash: string;
}

export interface LoadedWorkflowJournal {
  taskId: string;
  path: string;
  name?: string;
  source?: string;
  scriptPath?: string;
  scriptHash?: string;
  status: "running" | "completed" | "failed";
  logs: string[];
  agentResults: WorkflowCachedAgentResult[];
}

export interface WorkflowJournalWriter {
  taskId: string;
  path: string;
  appendLog(message: string): Promise<void>;
  appendAgentResult(event: WorkflowAgentResultEvent): Promise<void>;
  complete(result: unknown): Promise<void>;
  fail(error: string): Promise<void>;
}

export function getSessionWorkflowDir(ctx: WorkflowSessionContextLike): string | undefined {
  const manager = ctx.sessionManager;
  if (!manager || manager.isPersisted?.() === false) {
    return undefined;
  }
  const sessionFile = manager.getSessionFile?.();
  if (sessionFile) {
    return join(dirname(sessionFile), `${basename(sessionFile, extname(sessionFile))}.workflows`);
  }
  const sessionDir = manager.getSessionDir?.();
  const sessionId = manager.getSessionId?.();
  if (!sessionDir || !sessionId) {
    return undefined;
  }
  return join(sessionDir, `${safeFilePart(sessionId)}.workflows`);
}

export function createWorkflowTaskIdentity(taskId: string, script: string, args: unknown): WorkflowTaskIdentity {
  return {
    taskId,
    scriptHash: hashStableValue(script),
    argsHash: hashStableValue(args ?? null),
  };
}

export async function persistWorkflowScript(params: {
  dir: string;
  metaName: string;
  scriptHash: string;
  script: string;
}): Promise<string> {
  await mkdir(params.dir, { recursive: true });
  const path = join(params.dir, `${safeFilePart(params.metaName)}-${params.scriptHash.slice(0, 12)}.js`);
  try {
    await writeFile(path, params.script, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) {
      throw error;
    }
    const existing = await readFile(path, "utf8");
    if (existing !== params.script) {
      throw new Error(`Persisted workflow script does not match ${params.scriptHash}`);
    }
  }
  return path;
}

export async function loadWorkflowJournal(dir: string, taskId: string): Promise<LoadedWorkflowJournal | undefined> {
  if (!SAFE_ID.test(taskId)) {
    throw new Error(`Invalid workflow task id: ${taskId}`);
  }
  const path = workflowJournalPath(dir, taskId);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }

  const agentResults: WorkflowCachedAgentResult[] = [];
  const logs: string[] = [];
  let seenTaskStart = false;
  let name: string | undefined;
  let source: string | undefined;
  let scriptPath: string | undefined;
  let scriptHash: string | undefined;
  let status: LoadedWorkflowJournal["status"] = "running";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      break;
    }
    if (entry.type === "task_start") {
      seenTaskStart = entry.taskId === taskId;
      name = typeof entry.name === "string" ? entry.name : undefined;
      source = typeof entry.source === "string" ? entry.source : undefined;
      scriptPath = typeof entry.scriptPath === "string" ? entry.scriptPath : undefined;
      scriptHash = typeof entry.scriptHash === "string" ? entry.scriptHash : undefined;
      continue;
    }
    if (entry.type === "task_complete") {
      status = "completed";
      continue;
    }
    if (entry.type === "task_error") {
      status = "failed";
      continue;
    }
    if (entry.type === "task_log") {
      if (typeof entry.message === "string") {
        logs.push(entry.message);
      }
      continue;
    }
    if (entry.type !== "agent_result") {
      continue;
    }
    const index = entry.index;
    const fingerprint = entry.fingerprint;
    if (typeof index !== "number" || typeof fingerprint !== "string") {
      continue;
    }
    agentResults[index - 1] = {
      index,
      fingerprint,
      result: entry.result,
      failed: entry.failed === true,
      error: typeof entry.error === "string" ? entry.error : undefined,
      sessionKey: typeof entry.sessionKey === "string" ? entry.sessionKey : undefined,
      sessionId: typeof entry.sessionId === "string" ? entry.sessionId : undefined,
      subagentType: typeof entry.subagentType === "string" ? entry.subagentType : undefined,
      backend: typeof entry.backend === "string" ? entry.backend : undefined,
    };
  }

  if (!seenTaskStart) {
    throw new Error(`Workflow journal does not match task id ${taskId}`);
  }
  return { taskId, path, name, source, scriptPath, scriptHash, status, logs, agentResults };
}

export async function createWorkflowJournalWriter(params: {
  dir: string;
  identity: WorkflowTaskIdentity;
  name: string;
  source: string;
  scriptPath?: string;
  resumeFromTaskId?: string;
}): Promise<WorkflowJournalWriter> {
  await mkdir(params.dir, { recursive: true });
  const path = workflowJournalPath(params.dir, params.identity.taskId);
  await writeFile(
    path,
    `${JSON.stringify({
      type: "task_start",
      version: JOURNAL_VERSION,
      taskId: params.identity.taskId,
      name: params.name,
      source: params.source,
      scriptPath: params.scriptPath,
      resumeFromTaskId: params.resumeFromTaskId,
      scriptHash: params.identity.scriptHash,
      argsHash: params.identity.argsHash,
    })}\n`,
    "utf8",
  );

  let appendQueue = Promise.resolve();
  const enqueueAppend = (value: unknown) => {
    const next = appendQueue.then(() => appendJsonLine(path, value));
    appendQueue = next.catch(() => {});
    return next;
  };

  return {
    taskId: params.identity.taskId,
    path,
    appendLog: async (message) => {
      await enqueueAppend({ type: "task_log", message });
    },
    appendAgentResult: async (event) => {
      await enqueueAppend({
        type: "agent_result",
        index: event.index,
        fingerprint: event.fingerprint,
        label: event.label,
        phase: event.phase,
        subagentType: event.subagentType,
        backend: event.backend,
        sessionKey: event.sessionKey,
        sessionId: event.sessionId,
        prompt: event.prompt,
        schema: event.schema,
        cached: event.cached,
        failed: event.failed === true,
        error: event.error,
        result: event.result,
      });
    },
    complete: async (result) => {
      await enqueueAppend({ type: "task_complete", result });
    },
    fail: async (error) => {
      await enqueueAppend({ type: "task_error", error });
    },
  };
}

function workflowJournalPath(dir: string, taskId: string): string {
  return join(dir, `task-${taskId}.jsonl`);
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

function safeFilePart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}
