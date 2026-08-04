import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
  createWorkflowJournalWriter,
  createWorkflowTaskIdentity,
  getSessionWorkflowDir,
  loadWorkflowJournal,
  persistWorkflowScript,
  type LoadedWorkflowJournal,
  type WorkflowJournalWriter,
} from "./journal.ts";
import { loadSavedWorkflowRegistry, loadWorkflowScriptPath } from "./registry.ts";
import { parseWorkflowScript } from "./script-validation.ts";
import type { WorkflowCachedAgentResult } from "./types.ts";

export const WORKFLOW_PROMPT_SNIPPET = "Run a saved or ad-hoc multi-agent JavaScript workflow";

export const WORKFLOW_TOOL_DESCRIPTION = [
  "Launch a trusted JavaScript workflow as a background task and return its task ID immediately.",
  "Provide exactly one source: `name`, `scriptPath`, or `script`; a prior workflow can instead be replayed with `resumeFromTaskId`.",
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
  "Agent options are `label`, `phase`, `subagent_type`, `session_key`, and `schema`. `subagent_type` defaults to `general-purpose`; calls using the same workflow-local session key continue the same child conversation and are serialized. Nonfatal failures resolve to `null`.",
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
  resumeFromTaskId: Type.Optional(
    Type.String({
      description:
        "Optional prior workflow task ID for replay. Use it alone to replay the persisted script, or with `scriptPath` to replay an edited script. Successful cached agent results are reused for the longest unchanged call prefix, then execution continues live.",
    }),
  ),
});

export type WorkflowToolParams = Static<typeof workflowToolParameters>;

export type PreparedWorkflowToolSource = {
  script: string;
  metaName: string;
  journalWriter?: WorkflowJournalWriter;
  resumeAgentResults?: WorkflowCachedAgentResult[];
};

interface PrepareErrorDetails {
  name: string;
  error: string;
}

export type PrepareWorkflowToolSourceResult =
  | { ok: true; value: PreparedWorkflowToolSource }
  | { ok: false; details: PrepareErrorDetails };

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

function redactAbsolutePaths(message: string): string {
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:]+/g, "<path>");
}

