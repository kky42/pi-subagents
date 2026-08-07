import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getPersistedSessionKeyBinding,
  persistSessionKeyBinding,
  SessionKeyLocks,
  SUBAGENT_SESSION_KEY_CUSTOM_TYPE,
} from "../src/core/session-key.ts";

function fakeSessionManager(entries: unknown[]) {
  return {
    getBranch: () => entries,
    appendCustomEntry: (customType: string, data?: unknown) => {
      entries.push({ type: "custom", customType, data });
      return `entry-${entries.length}`;
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("session-key binding persistence", () => {
  it("round-trips a binding through parent-session custom state across a session reload", () => {
    const entries: unknown[] = [];
    const ctx = { sessionManager: fakeSessionManager(entries) } as unknown as ExtensionContext;
    const binding = { key: "worker-1", sessionId: "sess-123", profile: "expert", backend: "pi" as const };

    persistSessionKeyBinding(ctx, binding);

    expect(entries).toEqual([{
      type: "custom",
      customType: SUBAGENT_SESSION_KEY_CUSTOM_TYPE,
      data: { version: 2, key: "worker-1", sessionId: "sess-123", profile: "expert", backend: "pi" },
    }]);

    const reloadedCtx = { sessionManager: fakeSessionManager(entries) } as unknown as ExtensionContext;
    expect(getPersistedSessionKeyBinding(reloadedCtx, "worker-1")).toEqual(binding);
    expect(getPersistedSessionKeyBinding(reloadedCtx, "other-key")).toBeUndefined();
  });

  it("keeps the latest binding for a key when the key is rebound", () => {
    const entries: unknown[] = [];
    const ctx = { sessionManager: fakeSessionManager(entries) } as unknown as ExtensionContext;
    persistSessionKeyBinding(ctx, { key: "worker-1", sessionId: "sess-1", profile: "expert", backend: "pi" });
    persistSessionKeyBinding(ctx, { key: "worker-1", sessionId: "sess-2", profile: "expert", backend: "pi" });

    expect(getPersistedSessionKeyBinding(ctx, "worker-1")?.sessionId).toBe("sess-2");
  });
});

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
