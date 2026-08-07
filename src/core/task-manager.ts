export interface AgentTerminalTaskEnvelope {
  task_type: "agent";
  status: "completed" | "failed";
  session_key: string;
  label: string;
  content: string;
}

export interface WorkflowTerminalTaskEnvelope {
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
  abortReason?: string;
}

interface ActiveTask {
  controller: AbortController;
  completed: Promise<void>;
}

export class SynchronousTaskManager {
  private readonly active = new Set<ActiveTask>();
  private closed = false;

  async run<T>(options: {
    signal?: AbortSignal;
    execute: (signal: AbortSignal) => Promise<SynchronousTaskOutcome<T>>;
  }): Promise<SynchronousTaskResult<T>> {
    if (this.closed) {
      throw new Error("Cannot start a pi-flow task after session shutdown");
    }

    const controller = new AbortController();
    const signal = AbortSignal.any(
      [options.signal, controller.signal].filter((candidate): candidate is AbortSignal => Boolean(candidate)),
    );
    let complete!: () => void;
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const task = { controller, completed };
    this.active.add(task);

    try {
      const outcome = await options.execute(signal);
      return {
        status: signal.aborted ? "failed" : outcome.status,
        value: outcome.value,
        ...(signal.aborted ? { abortReason: errorMessage(signal.reason) } : {}),
      };
    } finally {
      this.active.delete(task);
      complete();
    }
  }

  hasActiveTasks(): boolean {
    return this.active.size > 0;
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
}

export function taskEnvelopeContent(envelope: TerminalTaskEnvelope) {
  return [{ type: "text" as const, text: JSON.stringify(envelope) }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
