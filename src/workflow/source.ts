import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { WorkflowToolDetails } from "../types.ts";
import {
  createWorkflowJournalWriter,
  createWorkflowRunIdentity,
  getSessionWorkflowDir,
  loadWorkflowJournal,
  persistWorkflowScript,
  type WorkflowJournalWriter,
  type WorkflowRunIdentity,
} from "./journal.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "./registry.ts";
import { parseWorkflowScript } from "./script-validation.ts";
import type { WorkflowCachedAgentResult, WorkflowMetaPhase } from "./types.ts";

export const WORKFLOW_PROMPT_SNIPPET = "Run a saved or ad-hoc multi-agent JavaScript workflow";

export const WORKFLOW_TOOL_DESCRIPTION = [
  "Run a trusted JavaScript workflow in the foreground and return its JSON result.",
  "Provide exactly one source: `name`, `scriptPath`, or `script`; use `resumeFromRunId` only with `scriptPath`.",
  "Subagent calls share PiFlow's bounded concurrency and queue when full.",
  "Only run trusted scripts; worker VM isolation detects stalls but is not a security boundary.",
].join(" ");

export const INLINE_WORKFLOW_EXAMPLE = `export const meta = { name: 'inspect_items', description: 'Inspect items in two turns' };
const replySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};
const results = await pipeline(
  args?.items ?? ['src', 'test'],
  (item, _original, index) => agent('Inspect ' + item, {
    label: 'inspect-' + index,
    phase: 'inspect',
    subagent_type: 'general-purpose',
    session_key: 'item-' + index,
    schema: replySchema,
  }),
  async (first, item, index) => {
    if (!first) return { item, first: null, followup: null };
    const followup = await agent('Continue with one-sentence advice.', {
      label: 'followup-' + index,
      phase: 'followup',
      subagent_type: 'general-purpose',
      session_key: 'item-' + index,
      schema: replySchema,
    });
    return { item, first: first.text, followup: followup?.text ?? null };
  },
);
return { results };`;

const INLINE_WORKFLOW_DESCRIPTION = [
  "Raw JavaScript source for an ad-hoc workflow; do not include explanatory prose.",
  "The first statement must be the plain literal `export const meta = { name: 'short_name', description: 'non-empty' }`; optional `phases` entries may contain `title`, `detail`, and `model`.",
  "Available globals are `agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`, and `cwd`.",
  "Call `agent()` at least once, await or return every call, and return a JSON-serializable value.",
  "Agent options are `label`, `phase`, `subagent_type`, `session_key`, and `schema`. `subagent_type` defaults to `general-purpose`; reuse a session key only for the same child. Nonfatal failures resolve to `null`.",
  "`parallel()` takes thunk functions, for example `await parallel([() => agent('A', { label: 'a' }), () => agent('B', { label: 'b' })])`, not promises, and preserves input order. `pipeline(items, ...stages)` preserves stage order per item while items run concurrently; stages receive `(previousValue, originalItem, index)`.",
  "A schema must have root type `object`; every object sets `additionalProperties: false` and lists every property in `required`, with nullable types for optional values. `anyOf` is supported; `oneOf` and `allOf` are not. Schema literals and top-level-const references are preflighted before any child starts. A schema inside a dynamic options object is validated immediately before that call; a dynamic schema value inside a static options object is rejected.",
  "Write plain JavaScript without imports, require, filesystem APIs, Date APIs, or `Math.random()`.",
  `Example showing structured output, concurrent pipeline items, explicit stage returns, null handling, and one resumed child per item:\n${INLINE_WORKFLOW_EXAMPLE}`,
].join("\n");

