import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../src/core/concurrency.ts";

describe("ConcurrencyLimiter", () => {
  it("rejects an invalid max", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(-1)).toThrow();
    expect(() => new ConcurrencyLimiter(1.5)).toThrow();
  });

  it("caps synchronous tryAcquire at max and frees on release", () => {
    const limiter = new ConcurrencyLimiter(2);
    const r1 = limiter.tryAcquire();
    const r2 = limiter.tryAcquire();
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.tryAcquire()).toBeNull();

    r1?.();
    expect(limiter.activeCount).toBe(1);
    const r3 = limiter.tryAcquire();
    expect(r3).not.toBeNull();
    expect(limiter.activeCount).toBe(2);

    r2?.();
    r3?.();
    expect(limiter.activeCount).toBe(0);
  });

  it("treats double release as idempotent", () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = limiter.tryAcquire();
    release?.();
    release?.();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.tryAcquire()).not.toBeNull();
  });

  it("queues acquire() when full and drains FIFO as slots free", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = await limiter.acquire();
    expect(limiter.activeCount).toBe(1);

    const order: number[] = [];
    const p2 = limiter.acquire().then((release) => {
      order.push(2);
      return release;
    });
    const p3 = limiter.acquire().then((release) => {
      order.push(3);
      return release;
    });
    expect(limiter.pendingCount).toBe(2);
    expect(limiter.activeCount).toBe(1);

    r1();
    const r2 = await p2;
    expect(order).toEqual([2]);
    expect(limiter.activeCount).toBe(1);

    r2();
    const r3 = await p3;
    expect(order).toEqual([2, 3]);

    r3();
    expect(limiter.activeCount).toBe(0);
    expect(limiter.pendingCount).toBe(0);
  });

  it("never exceeds max across mixed tryAcquire + acquire", async () => {
    const limiter = new ConcurrencyLimiter(3);
    const releases = [limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()];
    expect(releases.every(Boolean)).toBe(true);
    expect(limiter.activeCount).toBe(3);

    let resolved = false;
    const queued = limiter.acquire().then((release) => {
      resolved = true;
      return release;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(limiter.activeCount).toBe(3);

    releases[0]?.();
    const queuedRelease = await queued;
    expect(resolved).toBe(true);
    expect(limiter.activeCount).toBe(3);

    queuedRelease();
    releases[1]?.();
    releases[2]?.();
    expect(limiter.activeCount).toBe(0);
  });

  it("rejects acquire() when the signal is already aborted", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.acquire(controller.signal)).rejects.toThrow();
    expect(limiter.activeCount).toBe(0);
  });

  it("dequeues and rejects a waiter aborted while waiting", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = limiter.tryAcquire();
    const controller = new AbortController();
    const pending = limiter.acquire(controller.signal);
    expect(limiter.pendingCount).toBe(1);

    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(limiter.pendingCount).toBe(0);

    r1?.();
    expect(limiter.activeCount).toBe(0);
  });

  it("skips an aborted waiter when handing off a freed slot", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const r1 = limiter.tryAcquire();
    const controller = new AbortController();
    const abortedWaiter = limiter.acquire(controller.signal);
    const liveWaiter = limiter.acquire();
    expect(limiter.pendingCount).toBe(2);

    controller.abort();
    await expect(abortedWaiter).rejects.toThrow();
    expect(limiter.pendingCount).toBe(1);

    r1?.();
    const liveRelease = await liveWaiter;
    expect(limiter.activeCount).toBe(1);
    liveRelease();
    expect(limiter.activeCount).toBe(0);
  });
});
