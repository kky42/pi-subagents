import { randomUUID } from "node:crypto";

export const TASK_NOTIFICATION_CUSTOM_TYPE = "pi-flow-task-notification";
export const TASK_STATE_EVENT = "pi-flow:task-state";

export type TaskType = "agent" | "workflow";
export type PublicTaskStatus = "accepted" | "completed" | "failed";

export interface TaskStateEvent {
  version: 1;
  task_id: string;
  task_type: TaskType;
  status: PublicTaskStatus;
}

interface TaskEnvelopeBase {
  task_id: string;
  task_type: TaskType;
  status: PublicTaskStatus;
  name: string;
}

export interface AgentAcceptedTaskEnvelope extends TaskEnvelopeBase {
  task_type: "agent";
  status: "accepted";
  session_key: string;
}

export interface WorkflowAcceptedTaskEnvelope extends TaskEnvelopeBase {
  task_type: "workflow";
  status: "accepted";
}

export interface AgentTerminalTaskEnvelope extends TaskEnvelopeBase {
  task_type: "agent";
  status: "completed" | "failed";
  session_key: string;
  content: string;
}

export interface WorkflowTerminalTaskEnvelope extends TaskEnvelopeBase {
  task_type: "workflow";
  status: "completed" | "failed";
  content: string;
}

export type AcceptedTaskEnvelope = AgentAcceptedTaskEnvelope | WorkflowAcceptedTaskEnvelope;
export type TerminalTaskEnvelope = AgentTerminalTaskEnvelope | WorkflowTerminalTaskEnvelope;
export type TaskEnvelope = AcceptedTaskEnvelope | TerminalTaskEnvelope;

export interface TaskCounts {
  agent: { finished: number; total: number };
  workflow: { finished: number; total: number };
}

export interface TaskRunResult {
  content: string;
  name?: string;
}

type AgentTaskOptions = {
  taskType: "agent";
  name: string;
  sessionKey: string;
  run: (signal: AbortSignal, taskId: string) => Promise<string | TaskRunResult>;
};

type WorkflowTaskOptions = {
  taskType: "workflow";
  name: string;
  run: (signal: AbortSignal, taskId: string) => Promise<string | TaskRunResult>;
};

type StartTaskOptions = AgentTaskOptions | WorkflowTaskOptions;

export interface BackgroundTaskManagerOptions {
  notify: (envelope: TerminalTaskEnvelope) => void;
  onCountsChange?: (counts: TaskCounts) => void;
  onTaskState?: (event: TaskStateEvent) => void;
}

interface ActiveTask {
  controller: AbortController;
  promise: Promise<void>;
}

export class BackgroundTaskManager {
  private readonly active = new Map<string, ActiveTask>();
  private readonly counts: TaskCounts = {
    agent: { finished: 0, total: 0 },
    workflow: { finished: 0, total: 0 },
  };
  private closed = false;

  constructor(private readonly options: BackgroundTaskManagerOptions) {}

  start(options: AgentTaskOptions): AgentAcceptedTaskEnvelope;
  start(options: WorkflowTaskOptions): WorkflowAcceptedTaskEnvelope;
  start(options: StartTaskOptions): AcceptedTaskEnvelope {
    if (this.closed) {
      throw new Error("Cannot start a pi-flow task after session shutdown");
    }

    const taskId = `task_${randomUUID().replace(/-/g, "")}`;
    const controller = new AbortController();
    const accepted = options.taskType === "agent"
      ? {
          task_id: taskId,
          task_type: "agent" as const,
          status: "accepted" as const,
          session_key: options.sessionKey,
          name: options.name,
        }
      : {
          task_id: taskId,
          task_type: "workflow" as const,
          status: "accepted" as const,
          name: options.name,
        };

    this.counts[options.taskType].total++;
    const promise = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => {
        controller.signal.throwIfAborted();
        return options.run(controller.signal, taskId);
      })
      .then(
        (result) => this.finish(options, accepted, controller.signal, "completed", result),
        (error) => this.finish(options, accepted, controller.signal, "failed", errorMessage(error)),
      )
      .finally(() => {
        this.active.delete(taskId);
      });

    this.active.set(taskId, { controller, promise });
    this.publishCounts();
    this.publishTaskState(accepted);
    return accepted;
  }

  getCounts(): TaskCounts {
    return cloneCounts(this.counts);
  }

  hasActiveTasks(): boolean {
    return this.active.size > 0;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((task) => task.promise));
    }
  }

  async abortAll(reason: string): Promise<void> {
    for (const task of this.active.values()) {
      task.controller.abort(new Error(reason));
    }
    await this.waitForIdle();
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.waitForIdle();
      return;
    }
    this.closed = true;
    await this.abortAll("Pi session shut down");
  }

  private finish(
    options: StartTaskOptions,
    accepted: AcceptedTaskEnvelope,
    signal: AbortSignal,
    status: "completed" | "failed",
    value: string | TaskRunResult,
  ): void {
    const terminalStatus = signal.aborted ? "failed" : status;
    const terminalValue = signal.aborted ? errorMessage(signal.reason) : value;
    const result = typeof terminalValue === "string" ? { content: terminalValue } : terminalValue;
    const name = result.name ?? accepted.name;
    const envelope: TerminalTaskEnvelope = options.taskType === "agent"
      ? {
          task_id: accepted.task_id,
          task_type: "agent",
          status: terminalStatus,
          session_key: options.sessionKey,
          name,
          content: result.content,
        }
      : {
          task_id: accepted.task_id,
          task_type: "workflow",
          status: terminalStatus,
          name,
          content: result.content,
        };

    this.counts[options.taskType].finished++;
    this.publishCounts();
    this.publishTaskState(envelope);
    try {
      this.options.notify(envelope);
    } catch {
      return;
    }
  }

  private publishTaskState(envelope: TaskEnvelope): void {
    try {
      this.options.onTaskState?.({
        version: 1,
        task_id: envelope.task_id,
        task_type: envelope.task_type,
        status: envelope.status,
      });
    } catch {
      return;
    }
  }

  private publishCounts(): void {
    try {
      this.options.onCountsChange?.(cloneCounts(this.counts));
    } catch {
      return;
    }
  }
}

export function taskToolResult<T extends TaskEnvelope>(envelope: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    details: envelope,
  };
}

function cloneCounts(counts: TaskCounts): TaskCounts {
  return {
    agent: { ...counts.agent },
    workflow: { ...counts.workflow },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