function sourceError(
  _text: string,
  details: PrepareErrorDetails & Record<string, unknown>,
): PrepareWorkflowToolSourceResult {
  return { ok: false, details: { name: details.name, error: details.error } };
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
  taskId: string,
  isTaskActive: (taskId: string) => boolean = () => false,
): Promise<PrepareWorkflowToolSourceResult> {
  const resumeFromTaskId = typeof params.resumeFromTaskId === "string" && params.resumeFromTaskId.trim()
    ? params.resumeFromTaskId.trim()
    : undefined;
  const hasExplicitReplayScriptPath = typeof params.scriptPath === "string" && params.scriptPath.trim().length > 0;
  const sessionWorkflowDir = getSessionWorkflowDir(ctx);
  if (resumeFromTaskId && (params.script || params.name)) {
    const message = "Cannot resume workflow: resumeFromTaskId may only be used alone or with scriptPath.";
    return sourceError(message, { name: "workflow", error: message, resumeFromTaskId });
  }

  let resumeJournal: LoadedWorkflowJournal | undefined;
  let sourceParams = params;
  if (resumeFromTaskId && !hasExplicitReplayScriptPath) {
    if (!sessionWorkflowDir) {
      const message = "Cannot resume workflow: current session has no persisted workflow state.";
      return sourceError(message, { name: "workflow", error: message, resumeFromTaskId });
    }
    try {
      resumeJournal = await loadWorkflowJournal(sessionWorkflowDir, resumeFromTaskId);
    } catch {
      const message = `Cannot resume workflow: task journal for ${resumeFromTaskId} could not be read.`;
      return sourceError(message, { name: "workflow", error: message, resumeFromTaskId });
    }
    if (!resumeJournal) {
      const message = `Cannot resume workflow: task journal not found for ${resumeFromTaskId}.`;
      return sourceError(message, { name: "workflow", error: message, resumeFromTaskId });
    }
    if (resumeJournal.status === "running" && isTaskActive(resumeFromTaskId)) {
      const message = `Cannot resume workflow: task ${resumeFromTaskId} is still running.`;
      return sourceError(message, { name: resumeJournal.name ?? "workflow", error: message, resumeFromTaskId });
    }
    if (!resumeJournal.scriptPath) {
      const message = `Cannot resume workflow: task ${resumeFromTaskId} has no persisted script.`;
      return sourceError(message, { name: resumeJournal.name ?? "workflow", error: message, resumeFromTaskId });
    }
    sourceParams = { ...params, scriptPath: resumeJournal.scriptPath };
  }

  const source = resolveWorkflowSource(sourceParams, ctx);
  if (!source.ok) {
    const message = redactAbsolutePaths(source.message);
    return sourceError(message, {
      name: "workflow",
      error: message,
    });
  }

  const script = normalizeWorkflowScript(source.script);
  let metaName = source.requestedName ?? "workflow";
  try {
    metaName = parseWorkflowScript(script).meta.name;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const publicError = `Workflow script is invalid; no subagents were started: ${message}`;
    return sourceError(publicError, {
      name: metaName,
      error: publicError,
      logs: source.warnings,
      source: source.source,
      sourcePath: source.sourcePath,
      scriptPath: source.sourcePath,
    });
  }

  const identity = createWorkflowTaskIdentity(taskId, script, params.args);
  if (resumeFromTaskId && !hasExplicitReplayScriptPath && resumeJournal?.scriptHash !== identity.scriptHash) {
    const message = `Cannot resume workflow: persisted script for task ${resumeFromTaskId} has changed.`;
    return sourceError(message, {
      name: metaName,
      error: message,
      logs: source.warnings,
      source: source.source,
      sourcePath: source.sourcePath,
      scriptPath: source.sourcePath,
      taskId: identity.taskId,
      resumeFromTaskId,
    });
  }
  let scriptPath = source.sourcePath;
  if (sessionWorkflowDir) {
    try {
      scriptPath = await persistWorkflowScript({ dir: sessionWorkflowDir, metaName, scriptHash: identity.scriptHash, script });
    } catch {
      const message = "Workflow persistence failed.";
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        taskId: identity.taskId,
      });
    }
  }

  let resumeAgentResults: WorkflowCachedAgentResult[] | undefined = undefined;
  if (resumeFromTaskId) {
    if (!sessionWorkflowDir) {
      const message = "Cannot resume workflow: current session has no persisted workflow state.";
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        taskId: identity.taskId,
        resumeFromTaskId,
      });
    }
    if (!resumeJournal) {
      try {
        resumeJournal = await loadWorkflowJournal(sessionWorkflowDir, resumeFromTaskId);
      } catch {
        const message = `Cannot resume workflow: task journal for ${resumeFromTaskId} could not be read.`;
        return sourceError(message, {
          name: metaName,
          error: message,
          logs: source.warnings,
          source: source.source,
          sourcePath: source.sourcePath,
          scriptPath,
          taskId: identity.taskId,
          resumeFromTaskId,
        });
      }
    }
    if (!resumeJournal) {
      const message = `Cannot resume workflow: task journal not found for ${resumeFromTaskId}.`;
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        taskId: identity.taskId,
        resumeFromTaskId,
      });
    }
    if (resumeJournal.status === "running" && isTaskActive(resumeFromTaskId)) {
      const message = `Cannot resume workflow: task ${resumeFromTaskId} is still running.`;
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        taskId: identity.taskId,
        resumeFromTaskId,
      });
    }
    resumeAgentResults = resumeJournal.agentResults;
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
        resumeFromTaskId,
      });
    } catch {
      const message = "Workflow journal setup failed.";
      return sourceError(message, {
        name: metaName,
        error: message,
        logs: source.warnings,
        source: source.source,
        sourcePath: source.sourcePath,
        scriptPath,
        taskId: identity.taskId,
        resumeFromTaskId,
      });
    }
  }

  return {
    ok: true,
    value: {
      script,
      metaName,
      journalWriter,
      resumeAgentResults,
    },
  };
}
