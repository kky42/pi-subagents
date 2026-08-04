export type Release = () => void;

interface Waiter {
  resolve: (release: Release) => void;
  reject: (error: Error) => void;
  settled: boolean;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const ABORT_MESSAGE = "Aborted while waiting for a concurrency slot";

/**
 * Shared by run_subagent and run_workflow so one global cap bounds all subagents. Released
 * slots pass directly to FIFO waiters, preventing tryAcquire() from claiming a
 * slot during an asynchronous handoff and exceeding the cap.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error("ConcurrencyLimiter max must be a positive integer");
    }
  }

  get activeCount(): number {
    return this.active;
  }

  get pendingCount(): number {
    return this.waiters.length;
  }

  /** Acquires synchronously without blocking, or returns null at capacity. */
  tryAcquire(): Release | null {
    if (this.active >= this.max) {
      return null;
    }
    this.active++;
    return this.makeRelease();
  }

  /** Acquires a slot or queues until one is available; rejects if aborted. */
  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) {
      return Promise.reject(new Error(ABORT_MESSAGE));
    }
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false, signal };
      if (signal) {
        waiter.onAbort = () => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          const index = this.waiters.indexOf(waiter);
          if (index !== -1) {
            this.waiters.splice(index, 1);
          }
          reject(new Error(ABORT_MESSAGE));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.handOffOrDecrement();
    };
  }

  private handOffOrDecrement(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter || waiter.settled) {
        continue;
      }
      waiter.settled = true;
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this.makeRelease());
      return;
    }
    this.active--;
  }
}
