import { randomUUID } from "node:crypto";

export const TASK_STATE_EVENT = "pi-flow:task-state";

export type TaskType = "agent" | "workflow";
export type PublicTaskStatus = "accepted" | "completed" | "failed";

export interface TaskStateEvent {
  version: 1;
  task_id: string;
  task_type: TaskType;
  status: PublicTaskStatus;
}

export interface AgentTerminalTaskEnvelope {
  task_id: string;
  task_type: "agent";
  status: "completed" | "failed";
  session_key: string;
  label: string;
  content: string;
}

export interface WorkflowTerminalTaskEnvelope {
  task_id: string;
  task_type: "workflow";
  status: "completed" | "failed";
  name: string;
  content: string;
}

export type TerminalTaskEnvelope = AgentTerminalTaskEnvelope | WorkflowTerminalTaskEnvelope;

export interface SynchronousTaskOutcome<T> {
  status: "completed" | "failed";
  value: T;
}

export interface SynchronousTaskResult<T> extends SynchronousTaskOutcome<T> {
  taskId: string;
  abortReason?: string;
}

export interface SynchronousTaskManagerOptions {
  onTaskState?: (event: TaskStateEvent) => void;
}

interface ActiveTask {
  controller: AbortController;
  completed: Promise<void>;
}

export class SynchronousTaskManager {
  private readonly active = new Map<string, ActiveTask>();
  private closed = false;

  constructor(private readonly options: SynchronousTaskManagerOptions = {}) {}

  async run<T>(options: {
    taskType: TaskType;
    signal?: AbortSignal;
    execute: (signal: AbortSignal, taskId: string) => Promise<SynchronousTaskOutcome<T>>;
  }): Promise<SynchronousTaskResult<T>> {
    if (this.closed) {
      throw new Error("Cannot start a pi-flow task after session shutdown");
    }

    const taskId = `task_${randomUUID().replace(/-/g, "")}`;
    const controller = new AbortController();
    const signal = AbortSignal.any(
      [options.signal, controller.signal].filter((candidate): candidate is AbortSignal => Boolean(candidate)),
    );
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.active.set(taskId, { controller, completed });
    this.publishTaskState(taskId, options.taskType, "accepted");

    let terminalStatus: "completed" | "failed" = "failed";
    try {
      const outcome = await options.execute(signal, taskId);
      terminalStatus = signal.aborted ? "failed" : outcome.status;
      return {
        taskId,
        status: terminalStatus,
        value: outcome.value,
        ...(signal.aborted ? { abortReason: errorMessage(signal.reason) } : {}),
      };
    } finally {
      this.active.delete(taskId);
      complete();
      this.publishTaskState(taskId, options.taskType, terminalStatus);
    }
  }

  hasActiveTasks(): boolean {
    return this.active.size > 0;
  }

  isActive(taskId: string): boolean {
    return this.active.has(taskId);
  }

  async waitForIdle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.all([...this.active.values()].map((task) => task.completed));
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

  private publishTaskState(taskId: string, taskType: TaskType, status: PublicTaskStatus): void {
    try {
      this.options.onTaskState?.({
        version: 1,
        task_id: taskId,
        task_type: taskType,
        status,
      });
    } catch {
      return;
    }
  }
}

export function taskEnvelopeContent(envelope: TerminalTaskEnvelope) {
  return [{ type: "text" as const, text: JSON.stringify(envelope) }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