export const workflowToolParameters = Type.Object({
  script: Type.Optional(Type.String({ description: INLINE_WORKFLOW_DESCRIPTION })),
  name: Type.Optional(
    Type.String({
      description:
        "Registered saved-workflow meta.name. Create reusable workflows as valid .js files under ~/.pi/agent/workflows/ or a trusted project's .pi/workflows/. meta.name must match [a-z0-9][a-z0-9_-]*; the filename may differ.",
    }),
  ),
  scriptPath: Type.Optional(
    Type.String({
      description:
        "Saved or session-persisted .js workflow path resolving inside an allowed global, trusted-project, or current-session workflow root.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed unchanged to the workflow as the global `args`." }),
  ),
  resumeFromRunId: Type.Optional(
    Type.String({
      description:
        "Optional prior run id for replay. Valid only with `scriptPath`; successful cached agent results are reused for the longest unchanged call prefix, then execution continues live.",
    }),
  ),
});

export type WorkflowToolParams = Static<typeof workflowToolParameters>;

export type PreparedWorkflowToolSource = {
  script: string;
  metaName: string;
  plannedPhases?: WorkflowMetaPhase[];
  source: "inline" | "saved" | "path";
  sourcePath?: string;
  scriptPath?: string;
  warnings: string[];
  identity: WorkflowRunIdentity;
  journalWriter?: WorkflowJournalWriter;
  resumeFromRunId?: string;
  resumeAgentResults?: WorkflowCachedAgentResult[];
};

type PrepareErrorDetails = Partial<WorkflowToolDetails> & { name: string; error: string };

export type PrepareWorkflowToolSourceResult =
  | { ok: true; value: PreparedWorkflowToolSource }
  | { ok: false; text: string; details: PrepareErrorDetails };

type WorkflowSource =
  | {
      ok: true;
      script: string;
      source: "inline" | "saved" | "path";
      sourcePath?: string;
      requestedName?: string;
      warnings: string[];
    }
  | { ok: false; message: string; warnings: string[] };

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

