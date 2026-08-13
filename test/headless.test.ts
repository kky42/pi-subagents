import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../src/types.ts";

const spawn = vi.hoisted(() => vi.fn());
const sdkState = vi.hoisted(() => ({ provider: "configured", model: "model-a", available: [{ provider: "fallback", id: "model-b" }] as object[] }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original()),
  getAgentDir: () => "/tmp/pi-flow-headless-agent",
  SettingsManager: { create: () => ({
    getDefaultProvider: () => sdkState.provider,
    getDefaultModel: () => sdkState.model,
    getDefaultThinkingLevel: () => "medium",
  }) },
  ModelRuntime: { create: async () => ({ getAvailable: async () => sdkState.available }) },
  ModelRegistry: class {
    find(provider: string, model: string) {
      return provider === "configured" && model === "model-a" ? { provider, id: model } : undefined;
    }
  },
}));
vi.mock("../src/core/spawn.ts", async (original) => ({ ...(await original()), spawnSubagent: spawn }));
vi.mock("../src/profiles.ts", () => ({
  getSubagentProfiles: () => new Map([
    ["reviewer", { name: "reviewer", description: "review", backend: "codex", model: "gpt-test", thinking: "high" }],
    ["pi-reviewer", { name: "pi-reviewer", description: "review", backend: "pi" }],
  ]),
}));

import { getSubagentUsage, textResult } from "../src/core/progress.ts";
import { incrementalPiUsage } from "../src/core/spawn.ts";
import { createWorkflowSubagentRunner } from "../src/workflow/subagent-runner.ts";
import { executeWorkflow } from "../headless.ts";

const profile: SubagentProfile = { name: "reviewer", description: "review", backend: "codex", model: "gpt-test", thinking: "high" };

beforeEach(() => {
  sdkState.provider = "configured";
  sdkState.model = "model-a";
  sdkState.available = [{ provider: "fallback", id: "model-b" }];
  spawn.mockReset();
  spawn.mockImplementation(async (params) => {
    const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.1 } };
    params.onUsage(usage, { tokensKnown: true, costKnown: true, costBreakdownKnown: false });
    return {
      content: [],
      details: {
        status: "done",
        result: "ok",
        ...(params.persistSession ? { sessionId: params.sessionId ?? "new-session" } : {}),
      },
      usage,
    };
  });
});

describe("canonical workflow agent runner", () => {
  it("omits standard tool usage when telemetry is unavailable", () => {
    expect(textResult("done", {
      label: "unknown",
      profile: "reviewer",
      status: "done",
    })).not.toHaveProperty("usage");
  });

  it("reports aggregate cache hit rate from cumulative Pi session stats", () => {
    expect(getSubagentUsage({
      getSessionStats: () => ({
        tokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 50 },
        cost: 0.2,
      }),
    })).toMatchObject({ totalTokens: 210, cost: { total: 0.2 } });
  });

  it("reports cumulative cache hit rate for only the current resumed Pi call", () => {
    expect(incrementalPiUsage(
      { input: 140, output: 25, cacheRead: 60, cacheWrite: 4, totalTokens: 229, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.9 } },
      { input: 100, output: 20, cacheRead: 50, cacheWrite: 1, totalTokens: 171, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.7 } },
    )).toEqual({
      input: 40,
      output: 5,
      cacheRead: 10,
      cacheWrite: 3,
      totalTokens: 58,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: expect.closeTo(0.2) },
    });
  });

  it("continues a caller-keyed conversation within one workflow run", async () => {
    const runner = createWorkflowSubagentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });

    await runner.runSubagent(
      { prompt: "first", label: "first", profile: "reviewer", sessionKey: "worker" },
      new AbortController().signal,
    );
    await runner.runSubagent(
      { prompt: "continue", label: "second", profile: "reviewer", sessionKey: "worker" },
      new AbortController().signal,
    );
    const separateRunner = createWorkflowSubagentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });
    await separateRunner.runSubagent(
      { prompt: "fresh", label: "third", profile: "reviewer", sessionKey: "worker" },
      new AbortController().signal,
    );

    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ persistSession: true, sessionId: undefined }));
    expect(spawn).toHaveBeenNthCalledWith(2, expect.objectContaining({ persistSession: true, sessionId: "new-session" }));
    expect(spawn).toHaveBeenNthCalledWith(3, expect.objectContaining({ persistSession: true, sessionId: undefined }));
  });

  it("rejects reuse of a workflow-local key with another profile or backend", async () => {
    const claudeProfile: SubagentProfile = {
      name: "claude-reviewer",
      description: "review",
      backend: "claude",
    };
    const runner = createWorkflowSubagentRunner({
      profiles: new Map([[profile.name, profile], [claudeProfile.name, claudeProfile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });

    await runner.runSubagent(
      { prompt: "first", label: "first", profile: "reviewer", sessionKey: "worker" },
      new AbortController().signal,
    );
    await expect(runner.runSubagent(
      { prompt: "continue", label: "second", profile: "claude-reviewer", sessionKey: "worker" },
      new AbortController().signal,
    )).rejects.toThrow(/already belongs/i);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("forwards profile model and thinking to the backend spawn", async () => {
    const runner = createWorkflowSubagentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      thinkingLevel: "low", timeoutMs: 123,
    });
    await runner.runSubagent({ prompt: "inspect", label: "lane", profile: "reviewer" }, new AbortController().signal);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ profile, thinkingLevel: "high", timeoutMs: 123 }));
  });
});

