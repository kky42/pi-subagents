import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentBackend, SubagentProfileName } from "../types.ts";

export const SUBAGENT_SESSION_KEY_CUSTOM_TYPE = "pi-flow-subagent-session-key";

export interface SessionKeyBinding {
  key: string;
  sessionId: string;
  profile: SubagentProfileName;
  backend: SubagentBackend;
}

interface SessionKeyEntryData {
  version?: unknown;
  key?: unknown;
  sessionId?: unknown;
  profile?: unknown;
  backend?: unknown;
}

interface SessionManagerLike {
  getBranch?: () => unknown[];
  getEntries?: () => unknown[];
  appendCustomEntry?: (customType: string, data?: unknown) => string;
}

export function normalizeSessionKey(value: string | undefined): string | undefined {
  const key = value?.trim();
  return key ? key : undefined;
}

export function createSessionKey(): string {
  return `session_${randomUUID().replace(/-/g, "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function parseBindingData(data: unknown, requestedKey: string): SessionKeyBinding | undefined {
  if (!isRecord(data) || data.key !== requestedKey) {
    return undefined;
  }
  const candidate = data as SessionKeyEntryData;
  if (candidate.version !== 2) {
    throw new Error(
      `session_key "${requestedKey}" uses unsupported persisted binding version ${String(candidate.version)}`,
    );
  }
  if (
    typeof candidate.sessionId !== "string" ||
    typeof candidate.profile !== "string" ||
    (candidate.backend !== "pi" && candidate.backend !== "codex" && candidate.backend !== "claude")
  ) {
    throw new Error(`session_key "${requestedKey}" has invalid persisted binding data`);
  }
  return {
    key: requestedKey,
    sessionId: candidate.sessionId,
    profile: candidate.profile,
    backend: candidate.backend,
  };
}

export function getPersistedSessionKeyBinding(ctx: ExtensionContext, key: string): SessionKeyBinding | undefined {
  const manager = ctx.sessionManager as SessionManagerLike | undefined;
  const entries = manager?.getBranch?.() ?? manager?.getEntries?.();
  if (!Array.isArray(entries)) {
    return undefined;
  }
  let latest: SessionKeyBinding | undefined;
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_SESSION_KEY_CUSTOM_TYPE) {
      continue;
    }
    const binding = parseBindingData(entry.data, key);
    if (binding?.key === key) {
      latest = binding;
    }
  }
  return latest;
}

export function persistSessionKeyBinding(ctx: ExtensionContext, binding: SessionKeyBinding): void {
  const manager = ctx.sessionManager as SessionManagerLike | undefined;
  manager?.appendCustomEntry?.(SUBAGENT_SESSION_KEY_CUSTOM_TYPE, {
    version: 2,
    key: binding.key,
    sessionId: binding.sessionId,
    profile: binding.profile,
    backend: binding.backend,
  });
}

export function assertBindingMatchesProfile(binding: SessionKeyBinding, params: {
  profile: SubagentProfileName;
  backend: SubagentBackend;
}): void {
  if (binding.profile !== params.profile || binding.backend !== params.backend) {
    throw new Error(
      `session_key "${binding.key}" already belongs to ${binding.profile} (${binding.backend}); ` +
        `cannot reuse it for ${params.profile} (${params.backend})`,
    );
  }
}

export class SessionKeyLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string | undefined, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!key) {
      signal?.throwIfAborted();
      return task();
    }
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    try {
      await waitForPrevious(previous, signal);
      return await task();
    } finally {
      release();
    }
  }
}

async function waitForPrevious(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await previous.catch(() => undefined);
    return;
  }
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    previous.catch(() => undefined).then(resolve).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
  signal.throwIfAborted();
}
