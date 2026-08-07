import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createChildModelRuntime } from "../src/core/model-runtime.ts";

function createAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-flow-model-runtime-"));
}

describe("child model runtime", () => {
  it("preserves stored OAuth credentials without converting them to an API-key override", async () => {
    const agentDir = createAgentDir();
    try {
      writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "fake-access",
          refresh: "fake-refresh",
          expires: Date.now() + 60 * 60 * 1000,
        },
      }));
      const parentRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const registry = new ModelRegistry(parentRuntime);
      const model = parentRuntime.getModels("openai-codex")[0];
      expect(model).toBeDefined();
      if (!model) return;

      const childRuntime = await createChildModelRuntime(registry, model, agentDir);

      expect(registry.isUsingOAuth(model)).toBe(true);
      expect(childRuntime.isUsingOAuth(model.provider)).toBe(true);
      expect(await childRuntime.getAuth(model)).toMatchObject({
        source: "OAuth",
        auth: { apiKey: "fake-access" },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("copies a parent runtime API-key override", async () => {
    const agentDir = createAgentDir();
    try {
      const parentRuntime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const registry = new ModelRegistry(parentRuntime);
      const model = parentRuntime.getModels("anthropic")[0];
      expect(model).toBeDefined();
      if (!model) return;
      await parentRuntime.setRuntimeApiKey(model.provider, "runtime-secret");

      const childRuntime = await createChildModelRuntime(registry, model, agentDir);

      expect(childRuntime.getProviderAuthStatus(model.provider).source).toBe("runtime");
      expect(await childRuntime.getAuth(model)).toMatchObject({
        auth: { apiKey: "runtime-secret" },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
