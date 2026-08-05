import { describe, expect, it } from "vitest";
import {
  SynchronousTaskManager,
  taskEnvelopeContent,
  type TaskStateEvent,
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

describe("SynchronousTaskManager", () => {
  it("keeps the call pending until its operation completes", async () => {
    const gate = deferred<string>();
    const states: TaskStateEvent[] = [];
    const manager = new SynchronousTaskManager({ onTaskState: (event) => states.push(event) });
    let taskId = "";
    let settled = false;

    const pending = manager.run({
      taskType: "agent",
      execute: async (_signal, id) => {
        taskId = id;
        return { status: "completed", value: await gate.promise };
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    expect(taskId).toMatch(/^task_[a-f0-9]{32}$/);
    expect(settled).toBe(false);
    expect(manager.isActive(taskId)).toBe(true);
    expect(states).toEqual([{
      version: 1,
      task_id: taskId,
      task_type: "agent",
      status: "accepted",
    }]);

    gate.resolve("done");
    const result = await pending;

    expect(result).toEqual({ taskId, status: "completed", value: "done" });
    expect(manager.isActive(taskId)).toBe(false);
    expect(states.at(-1)).toEqual({
      version: 1,
      task_id: taskId,
      task_type: "agent",
      status: "completed",
    });
  });

  it("publishes the terminal event before returning the result", async () => {
    const order: string[] = [];
    const manager = new SynchronousTaskManager({
      onTaskState: (event) => order.push(event.status),
    });

    await manager.run({
      taskType: "workflow",
      execute: async () => ({ status: "completed", value: "result" }),
    });
    order.push("returned");

    expect(order).toEqual(["accepted", "completed", "returned"]);
  });

  it("waits only for active synchronous calls", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const manager = new SynchronousTaskManager();

    const firstRun = manager.run({
      taskType: "agent",
      execute: async () => {
        await first.promise;
        return { status: "completed", value: 1 };
      },
    });
    const secondRun = manager.run({
      taskType: "workflow",
      execute: async () => {
        await second.promise;
        return { status: "completed", value: 2 };
      },
    });
    let idle = false;
    const waiting = manager.waitForIdle().then(() => { idle = true; });

    first.resolve();
    await firstRun;
    expect(idle).toBe(false);

    second.resolve();
    await secondRun;
    await waiting;
    expect(idle).toBe(true);
  });

  it("aborts active calls without closing the manager", async () => {
    const states: TaskStateEvent[] = [];
    const manager = new SynchronousTaskManager({ onTaskState: (event) => states.push(event) });
    const started = deferred<void>();

    const aborted = manager.run({
      taskType: "workflow",
      execute: async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "failed", value: signal.reason };
      },
    });
    await started.promise;
    await manager.abortAll("Pi session tree changed");
    const abortedResult = await aborted;

    expect(abortedResult.status).toBe("failed");
    expect(abortedResult.abortReason).toBe("Pi session tree changed");
    expect(states.at(-1)?.status).toBe("failed");

    const next = await manager.run({
      taskType: "agent",
      execute: async () => ({ status: "completed", value: "next" }),
    });
    expect(next.status).toBe("completed");
  });

  it("does not report a late success after abort", async () => {
    const manager = new SynchronousTaskManager();
    const started = deferred<void>();
    const pending = manager.run({
      taskType: "agent",
      execute: async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        return { status: "completed", value: "late success" };
      },
    });

    await started.promise;
    await manager.abortAll("cancelled");
    const result = await pending;

    expect(result).toMatchObject({
      status: "failed",
      value: "late success",
      abortReason: "cancelled",
    });
  });

  it("closes permanently on shutdown", async () => {
    const manager = new SynchronousTaskManager();
    await manager.shutdown();

    await expect(manager.run({
      taskType: "agent",
      execute: async () => ({ status: "completed", value: "late" }),
    })).rejects.toThrow("after session shutdown");
  });

  it("clears an unexpectedly rejected operation and publishes failure", async () => {
    const states: TaskStateEvent[] = [];
    const manager = new SynchronousTaskManager({ onTaskState: (event) => states.push(event) });

    await expect(manager.run({
      taskType: "workflow",
      execute: async () => {
        throw new Error("unexpected failure");
      },
    })).rejects.toThrow("unexpected failure");

    expect(manager.hasActiveTasks()).toBe(false);
    expect(states.map((event) => event.status)).toEqual(["accepted", "failed"]);
  });

  it("isolates task-state observer failures", async () => {
    const manager = new SynchronousTaskManager({
      onTaskState: () => {
        throw new Error("observer failed");
      },
    });

    await expect(manager.run({
      taskType: "agent",
      execute: async () => ({ status: "completed", value: "ok" }),
    })).resolves.toMatchObject({ status: "completed", value: "ok" });
  });

  it("serializes a terminal envelope as model-visible content", () => {
    const envelope = {
      task_id: "task_1",
      task_type: "workflow" as const,
      status: "completed" as const,
      name: "audit",
      content: "passed",
    };

    expect(taskEnvelopeContent(envelope)).toEqual([
      { type: "text", text: JSON.stringify(envelope) },
    ]);
  });
});
