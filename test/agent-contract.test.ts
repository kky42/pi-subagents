import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type Context, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getSubagentProfiles } from "../src/profiles.ts";
import { buildFlowPrompt } from "../src/prompts.ts";
import { installFauxProvider, packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function occurrenceCount(text: string, value: string): number {
  return text.split(value).length - 1;
}

function expectDescribedProperties(properties: Record<string, { description?: string }>): void {
  for (const property of Object.values(properties)) {
    expect(property.description?.trim().length).toBeGreaterThan(0);
  }
}

describe("pi-subagent agent contract", () => {
  let cwd = "";
  let agentDir = "";
  let registrations: Array<{ unregister: () => void }> = [];

  const { trackSession, disposeSession, createSession } = setupPiSubagentTestHarness((state) => {
    cwd = state.cwd;
    agentDir = state.agentDir;
    registrations = state.registrations;
  });

  async function captureRootPrompt(activeTools: string[], systemPrompt?: string): Promise<string> {
    const { session, registration } = await createSession({ systemPrompt });
    let rootContext: Context | undefined;
    session.setActiveToolsByName(activeTools);
    registration.setResponses([
      (context) => {
        rootContext = context;
        return fauxAssistantMessage("noted");
      },
    ]);

    await session.prompt("Just say noted.");
    disposeSession(session);
    return rootContext?.systemPrompt ?? "";
  }

  it("registers the Agent API shape without duplicate prompt guidelines", async () => {
    const { session } = await createSession();
    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    const schema = tool?.parameters as {
      required?: string[];
      properties: Record<string, { description?: string }>;
    } | undefined;
    const properties = schema?.properties ?? {};

    expect(tool?.description).toContain("background");
    expect(tool?.description).toContain("return its task ID immediately");
    expect(tool?.promptGuidelines).toBeUndefined();
    expect(schema?.required).toEqual(["label", "prompt"]);
    expect(Object.keys(properties).sort()).toEqual(["label", "prompt", "session_key", "subagent_type"]);
    expectDescribedProperties(properties);
    expect(properties.session_key?.description).toContain("effective session_key is returned");

    disposeSession(session);
  });

  it("registers the workflow API shape without duplicate prompt guidelines", async () => {
    const { session } = await createSession();
    const tool = session.getAllTools().find((candidate) => candidate.name === "workflow");
    const schema = tool?.parameters as {
      required?: string[];
      properties: Record<string, { description?: string }>;
    } | undefined;
    const properties = schema?.properties ?? {};

    expect(tool?.description.trim().length).toBeGreaterThan(0);
    expect(tool?.promptGuidelines).toBeUndefined();
    expect(schema?.required ?? []).toEqual([]);
    expect(Object.keys(properties).sort()).toEqual(["args", "name", "resumeFromTaskId", "script", "scriptPath"]);
    expectDescribedProperties(properties);

    disposeSession(session);
  });

  it("loads as a pi package extension from package metadata", async () => {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory({}),
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await resourceLoader.reload();

    const extensions = resourceLoader.getExtensions();
    expect(extensions.errors).toEqual([]);
    expect(extensions.extensions).toHaveLength(1);
    expect(extensions.extensions[0]?.flags.has("max-concurrent-subagents")).toBe(true);
    expect(extensions.extensions[0]?.flags.has("subagent-timeout-ms")).toBe(true);
  });

  it("injects every registered profile and workflow without their bodies", async () => {
    const profileBodySentinel = "PROFILE_BODY_SENTINEL";
    const workflowBodySentinel = "WORKFLOW_BODY_SENTINEL";
    mkdirSync(join(agentDir, "subagents"), { recursive: true });
    writeFileSync(
      join(agentDir, "subagents", "reviewer.md"),
      `---\ndescription: Reviews source changes.\n---\n${profileBodySentinel}\n`,
    );
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "review.js"),
      `export const meta = { name: 'review_flow', description: 'Review source and tests.' };\nreturn await agent('${workflowBodySentinel}');`,
    );

    const prompt = await captureRootPrompt(["Agent", "workflow"]);
    const profiles = getSubagentProfiles(agentDir);

    expect(occurrenceCount(prompt, "- reviewer: Reviews source changes.")).toBe(1);
    expect(occurrenceCount(prompt, "- review_flow: Review source and tests.")).toBe(1);
    expect(prompt).not.toContain(profileBodySentinel);
    expect(prompt).not.toContain(workflowBodySentinel);
    for (const profile of profiles.values()) {
      expect(occurrenceCount(prompt, `- ${profile.name}: ${profile.description}`)).toBe(1);
    }
  });

  it("uses availability-qualified routing in the same PiFlow prompt regardless of the active tool subset", async () => {
    const expectedFlowPrompt = buildFlowPrompt(getSubagentProfiles(agentDir), []);
    expect(expectedFlowPrompt).toContain("When Agent is available");
    expect(expectedFlowPrompt).toContain("When workflow is available");
    for (const activeTools of [["Agent", "workflow"], ["Agent"], ["workflow"], []]) {
      const prompt = await captureRootPrompt(activeTools);
      expect(prompt.endsWith(expectedFlowPrompt)).toBe(true);
    }
  });

  it("uses Pi active-tool snippets for canonical tool discovery", async () => {
    const agentEntry = "- Agent:";
    const workflowEntry = "- workflow:";
    const both = await captureRootPrompt(["Agent", "workflow"]);
    const agentOnly = await captureRootPrompt(["Agent"]);
    const workflowOnly = await captureRootPrompt(["workflow"]);
    const neither = await captureRootPrompt([]);

    expect(both).toContain(agentEntry);
    expect(both).toContain(workflowEntry);
    expect(agentOnly).toContain(agentEntry);
    expect(agentOnly).not.toContain(workflowEntry);
    expect(workflowOnly).not.toContain(agentEntry);
    expect(workflowOnly).toContain(workflowEntry);
    expect(neither).not.toContain(agentEntry);
    expect(neither).not.toContain(workflowEntry);
  });

  it("retains a custom base system prompt", async () => {
    const customPrompt = "CUSTOM_SYSTEM_PROMPT_SENTINEL";
    const prompt = await captureRootPrompt([], customPrompt);
    const expectedFlowPrompt = buildFlowPrompt(getSubagentProfiles(agentDir), []);

    expect(prompt.startsWith(customPrompt)).toBe(true);
    expect(prompt.endsWith(expectedFlowPrompt)).toBe(true);
  });

  it("lists every workflow without count or description truncation", async () => {
    const workflowsDir = join(agentDir, "workflows");
    const longDescription = `Complete description ${"x".repeat(220)}`;
    mkdirSync(workflowsDir, { recursive: true });
    for (let index = 1; index <= 25; index += 1) {
      const name = `workflow_${String(index).padStart(2, "0")}`;
      const description = index === 25 ? longDescription : `Description ${index}`;
      writeFileSync(
        join(workflowsDir, `${name}.js`),
        `export const meta = { name: '${name}', description: '${description}' };\nreturn await agent('run');`,
      );
    }

    const prompt = await captureRootPrompt([]);

    for (let index = 1; index <= 25; index += 1) {
      const name = `workflow_${String(index).padStart(2, "0")}`;
      expect(occurrenceCount(prompt, `- ${name}:`)).toBe(1);
    }
    expect(prompt).toContain(longDescription);
  });

  it("registers Agent when loaded through additionalExtensionPaths", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }],
    });
    const model = faux.getModel("faux-thinker") as Model<string>;
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const modelRegistry = new ModelRegistry(modelRuntime);
    const registration = installFauxProvider(modelRegistry, faux);
    await modelRuntime.setRuntimeApiKey(model.provider, "test-api-key", { allowNetwork: false });
    registrations.push(registration);
    const settingsManager = SettingsManager.inMemory({});
    const sessionManager = SessionManager.inMemory(cwd);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [packageRoot],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      modelRuntime,
      model,
      thinkingLevel: "high",
      settingsManager,
      sessionManager,
      resourceLoader,
    });
    trackSession(session);
    await session.bindExtensions({});

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    expect(tool).toBeDefined();
    expect((tool?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty("subagent_type");
    expect((tool?.parameters as { properties: Record<string, unknown> }).properties).toHaveProperty("session_key");

    disposeSession(session);
  });
});
