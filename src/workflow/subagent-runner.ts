import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "../core/spawn.ts";
import { assertBindingMatchesProfile, SessionKeyLocks, type SessionKeyBinding } from "../core/session-key.ts";
import { resolveProfileModel, usesPiBackend } from "../core/model.ts";
import type { SubagentBackend, SubagentProfile, SubagentTelemetry, SubagentToolDetails, SubagentUsage } from "../types.ts";
import type { WorkflowSubagentRunner } from "./types.ts";
import { createStructuredOutputTool, STRUCTURED_OUTPUT_CONTRACT, WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE, type StructuredOutputCapture } from "./structured-output.ts";

export interface WorkflowSubagentRunnerOptions {
  profiles: Map<string, SubagentProfile>;
  ctx: ExtensionContext;
  thinkingLevel?: string;
  timeoutMs: number;
  allowedBackends?: readonly SubagentBackend[];
  onUsage?: (index: number, usage: SubagentUsage, telemetry: SubagentTelemetry) => void;
  onProgress?: (index: number, details: SubagentToolDetails, usage?: SubagentUsage) => void;
  /** Seed the session-key table, e.g. with bindings a previous runner reported. Later entries win on duplicate keys, matching latest-wins persisted-entry replay. */
  initialSessionBindings?: readonly SessionKeyBinding[];
  /** Observes every write to the session-key table, so an embedder can carry bindings across runner instances. */
  onSessionBinding?: (binding: SessionKeyBinding) => void;
}

/** Canonical profile-aware runner shared by the interactive tool and headless API. */
export function createWorkflowSubagentRunner(options: WorkflowSubagentRunnerOptions): {
  runSubagent: WorkflowSubagentRunner;
  serializeSubagent: <T>(sessionKey: string | undefined, task: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
} {
  const bindings = new Map<string, SessionKeyBinding>(
    (options.initialSessionBindings ?? []).map((binding) => [binding.key, binding]),
  );
  const locks = new SessionKeyLocks();
  let sequence = 0;
  const allowed = options.allowedBackends ? new Set(options.allowedBackends) : undefined;

  const runSubagent: WorkflowSubagentRunner = async (call, signal) => {
    const profile = options.profiles.get(call.profile);
    if (!profile) throw new Error(`Unknown profile "${call.profile}".`);
    if (allowed && !allowed.has(profile.backend)) throw new Error(`Backend "${profile.backend}" is not allowed.`);
    const model = resolveProfileModel(profile, options.ctx);
    if (usesPiBackend(profile) && !model) throw new Error(profile.model ? `Profile model not found: ${profile.model}` : "No model is selected");

    let capture: StructuredOutputCapture | undefined;
    let customTools: ToolDefinition[] | undefined;
    const externalSchema = !usesPiBackend(profile) && call.schema != null;
    let appendInstructions = WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE;
    if (call.schema != null && !externalSchema) {
      capture = { value: undefined, called: false, count: 0, duplicateCall: false };
      customTools = [createStructuredOutputTool(call.schema, capture)];
      appendInstructions = STRUCTURED_OUTPUT_CONTRACT;
    } else if (externalSchema) {
      appendInstructions = `${WORKFLOW_PLAIN_TEXT_OUTPUT_NOTE}\nStructured output contract:\n- Return only JSON matching the schema supplied to the CLI. No markdown fences or prose.`;
    }

    const index = call.index ?? ++sequence;
    const binding = call.sessionKey ? bindings.get(call.sessionKey) : undefined;
    if (binding) assertBindingMatchesProfile(binding, { profile: call.profile, backend: profile.backend });
    call.backend = profile.backend;
    call.sessionId = binding?.sessionId;
    const result = await spawnSubagent({
      label: call.label,
      prompt: call.prompt,
      profile,
      model,
      thinkingLevel: profile.thinking ?? options.thinkingLevel,
      ctx: options.ctx,
      signal,
      timeoutMs: options.timeoutMs,
      progressEnabled: Boolean(options.onProgress),
      onProgress: (partial) => options.onProgress?.(index, partial.details as SubagentToolDetails, partial.usage),
      onUsage: (usage, telemetry) => options.onUsage?.(index, usage, telemetry),
      excludeTools: CHILD_EXCLUDED_TOOLS,
      appendInstructions,
      customTools,
      sessionId: binding?.sessionId,
      persistSession: Boolean(call.sessionKey),
      outputSchema: externalSchema ? call.schema : undefined,
    });
    const details = result.details as SubagentToolDetails;
    options.onProgress?.(index, details, result.usage);
    if (call.sessionKey && details.sessionId) {
      call.sessionId = details.sessionId;
      const next: SessionKeyBinding = { key: call.sessionKey, sessionId: details.sessionId, profile: call.profile, backend: profile.backend };
      bindings.set(call.sessionKey, next);
      options.onSessionBinding?.(next);
    }
    if (details.status !== "done") throw new Error(details.error ?? "subagent failed");
    if (call.sessionKey && !details.sessionId) throw new Error("subagent completed without a resumable session ID");
    if (externalSchema) {
      try { return JSON.parse(details.result ?? "null"); } catch { throw new Error("external subagent structured output was not valid JSON"); }
    }
    if (capture) {
      if (!capture.called) throw new Error("subagent finished without calling structured_output");
      return capture.value;
    }
    return details.result ?? "";
  };

  return { runSubagent, serializeSubagent: (key, task, signal) => locks.run(key, task, signal) };
}
