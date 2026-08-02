import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ConcurrencyLimiter } from "../core/concurrency.ts";
import { filterProfilesForModelRegistry } from "../core/model.ts";
import {
  BackgroundTaskManager,
  taskToolResult,
  type WorkflowAcceptedTaskEnvelope,
} from "../core/task-manager.ts";
import { getSubagentProfiles } from "../profiles.ts";
import type { SubagentTelemetry, SubagentUsage } from "../types.ts";
import { createWorkflowAgentRunner } from "./agent-runner.ts";
import { runWorkflow } from "./runtime.ts";
import {
  prepareWorkflowToolSource,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
  workflowToolParameters,
  type WorkflowToolParams,
} from "./source.ts";

export interface CreateWorkflowToolOptions {
  getTaskManager: () => BackgroundTaskManager;
  getLimiter: () => ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  updateStatus: (ctx: ExtensionContext, taskId: string, usage: SubagentUsage, telemetry: SubagentTelemetry) => void;
}

export function createWorkflowTool(
  options: CreateWorkflowToolOptions,
): ToolDefinition<typeof workflowToolParameters, WorkflowAcceptedTaskEnvelope> {
  return defineTool({
    name: "workflow",
    label: "Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    parameters: workflowToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const accepted = options.getTaskManager().start({
        taskType: "workflow",
        name: initialWorkflowName(params),
        run: async (signal, taskId) => {
          const prepared = await prepareWorkflowToolSource(params, ctx, taskId);
          if (!prepared.ok) {
            throw new Error(prepared.details.error);
          }

          const {
            script,
            metaName,
            journalWriter,
            resumeAgentResults,
          } = prepared.value;
          const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
          const runner = createWorkflowAgentRunner({
            profiles,
            ctx,
            thinkingLevel: options.getThinkingLevel(),
            timeoutMs: options.getSubagentTimeoutMs(),
            toolCallId: taskId,
            onUsage: (index, usage, telemetry) => options.updateStatus(ctx, `${taskId}:agent:${index}`, usage, telemetry),
          });

          try {
            const result = await runWorkflow(script, {
              args: params.args,
              cwd: ctx.cwd,
              signal,
              limiter: options.getLimiter(),
              serializeAgent: runner.serializeAgent,
              runAgent: runner.runAgent,
              resumeAgentResults,
              onAgentResult: async (event) => {
                runner.restoreSessionBinding(event);
                await journalWriter?.appendAgentResult(event);
              },
            });
            try {
              await journalWriter?.complete(result.result);
            } catch {
              // A completed workflow result remains valid when only replay journaling fails.
            }
            return {
              name: result.meta.name,
              content: workflowContent(result.result),
            };
          } catch (error) {
            try {
              await journalWriter?.fail(error instanceof Error ? error.message : String(error));
            } catch {
              // Preserve the execution failure as the terminal task result.
            }
            throw error;
          }
        },
      });
      return taskToolResult(accepted);
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const name = initialWorkflowName(args);
      return new Text(`${theme.bold("Workflow")} ${theme.fg("muted", name)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WorkflowAcceptedTaskEnvelope;
      return new Text(
        `${theme.bold("Workflow")} ${theme.fg("muted", details.name)} ${theme.fg("dim", `accepted ${details.task_id}`)}`,
        0,
        0,
      );
    },
  });
}

function initialWorkflowName(params: WorkflowToolParams): string {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (name) {
    return name;
  }
  if (typeof params.script === "string" && params.script.trim()) {
    const prefix = params.script.slice(0, 4096);
    const match = prefix.match(
      /^\s*(?:```(?:js|javascript)?\s*)?export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*(['"])([a-z0-9][a-z0-9_-]*)\1/i,
    );
    return match?.[2] ?? "workflow";
  }
  if (typeof params.scriptPath === "string" && params.scriptPath.trim()) {
    return params.scriptPath.trim().split(/[\\/]/).at(-1)?.replace(/\.js$/i, "") || "workflow";
  }
  return "workflow";
}

function workflowContent(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  return JSON.stringify(result) ?? "null";
}
