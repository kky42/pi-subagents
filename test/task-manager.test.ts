import { describe, expect, it } from "vitest";
import {
  BackgroundTaskManager,
  taskToolResult,
  type TaskStateEvent,
  type TerminalTaskEnvelope,
} from "../src/core/task-manager.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("BackgroundTaskManager", () => {
  it("returns a compact Agent acceptance before completion and correlates the terminal notification", async () => {
    const run = deferred<string>();
    const notifications: TerminalTaskEnvelope[] = [];
    const manager = new BackgroundTaskManager({ notify: (envelope) => notifications.push(envelope) });

    const accepted = manager.start({
      taskType: "agent",
      label: "inspect auth",
      sessionKey: "worker",
      run: () => run.promise,
    });

    expect(accepted).toEqual({
      task_id: expect.stringMatching(/^task_[a-f0-9]{32}$/),
      task_type: "agent",
      status: "accepted",
      session_key: "worker",
      label: "inspect auth",
    });
    expect(notifications).toEqual([]);
    expect(manager.getCounts()).toEqual({
      agent: { finished: 0, total: 1 },
      workflow: { finished: 0, total: 0 },
    });

    run.resolve("auth result");
    await manager.waitForIdle();

    expect(notifications).toEqual([{
      task_id: accepted.task_id,
      task_type: "agent",
      status: "completed",
      session_key: "worker",
      label: "inspect auth",
      content: "auth result",
    }]);
    expect(manager.getCounts().agent).toEqual({ finished: 1, total: 1 });
  });

  it("publishes accepted and terminal task states around notification delivery", async () => {
    const run = deferred<string>();
    const states: TaskStateEvent[] = [];
    const order: string[] = [];
    const manager = new BackgroundTaskManager({
      onTaskState: (event) => {
        states.push(event);
        order.push(event.status);
      },
      notify: () => {
        order.push("notification");
      },
    });

    const accepted = manager.start({
      taskType: "agent",
      label: "coordinate extensions",
      sessionKey: "coordination",
      run: () => run.promise,
    });

    expect(states).toEqual([{
      version: 1,
      task_id: accepted.task_id,
      task_type: "agent",
      status: "accepted",
    }]);

    run.resolve("done");
    await manager.waitForIdle();

    expect(states).toEqual([
      {
        version: 1,
        task_id: accepted.task_id,
        task_type: "agent",
        status: "accepted",
      },
      {
        version: 1,
        task_id: accepted.task_id,
        task_type: "agent",
        status: "completed",
      },
    ]);
    expect(order).toEqual(["accepted", "completed", "notification"]);
  });

  it("uses one compact Workflow envelope without a session key", async () => {
    const notifications: TerminalTaskEnvelope[] = [];
    const states: TaskStateEvent[] = [];
    const manager = new BackgroundTaskManager({
      notify: (envelope) => notifications.push(envelope),
      onTaskState: (event) => states.push(event),
    });

    const accepted = manager.start({
      taskType: "workflow",
      name: "review_flow",
      run: async () => "review passed",
    });
    await manager.waitForIdle();

    expect(Object.keys(accepted).sort()).toEqual(["name", "status", "task_id", "task_type"]);
    expect(states).toEqual([
      {
        version: 1,
        task_id: accepted.task_id,
        task_type: "workflow",
        status: "accepted",
      },
      {
        version: 1,
        task_id: accepted.task_id,
        task_type: "workflow",
        status: "completed",
      },
    ]);
    expect(notifications).toEqual([{
      task_id: accepted.task_id,
      task_type: "workflow",
      status: "completed",
      name: "review_flow",
      content: "review passed",
    }]);
  });

  it("converts task errors into failed terminal content", async () => {
    const notifications: TerminalTaskEnvelope[] = [];
    const manager = new BackgroundTaskManager({ notify: (envelope) => notifications.push(envelope) });

    const accepted = manager.start({
      taskType: "agent",
      label: "broken task",
      sessionKey: "broken",
      run: async () => { throw new Error("backend unavailable"); },
    });
    await manager.waitForIdle();

    expect(notifications).toEqual([{
      task_id: accepted.task_id,
      task_type: "agent",
      status: "failed",
      session_key: "broken",
      label: "broken task",
      content: "backend unavailable",
    }]);
  });

  it("queues notifications before waitForIdle resolves", async () => {
    const order: string[] = [];
    const manager = new BackgroundTaskManager({
      notify: () => { order.push("notification"); },
    });

    manager.start({
      taskType: "workflow",
      name: "ordered",
      run: async () => "done",
    });
    await manager.waitForIdle();
    order.push("idle");

    expect(order).toEqual(["notification", "idle"]);
  });

  it("aborts active tasks without closing the manager", async () => {
    const notifications: TerminalTaskEnvelope[] = [];
    const manager = new BackgroundTaskManager({ notify: (envelope) => notifications.push(envelope) });

    const aborted = manager.start({
      taskType: "workflow",
      name: "old branch",
      run: (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    await manager.abortAll("Pi session tree changed");
    const completed = manager.start({ taskType: "workflow", name: "new branch", run: async () => "done" });
    await manager.waitForIdle();

    expect(notifications).toEqual([
      expect.objectContaining({ task_id: aborted.task_id, status: "failed", content: "Pi session tree changed" }),
      expect.objectContaining({ task_id: completed.task_id, status: "completed", content: "done" }),
    ]);
  });

  it("prefers the recorded abort reason when a task resolves during abort", async () => {
    const notifications: TerminalTaskEnvelope[] = [];
    const manager = new BackgroundTaskManager({ notify: (envelope) => notifications.push(envelope) });
    const started = deferred<void>();

    const accepted = manager.start({
      taskType: "workflow",
      name: "late success",
      run: (signal) => {
        started.resolve();
        return new Promise<string>((resolve) => {
          signal.addEventListener("abort", () => resolve("ignored success"), { once: true });
        });
      },
    });
    await started.promise;
    await manager.abortAll("Pi session tree changed");

    expect(notifications).toEqual([{
      task_id: accepted.task_id,
      task_type: "workflow",
      status: "failed",
      name: "late success",
      content: "Pi session tree changed",
    }]);
  });

  it("aborts tasks and emits failed notifications during session shutdown", async () => {
    const notifications: TerminalTaskEnvelope[] = [];
    const manager = new BackgroundTaskManager({ notify: (envelope) => notifications.push(envelope) });

    const accepted = manager.start({
      taskType: "workflow",
      name: "long task",
      run: (signal) => new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });
    await manager.shutdown();

    expect(notifications).toEqual([{
      task_id: accepted.task_id,
      task_type: "workflow",
      status: "failed",
      name: "long task",
      content: "Pi session shut down",
    }]);
    expect(manager.getCounts().workflow).toEqual({ finished: 1, total: 1 });
    expect(() => manager.start({ taskType: "workflow", name: "late", run: async () => "late" })).toThrow(
      "after session shutdown",
    );
  });

  it("serializes the same minimal envelope into a tool result", () => {
    const envelope = {
      task_id: "task_1",
      task_type: "workflow" as const,
      status: "accepted" as const,
      name: "audit",
    };

    expect(taskToolResult(envelope)).toEqual({
      content: [{ type: "text", text: JSON.stringify(envelope) }],
      details: envelope,
    });
  });
});
