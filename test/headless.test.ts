import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentProfile } from "../src/types.ts";

const spawn = vi.hoisted(() => vi.fn());
const sdkState = vi.hoisted(() => ({ provider: "configured", model: "model-a", available: [{ provider: "fallback", id: "model-b" }] as object[] }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
  ...(await original()),
  getAgentDir: () => "/tmp/pi-flow-headless-agent",
  AuthStorage: { create: () => ({}) },
  SettingsManager: { create: () => ({
    getDefaultProvider: () => sdkState.provider,
    getDefaultModel: () => sdkState.model,
    getDefaultThinkingLevel: () => "medium",
  }) },
  ModelRegistry: { create: () => ({
    find: (provider: string, model: string) => provider === "configured" && model === "model-a" ? { provider, id: model } : undefined,
    getAvailable: async () => sdkState.available,
  }) },
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
import { createWorkflowAgentRunner } from "../src/workflow/agent-runner.ts";
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
    return { content: [], details: { status: "done", result: "ok" }, usage };
  });
});

describe("canonical workflow agent runner", () => {
  it("omits standard tool usage when telemetry is unavailable", () => {
    expect(textResult("done", {
      description: "unknown",
      subagentType: "reviewer",
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

  it("restores cached session_key bindings before the next live call", async () => {
    const runner = createWorkflowAgentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });
    runner.restoreSessionBinding({
      index: 1, fingerprint: "cached", result: "old", label: "old", prompt: "old",
      subagentType: "reviewer", backend: "codex", sessionKey: "worker", sessionId: "session-1", cached: true,
    });
    await runner.runAgent({ prompt: "continue", label: "lane", subagentType: "reviewer", sessionKey: "worker" }, new AbortController().signal);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", persistSession: true }));
  });

  it("rejects keyed replay when the profile backend changed", async () => {
    const runner = createWorkflowAgentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      timeoutMs: 123,
    });
    runner.restoreSessionBinding({
      index: 1, fingerprint: "cached", result: "old", label: "old", prompt: "old",
      subagentType: "reviewer", backend: "pi", sessionKey: "worker", sessionId: "session-1", cached: true,
    });
    await expect(runner.runAgent(
      { prompt: "continue", label: "lane", subagentType: "reviewer", sessionKey: "worker" },
      new AbortController().signal,
    )).rejects.toThrow(/already belongs/i);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("forwards profile model and thinking to the backend spawn", async () => {
    const runner = createWorkflowAgentRunner({
      profiles: new Map([[profile.name, profile]]),
      ctx: { cwd: "/tmp", modelRegistry: {} } as never,
      thinkingLevel: "low", timeoutMs: 123,
    });
    await runner.runAgent({ prompt: "inspect", label: "lane", subagentType: "reviewer" }, new AbortController().signal);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ profile, thinkingLevel: "high", timeoutMs: 123 }));
  });
});

describe("headless workflow", () => {
  it("resolves separate default provider/model settings", async () => {
    await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "model", description: "test" };\nreturn await agent("inspect", { subagent_type: "pi-reviewer" });`,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "configured", id: "model-a" } }));
  });

  it("falls back to the first authenticated model when the configured model is unavailable", async () => {
    sdkState.provider = "missing";
    await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "fallback", description: "test" };\nreturn await agent("inspect", { subagent_type: "pi-reviewer" });`,
    });
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ model: { provider: "fallback", id: "model-b" } }));
  });

  it("distinguishes caller abort from workflow timeout", async () => {
    spawn.mockImplementation(async ({ signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true })));
    const script = `export const meta = { name: "abort", description: "test" };\nreturn await agent("inspect", { subagent_type: "reviewer" });`;
    const controller = new AbortController();
    const aborted = executeWorkflow({ cwd: process.cwd(), script, signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(aborted).rejects.toMatchObject({ code: "ABORTED" });
    await expect(executeWorkflow({ cwd: process.cwd(), script, workflowTimeoutMs: 5 })).rejects.toMatchObject({ code: "WORKFLOW_TIMEOUT" });
  });

  it("computes aggregate cache hit rate from cumulative child usage", async () => {
    spawn.mockImplementation(async (params) => {
      const first = params.description === "one";
      const usage = first
        ? { input: 50, output: 1, cacheRead: 50, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
        : { input: 100, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 101, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      params.onUsage(usage, { tokensKnown: true, costKnown: false, costBreakdownKnown: false });
      return { content: [], details: { status: "done", result: params.description }, usage };
    });
    const result = await executeWorkflow({
      cwd: process.cwd(),
      script: `export const meta = { name: "cache", description: "test" };\nreturn await parallel([() => agent("a", { label: "one", subagent_type: "reviewer" }), () => agent("b", { label: "two", subagent_type: "reviewer" })]);`,
    });
    expect(result.usage).toMatchObject({ input: 150, cacheRead: 50, totalTokens: 202 });
  });

  it("runs without an ExtensionContext or UI and reports cumulative usage", async () => {
    const usage: unknown[] = [];
    const result = await executeWorkflow({
      cwd: process.cwd(), allowedBackends: ["codex"], onUsage: (value) => usage.push(value),
      script: `export const meta = { name: "headless", description: "test" };\nreturn await agent("inspect", { subagent_type: "reviewer" });`,
    });
    expect(result.result).toBe("ok");
    expect(result.usage).toMatchObject({ input: 2, output: 3, totalTokens: 5, childAgents: 1 });
    expect(usage.length).toBeGreaterThan(0);
  });
});
