import { describe, expect, it } from "vitest";
import { SynchronousTaskManager } from "../src/core/task-manager.ts";

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
    const manager = new SynchronousTaskManager();
    let settled = false;

    const pending = manager.run({
      execute: async () => {
        return { status: "completed", value: await gate.promise };
      },
    }).then((result) => {
      settled = true;
      return result;
    });

    expect(settled).toBe(false);

    gate.resolve("done");
    const result = await pending;

    expect(result).toEqual({ status: "completed", value: "done" });
  });

  it("waits only for active synchronous calls", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const manager = new SynchronousTaskManager();

    const firstRun = manager.run({
      execute: async () => {
        await first.promise;
        return { status: "completed", value: 1 };
      },
    });
    const secondRun = manager.run({
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
    const manager = new SynchronousTaskManager();
    const started = deferred<void>();

    const aborted = manager.run({
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

    const next = await manager.run({
      execute: async () => ({ status: "completed", value: "next" }),
    });
    expect(next.status).toBe("completed");
  });

  it("does not report a late success after abort", async () => {
    const manager = new SynchronousTaskManager();
    const started = deferred<void>();
    const pending = manager.run({
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
      execute: async () => ({ status: "completed", value: "late" }),
    })).rejects.toThrow();
  });

  it("clears an unexpectedly rejected operation", async () => {
    const manager = new SynchronousTaskManager();

    await expect(manager.run({
      execute: async () => {
        throw new Error("unexpected failure");
      },
    })).rejects.toThrow("unexpected failure");

    expect(manager.hasActiveTasks()).toBe(false);
  });
});
