import { describe, expect, it } from "vitest";
import { SessionKeyLocks } from "../src/core/session-key.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SessionKeyLocks", () => {
  it("keeps later same-key calls behind the holder when a queued call is aborted", async () => {
    const locks = new SessionKeyLocks();
    const firstGate = deferred();
    const firstStarted = deferred();
    const starts: string[] = [];
    const first = locks.run("worker", async () => {
      starts.push("first");
      firstStarted.resolve();
      await firstGate.promise;
      return "first";
    });
    await firstStarted.promise;

    const controller = new AbortController();
    const second = locks.run("worker", async () => {
      starts.push("second");
      return "second";
    }, controller.signal);
    controller.abort(new Error("cancel queued continuation"));

    await expect(second).rejects.toThrow("cancel queued continuation");
    const third = locks.run("worker", async () => {
      starts.push("third");
      return "third";
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(starts).toEqual(["first"]);

    firstGate.resolve();
    await expect(first).resolves.toBe("first");
    await expect(third).resolves.toBe("third");
    expect(starts).toEqual(["first", "third"]);
  });

  it("does not start a pre-aborted unkeyed call", async () => {
    const locks = new SessionKeyLocks();
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    let started = false;

    await expect(locks.run(undefined, async () => {
      started = true;
      return "late";
    }, controller.signal)).rejects.toThrow("already cancelled");
    expect(started).toBe(false);
  });
});
