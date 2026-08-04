import { randomUUID } from "node:crypto";

export const TASK_NOTIFICATION_CUSTOM_TYPE = "pi-flow-task-notification-v2";
export const TASK_STATE_EVENT = "pi-flow:task-state";

export type TaskType = "subagent" | "workflow";
export type PublicTaskStatus = "accepted" | "completed" | "failed";

export interface TaskStateEvent {
  version: 2;
  task_id: string;
  task_type: TaskType;
  status: PublicTaskStatus;
}

interface TaskEnvelopeBase {
  task_id: string;
  task_type: TaskType;
  status: PublicTaskStatus;
}

export interface SubagentAcceptedTaskEnvelope extends TaskEnvelopeBase {
  task_type: "subagent";
  status: "accepted";
  session_key: string;
  label: string;
}

export interface WorkflowAcceptedTaskEnvelope extends TaskEnvelopeBase {
  task_type: "workflow";
  status: "accepted";
  name: string;
}

export interface SubagentTerminalTaskEnvelope extends TaskEnvelopeBase {
  task_type: "subagent";
  status: "completed" | "failed";
  session_key: string;
  label: string;
  content: string;
}

export interface WorkflowTerminalTaskEnvelope extends TaskEnvelopeBase {
  task_type: "workflow";
  status: "completed" | "failed";
  name: string;
  content: string;
}

export type AcceptedTaskEnvelope = SubagentAcceptedTaskEnvelope | WorkflowAcceptedTaskEnvelope;
export type TerminalTaskEnvelope = SubagentTerminalTaskEnvelope | WorkflowTerminalTaskEnvelope;
export type TaskEnvelope = AcceptedTaskEnvelope | TerminalTaskEnvelope;

export interface TaskCounts {
  subagent: { finished: number; total: number };
  workflow: { finished: number; total: number };
}

type SubagentTaskOptions = {
  taskType: "subagent";
  label: string;
  sessionKey: string;
  run: (signal: AbortSignal, taskId: string) => Promise<string>;
};

type WorkflowTaskOptions = {
  taskType: "workflow";
  name: string;
  run: (signal: AbortSignal, taskId: string) => Promise<string>;
};

type StartTaskOptions = SubagentTaskOptions | WorkflowTaskOptions;

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
    subagent: { finished: 0, total: 0 },
    workflow: { finished: 0, total: 0 },
  };
  private closed = false;

  constructor(private readonly options: BackgroundTaskManagerOptions) {}

  start(options: SubagentTaskOptions): SubagentAcceptedTaskEnvelope;
  start(options: WorkflowTaskOptions): WorkflowAcceptedTaskEnvelope;
  start(options: StartTaskOptions): AcceptedTaskEnvelope {
    if (this.closed) {
      throw new Error("Cannot start a pi-flow task after session shutdown");
    }

    const taskId = `task_${randomUUID().replace(/-/g, "")}`;
    const controller = new AbortController();
    const accepted = options.taskType === "subagent"
      ? {
          task_id: taskId,
          task_type: "subagent" as const,
          status: "accepted" as const,
          session_key: options.sessionKey,
          label: options.label,
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
    value: string,
  ): void {
    const terminalStatus = signal.aborted ? "failed" : status;
    const content = signal.aborted ? errorMessage(signal.reason) : value;
    const envelope: TerminalTaskEnvelope = options.taskType === "subagent"
      ? {
          task_id: accepted.task_id,
          task_type: "subagent",
          status: terminalStatus,
          session_key: options.sessionKey,
          label: options.label,
          content,
        }
      : {
          task_id: accepted.task_id,
          task_type: "workflow",
          status: terminalStatus,
          name: options.name,
          content,
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
        version: 2,
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
    subagent: { ...counts.subagent },
    workflow: { ...counts.workflow },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
