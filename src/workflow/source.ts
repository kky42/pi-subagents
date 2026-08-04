import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WorkflowToolParams } from "../pi-workflow.ts";
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
import type { WorkflowCachedSubagentResult } from "./types.ts";

export type PreparedWorkflowToolSource = {
  script: string;
  journalWriter?: WorkflowJournalWriter;
  resumeSubagentResults?: WorkflowCachedSubagentResult[];
};

interface PrepareErrorDetails {
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
    }
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
    return { ok: true, script: inlineScript, source: "inline" };
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
      return { ok: false, message: result.message };
    }
    return {
      ok: true,
      script: result.workflow.script,
      source: "path",
      sourcePath: result.workflow.path,
    };
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
  return {
    ok: true,
    script: workflow.script,
    source: "saved",
    sourcePath: workflow.path,
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
  const workflowName = params.name.trim();
  const resumeFromTaskId = typeof params.resume_from_task_id === "string" && params.resume_from_task_id.trim()
    ? params.resume_from_task_id.trim()
    : undefined;
  const hasExplicitReplayScriptPath = typeof params.script_path === "string" && params.script_path.trim().length > 0;
  const sessionWorkflowDir = getSessionWorkflowDir(ctx);
  if (resumeFromTaskId && params.script) {
    return sourceError(
      "Cannot resume workflow: resume_from_task_id may only be used with name and optional script_path.",
    );
  }

  let resumeJournal: LoadedWorkflowJournal | undefined;
  let sourceParams = params;
  if (resumeFromTaskId) {
    if (!sessionWorkflowDir) {
      return sourceError("Cannot resume workflow: current session has no persisted workflow state.");
    }
    try {
      resumeJournal = await loadWorkflowJournal(sessionWorkflowDir, resumeFromTaskId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return sourceError(
        `Cannot resume workflow: task journal for ${resumeFromTaskId} could not be read: ${redactAbsolutePaths(detail)}`,
      );
    }
    if (!resumeJournal) {
      return sourceError(`Cannot resume workflow: task journal not found for ${resumeFromTaskId}.`);
    }
    if (resumeJournal.name !== workflowName) {
      return sourceError(
        `Cannot resume workflow: task ${resumeFromTaskId} belongs to workflow "${resumeJournal.name ?? "unknown"}", not "${workflowName}".`,
      );
    }
    if (resumeJournal.status === "running" && isTaskActive(resumeFromTaskId)) {
      return sourceError(`Cannot resume workflow: task ${resumeFromTaskId} is still running.`);
    }
    if (!hasExplicitReplayScriptPath && !resumeJournal.scriptPath) {
      return sourceError(`Cannot resume workflow: task ${resumeFromTaskId} has no persisted script.`);
    }
    if (!hasExplicitReplayScriptPath) {
      sourceParams = { ...params, script_path: resumeJournal.scriptPath };
    }
  }

  const source = resolveWorkflowSource(sourceParams, ctx);
  if (!source.ok) {
    return sourceError(redactAbsolutePaths(source.message));
  }

  const script = normalizeWorkflowScript(source.script);
  let scriptName: string;
  try {
    scriptName = parseWorkflowScript(script).meta.name.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return sourceError(`Workflow script is invalid; no subagents were started: ${message}`);
  }
  if (scriptName !== workflowName) {
    return sourceError(`Workflow name "${workflowName}" does not match script meta.name "${scriptName}".`);
  }

  const identity = createWorkflowTaskIdentity(taskId, script, params.args);
  if (resumeFromTaskId && !hasExplicitReplayScriptPath && resumeJournal?.scriptHash !== identity.scriptHash) {
    return sourceError(`Cannot resume workflow: persisted script for task ${resumeFromTaskId} has changed.`);
  }
  let scriptPath = source.sourcePath;
  if (sessionWorkflowDir) {
    try {
      scriptPath = await persistWorkflowScript({
        dir: sessionWorkflowDir,
        metaName: workflowName,
        scriptHash: identity.scriptHash,
        script,
      });
    } catch {
      return sourceError("Workflow persistence failed.");
    }
  }

  const resumeSubagentResults: WorkflowCachedSubagentResult[] | undefined = resumeJournal?.subagentResults;

  let journalWriter: WorkflowJournalWriter | undefined;
  if (sessionWorkflowDir) {
    try {
      journalWriter = await createWorkflowJournalWriter({
        dir: sessionWorkflowDir,
        identity,
        name: workflowName,
        source: source.source,
        scriptPath,
        resumeFromTaskId,
      });
    } catch {
      return sourceError("Workflow journal setup failed.");
    }
  }

  return {
    ok: true,
    value: {
      script,
      journalWriter,
      resumeSubagentResults,
    },
  };
}