function formatWarnings(warnings: string[]): string {
  if (!warnings.length) {
    return "";
  }
  return `\n\nWarnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}

function sourceError(text: string, details: PrepareErrorDetails): PrepareWorkflowToolSourceResult {
  return { ok: false, text, details };
}

function resolveWorkflowSource(params: WorkflowToolParams, ctx: ExtensionContext): WorkflowSource {
  const inlineScript = typeof params.script === "string" && params.script.trim() ? params.script : undefined;
  const savedName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : undefined;
  const scriptPath = typeof params.scriptPath === "string" && params.scriptPath.trim() ? params.scriptPath.trim() : undefined;
  const sourceCount = Number(Boolean(inlineScript)) + Number(Boolean(savedName)) + Number(Boolean(scriptPath));
  if (sourceCount !== 1) {
    return {
      ok: false,
      message:
        "Workflow requires exactly one non-empty source: `script` for an ad-hoc workflow, `name` for a saved workflow, or `scriptPath` for a persisted script.",
      warnings: [],
    };
  }
  if (inlineScript) {
    return { ok: true, script: inlineScript, source: "inline", warnings: [] };
  }

  const sessionWorkflowDir = getSessionWorkflowDir(ctx);
  const projectTrusted = isProjectTrusted(ctx);
  if (scriptPath) {
    const result = loadWorkflowScriptPath(scriptPath, {
      agentDir: getAgentDir(),
      cwd: ctx.cwd,
      projectTrusted,
      sessionWorkflowDir,
    });
    if (!result.ok) {
      return { ok: false, message: result.message, warnings: result.warnings };
    }
    return {
      ok: true,
      script: result.workflow.script,
      source: "path",
      sourcePath: result.workflow.path,
      requestedName: result.workflow.meta.name,
      warnings: result.warnings,
    };
  }

  const registry = loadSavedWorkflowRegistry({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    projectTrusted,
  });
  const workflow = registry.workflows.get(savedName ?? "");
  if (!workflow) {
    return {
      ok: false,
      message: `Unknown saved workflow "${savedName}". Available workflows: ${formatAvailableWorkflowNames([
        ...registry.workflows.keys(),
      ].sort())}.`,
      warnings: registry.warnings,
    };
  }
  return {
    ok: true,
    script: workflow.script,
    source: "saved",
    sourcePath: workflow.path,
    requestedName: savedName,
    warnings: registry.warnings,
  };
}

export function normalizeWorkflowScript(script: string): string {
  let text = typeof script === "string" ? script.trim() : "";
  const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
  if (fence) {
    text = fence[1].trim();
  }
  return text;
}

export async function prepareWorkflowToolSource(
  params: WorkflowToolParams,
  ctx: ExtensionContext,
): Promise<PrepareWorkflowToolSourceResult> {
  const source = resolveWorkflowSource(params, ctx);
  if (!source.ok) {
    return sourceError(`${source.message}${formatWarnings(source.warnings)}`, {
      name: "workflow",
      error: source.message,
      logs: source.warnings,
    });
  }

  const script = normalizeWorkflowScript(source.script);
  let metaName = source.requestedName ?? "workflow";
  let plannedPhases: WorkflowMetaPhase[] | undefined;
  try {
    const parsed = parseWorkflowScript(script);
    metaName = parsed.meta.name;
    plannedPhases = parsed.meta.phases?.map((phase) => ({ ...phase }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sourceError(`Workflow script is invalid; no subagents were started: ${message}`, {
      name: metaName,
      error: message,
      logs: source.warnings,
      source: source.source,
      sourcePath: source.sourcePath,
      scriptPath: source.sourcePath,
    });
  }

  const resumeFromRunId = typeof params.resumeFromRunId === "string" && params.resumeFromRunId.trim()
    ? params.resumeFromRunId.trim()
    : undefined;
  if (resumeFromRunId && source.source !== "path") {
    const message = "Cannot resume workflow: resumeFromRunId can only be used with scriptPath.";
    return sourceError(message, {
      name: metaName,
      error: message,
      logs: source.warnings,
      source: source.source,
      sourcePath: source.sourcePath,
      scriptPath: undefined,
      resumeFromRunId,
    });
  }

  const sessionWorkflowDir = getSessionWorkflowDir(ctx);
  const identity = createWorkflowRunIdentity(script, params.args);
  let scriptPath = source.sourcePath;
  if (source.source === "inline" && sessionWorkflowDir) {
    try {
      scriptPath = await persistWorkflowScript({ dir: sessionWorkflowDir, metaName, scriptHash: identity.scriptHash, script });
    } catch (error) {
      const message = `Workflow persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        runId: identity.runId,
      });
    }
  }

  let resumeAgentResults: WorkflowCachedAgentResult[] | undefined = undefined;
  if (resumeFromRunId) {
    if (!sessionWorkflowDir) {
      const message = "Cannot resume workflow: current session has no persisted workflow state.";
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        runId: identity.runId,
        resumeFromRunId,
      });
    }
    let journal;
    try {
      journal = await loadWorkflowJournal(sessionWorkflowDir, resumeFromRunId);
    } catch (error) {
      const message = `Cannot resume workflow: ${error instanceof Error ? error.message : String(error)}`;
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        runId: identity.runId,
        resumeFromRunId,
      });
    }
    if (!journal) {
      const message = `Cannot resume workflow: run journal not found for ${resumeFromRunId}.`;
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        runId: identity.runId,
        resumeFromRunId,
      });
    }
    resumeAgentResults = journal.agentResults;
  }

  let journalWriter: WorkflowJournalWriter | undefined;
  if (sessionWorkflowDir) {
    try {
      journalWriter = await createWorkflowJournalWriter({
        dir: sessionWorkflowDir,
        identity,
        name: metaName,
        source: source.source,
        scriptPath,
        resumeFromRunId,
      });
    } catch (error) {
      const message = `Workflow journal setup failed: ${error instanceof Error ? error.message : String(error)}`;
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        runId: identity.runId,
        resumeFromRunId,
      });
    }
  }

  return {
    ok: true,
    value: {
      script,
      metaName,
      plannedPhases,
      source: source.source,
      sourcePath: source.sourcePath,
      scriptPath,
      warnings: source.warnings,
      identity,
      journalWriter,
      resumeFromRunId,
      resumeAgentResults,
    },
  };
}
