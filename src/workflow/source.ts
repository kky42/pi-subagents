import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowToolParams } from "../pi-workflow.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "./registry.ts";
import { parseWorkflowScript } from "./script-validation.ts";
import type { WorkflowMeta } from "./types.ts";

export type PreparedWorkflowToolSource = {
  script: string;
  meta: WorkflowMeta;
  body: string;
};
interface PrepareErrorDetails {
  error: string;
}

export type PrepareWorkflowToolSourceResult =
  | { ok: true; value: PreparedWorkflowToolSource }
  | { ok: false; details: PrepareErrorDetails };

type WorkflowSource =
  | { ok: true; script: string }
  | { ok: false; message: string };

function isProjectTrusted(ctx: ExtensionContext): boolean {
  try {
    return ctx.isProjectTrusted();
  } catch {
    return false;
  }
}

function formatAvailableWorkflowNames(names: string[]): string {
  return names.length ? names.join(", ") : "none";
}

function redactAbsolutePaths(message: string): string {
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:]+/g, "<path>");
}

function sourceError(error: string): PrepareWorkflowToolSourceResult {
  return { ok: false, details: { error } };
}

function resolveWorkflowSource(params: WorkflowToolParams, ctx: ExtensionContext): WorkflowSource {
  const inlineScript = typeof params.script === "string" && params.script.trim() ? params.script : undefined;
  const savedName = params.name.trim();
  const scriptPath = typeof params.script_path === "string" && params.script_path.trim() ? params.script_path.trim() : undefined;
  if (inlineScript && scriptPath) {
    return {
      ok: false,
      message: "Workflow accepts at most one script source: `script` or `script_path`.",
    };
  }
  if (inlineScript) {
    return { ok: true, script: inlineScript };
  }

  const projectTrusted = isProjectTrusted(ctx);
  if (scriptPath) {
    const result = loadWorkflowScriptPath(scriptPath, {
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted,
    });
    if (!result.ok) {
      return { ok: false, message: result.message };
    }
    return { ok: true, script: result.workflow.script };
  }

  const registry = loadSavedWorkflowRegistry({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    projectTrusted,
  });
  const workflow = registry.workflows.get(savedName);
  if (!workflow) {
    return {
      ok: false,
      message: `Unknown saved workflow "${savedName}". Available workflows: ${formatAvailableWorkflowNames([
        ...registry.workflows.keys(),
      ].sort())}.`,
    };
  }
  return { ok: true, script: workflow.script };
}

export function normalizeWorkflowScript(script: string): string {
  let text = typeof script === "string" ? script.trim() : "";
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) {
    text = fence[1].trim();
  }
  return text;
}

export function prepareWorkflowToolSource(
  params: WorkflowToolParams,
  ctx: ExtensionContext,
): PrepareWorkflowToolSourceResult {
  const workflowName = params.name.trim();
  const source = resolveWorkflowSource(params, ctx);
  if (!source.ok) {
    return sourceError(redactAbsolutePaths(source.message));
  }

  const script = normalizeWorkflowScript(source.script);
  let parsed: { meta: WorkflowMeta; body: string };
  try {
    parsed = parseWorkflowScript(script);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sourceError(`Workflow script is invalid; no subagents were started: ${message}`);
  }
  const scriptName = parsed.meta.name.trim();
  if (scriptName !== workflowName) {
    return sourceError(`Workflow name "${workflowName}" does not match script meta.name "${scriptName}".`);
  }

  return { ok: true, value: { script, meta: parsed.meta, body: parsed.body } };
}
