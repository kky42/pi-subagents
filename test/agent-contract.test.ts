import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type Context, type Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { getSubagentProfiles } from "../src/profiles.ts";
import {
  AGENT_USE_POLICY,
  DIRECT_WORK_POLICY,
  WORKFLOW_USE_POLICY,
} from "../src/prompts.ts";
import { installFauxProvider, packageRoot, setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

function occurrenceCount(text: string, value: string): number {
  return text.split(value).length - 1;
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

  it("registers the Claude-style Agent tool contract without profile-specific guidance", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    expect(tool).toBeDefined();
    const properties = (tool?.parameters as { properties: Record<string, { description?: string }> } | undefined)?.properties;
    expect(properties).toHaveProperty("description");
    expect(properties).toHaveProperty("prompt");
    expect(properties).toHaveProperty("subagent_type");
    expect(properties).toHaveProperty("session_key");
    expect(properties).not.toHaveProperty("run_in_background");
    expect(properties).not.toHaveProperty("resume");
    expect(properties).not.toHaveProperty("model");
    expect(properties).not.toHaveProperty("thinking");
    expect(properties).not.toHaveProperty("timeout");
    expect(properties).not.toHaveProperty("subagentTimeoutMs");
    expect(properties?.subagent_type.description).toMatch(/available profiles/i);
    expect(properties?.subagent_type.description).not.toContain("Defaults to");
    expect(properties?.session_key.description).toContain("same logical child");
    expect(tool?.promptGuidelines).toContain(AGENT_USE_POLICY);

    disposeSession(session);
  });

  it("marks description and prompt required while keeping routing fields optional", async () => {
    const { session } = await createSession();

    const tool = session.getAllTools().find((candidate) => candidate.name === "Agent");
    const schema = tool?.parameters as { required?: string[]; properties: Record<string, unknown> } | undefined;
    expect(schema?.required).toContain("description");
    expect(schema?.required).toContain("prompt");
    expect(schema?.required ?? []).not.toContain("subagent_type");
    expect(schema?.required ?? []).not.toContain("session_key");
    expect(schema?.properties).not.toHaveProperty("tag");
    expect(schema?.properties).not.toHaveProperty("label");

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

  it("injects one profile roster and the approved routing boundary", async () => {
    const prompt = await captureRootPrompt(["Agent", "workflow"]);
    const profiles = getSubagentProfiles(agentDir);

    expect(prompt).toContain("# Subagent Delegation");
    expect(prompt).toContain(`- ${DIRECT_WORK_POLICY}`);
    expect(prompt).toContain(`- ${AGENT_USE_POLICY}`);
    expect(prompt).toContain(`- ${WORKFLOW_USE_POLICY}`);
    expect(prompt).toContain("## Agent");
    expect(prompt).toContain("## Workflow");
    expect(prompt).toContain("same logical child stream");
    expect(prompt).toContain("independent work, including parallel branches, stays fresh");
    expect(prompt).toContain("schema supplied through dynamic options is validated immediately before that child launches");
    expect(prompt).toContain("filename need not match `meta.name`");
    expect(prompt).not.toContain("use a filename that exactly matches");
    expect(prompt).not.toContain("Schemas must be static");
    expect(occurrenceCount(prompt, "Available agents:")).toBe(1);
    for (const profile of profiles.values()) {
      expect(occurrenceCount(prompt, `- ${profile.name}: ${profile.description}`)).toBe(1);
    }
  });

  it("retains detailed guidance with a custom base system prompt", async () => {
    const customPrompt = "CUSTOM_SYSTEM_PROMPT_SENTINEL";
    const prompt = await captureRootPrompt(["Agent", "workflow"], customPrompt);

    expect(prompt.startsWith(customPrompt)).toBe(true);
    expect(prompt).toContain("# Subagent Delegation");
    expect(prompt).toContain("## Agent");
    expect(prompt).toContain("## Workflow");
    expect(prompt).toContain("schema supplied through dynamic options");
  });

  it("appends detailed guidance only for active pi-flow tools", async () => {
    const both = await captureRootPrompt(["Agent", "workflow"]);
    expect(both).toContain("## Agent");
    expect(both).toContain("## Workflow");

    const agentOnly = await captureRootPrompt(["Agent"]);
    expect(agentOnly).toContain("## Agent");
    expect(agentOnly).not.toContain("## Workflow");
    expect(agentOnly).toContain(AGENT_USE_POLICY);
    expect(agentOnly).not.toContain(WORKFLOW_USE_POLICY);

    const workflowOnly = await captureRootPrompt(["workflow"]);
    expect(workflowOnly).not.toContain("## Agent");
    expect(workflowOnly).toContain("## Workflow");
    expect(workflowOnly).not.toContain(AGENT_USE_POLICY);
    expect(workflowOnly).toContain(WORKFLOW_USE_POLICY);

    const neither = await captureRootPrompt([]);
    expect(neither).not.toContain("# Subagent Delegation");
    expect(neither).not.toContain(AGENT_USE_POLICY);
    expect(neither).not.toContain(WORKFLOW_USE_POLICY);
  });

  it("advertises saved workflows only while workflow is active", async () => {
    const workflowName = "saved_contract_probe";
    const description = "Summarize generated fixture findings.";
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "different-file-name.js"),
      `export const meta = { name: '${workflowName}', description: '${description}' };\nreturn await agent('summarize');`,
    );

    const workflowPrompt = await captureRootPrompt(["workflow"]);
    expect(workflowPrompt).toContain("Saved workflows:");
    expect(workflowPrompt).toContain(`- ${workflowName}: ${description}`);

    const agentPrompt = await captureRootPrompt(["Agent"]);
    expect(agentPrompt).not.toContain("Saved workflows:");
    expect(agentPrompt).not.toContain(workflowName);
  });

  it("registers Agent when loaded through additionalExtensionPaths", async () => {
    const faux = fauxProvider({
      models: [{ id: "faux-thinker", name: "Faux Thinker", reasoning: true }],
    });
    const model = faux.getModel("faux-thinker") as Model<string>;
    const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
    authStorage.setRuntimeApiKey(model.provider, "test-api-key");
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
    const registration = installFauxProvider(modelRegistry, faux);
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
      authStorage,
      modelRegistry,
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