describe("headless workflow", () => {
  it("rejects invalid runtime bounds before starting work", async () => {
    const script = `export const meta = { name: "bounds", description: "test" };\nreturn await run_agent("inspect", { profile: "reviewer" });`;

    await expect(executeWorkflow({ cwd: process.cwd(), script, maxConcurrentSubagents: 0 })).rejects.toThrow(RangeError);
    await expect(executeWorkflow({ cwd: process.cwd(), script, subagentTimeoutMs: -1 })).rejects.toThrow(RangeError);
    await expect(executeWorkflow({ cwd: process.cwd(), script, workflowTimeoutMs: 1.5 })).rejects.toThrow(RangeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("resolves separate default provider/model settings", async () => {
    await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "model", description: "test" };\nreturn await run_agent("inspect", { profile: "pi-reviewer" });`,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "configured", id: "model-a" } }));
  });

  it("falls back to the first authenticated model when the configured model is unavailable", async () => {
    sdkState.provider = "missing";
    await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "fallback", description: "test" };\nreturn await run_agent("inspect", { profile: "pi-reviewer" });`,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "fallback", id: "model-b" } }));
  });

  it("distinguishes caller abort from workflow timeout", async () => {
    spawn.mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })));
    const script = `export const meta = { name: "abort", description: "test" };\nreturn await run_agent("inspect", { profile: "reviewer" });`;
    const controller = new AbortController();
    const aborted = executeWorkflow({ cwd: process.cwd(), script, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    await expect(executeWorkflow({ cwd: process.cwd(), script, workflowTimeoutMs: 5 })).rejects.toMatchObject({ code: "WORKFLOW_TIMEOUT" });
  });

  it("computes aggregate cache hit rate from cumulative child usage", async () => {
    spawn.mockImplementation(async (params) => {
      const first = params.label === "one";
      const usage = first
        ? { input: 50, output: 1, cacheRead: 50, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        : { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      params.onUsage(usage, { tokensKnown: true, costKnown: false, costBreakdownKnown: false });
      return { content: [], details: { status: "done", result: params.label }, usage };
    });
    const result = await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "cache", description: "test" };\nreturn await parallel([() => run_agent("a", { label: "one", profile: "reviewer" }), () => run_agent("b", { label: "two", profile: "reviewer" })]);`,
    });
    expect(result.usage).toMatchObject({ input: 150, cacheRead: 50, totalTokens: 202 });
  });

  it("runs without an ExtensionContext or UI and reports immutable cumulative usage snapshots", async () => {
    const usage: unknown[] = [];
    const result = await executeWorkflow({
      cwd: process.cwd(), allowedBackends: ["codex"], onUsage: (value) => usage.push(value),
      script: `export const meta = { name: "headless", description: "test" };\nreturn await run_agent("inspect", { profile: "reviewer" });`,
    });
    expect(result.result).toBe("ok");
    expect(result.usage).toMatchObject({ input: 2, output: 3, totalTokens: 5, childSubagents: 1 });
    expect(usage.length).toBeGreaterThan(1);
    expect(usage[0]).toMatchObject({ childSubagents: 1, cost: { total: 0 } });
    expect(usage.at(-1)).toMatchObject({ input: 2, output: 3, cost: { total: 0.1 } });
  });
});
