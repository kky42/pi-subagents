import { randomUUID } from "node:crypto";

export const TASK_NOTIFICATION_CUSTOM_TYPE = "pi-flow-task-notification";

export type TaskType = "agent" | "workflow";
export type PublicTaskStatus = "accepted" | "completed" | "failed";

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
        (result) => this.finish(options, accepted, "completed", result),
        (error) => this.finish(options, accepted, "failed", errorMessage(error)),
      )
      .finally(() => {
        this.active.delete(taskId);
      });

    this.active.set(taskId, { controller, promise });
    this.publishCounts();
    return accepted;
  }

  getCounts(): TaskCounts {
    return cloneCounts(this.counts);
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((task) => task.promise));
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      await this.waitForIdle();
      return;
    }
    this.closed = true;
    for (const task of this.active.values()) {
      task.controller.abort(new Error("Pi session shut down"));
    }
    await this.waitForIdle();
  }

  private finish(
    options: StartTaskOptions,
    accepted: AcceptedTaskEnvelope,
    status: "completed" | "failed",
    value: string | TaskRunResult,
  ): void {
    const result = typeof value === "string" ? { content: value } : value;
    const name = result.name ?? accepted.name;
    const envelope: TerminalTaskEnvelope = options.taskType === "agent"
      ? {
          task_id: accepted.task_id,
          task_type: "agent",
          status,
          session_key: options.sessionKey,
          name,
          content: result.content,
        }
      : {
          task_id: accepted.task_id,
          task_type: "workflow",
          status,
          name,
          content: result.content,
        };

    this.counts[options.taskType].finished++;
    this.publishCounts();
    if (this.closed) {
      return;
    }
    try {
      this.options.notify(envelope);
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
