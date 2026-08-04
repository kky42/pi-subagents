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
import { createWorkflowSubagentRunner } from "./subagent-runner.ts";
import { runWorkflow } from "./runtime.ts";
import {
  prepareWorkflowToolSource,
  WORKFLOW_PROMPT_SNIPPET,
  WORKFLOW_TOOL_DESCRIPTION,
  workflowToolParameters,
  type WorkflowToolParams,
} from "./source.ts";

interface WorkflowStatusCallbacks {
  start(ctx: ExtensionContext, taskId: string, name: string): void;
  queueSubagent(ctx: ExtensionContext, taskId: string): void;
  finishSubagent(ctx: ExtensionContext, taskId: string): void;
  refresh(ctx: ExtensionContext): void;
  finish(taskId: string): void;
}

export interface CreateRunWorkflowToolOptions {
  getTaskManager: () => BackgroundTaskManager;
  getLimiter: () => ConcurrencyLimiter;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  getSubagentTimeoutMs: () => number;
  status?: WorkflowStatusCallbacks;
  updateStatus: (ctx: ExtensionContext, taskId: string, usage: SubagentUsage, telemetry: SubagentTelemetry) => void;
}

export function createRunWorkflowTool(
  options: CreateRunWorkflowToolOptions,
): ToolDefinition<typeof workflowToolParameters, WorkflowAcceptedTaskEnvelope> {
  return defineTool({
    name: "run_workflow",
    label: "Run Workflow",
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_PROMPT_SNIPPET,
    parameters: workflowToolParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const name = requiredWorkflowName(params);
      const normalizedParams = { ...params, name };
      const taskManager = options.getTaskManager();
      const accepted = taskManager.start({
        taskType: "workflow",
        name,
        run: async (signal, taskId) => {
          options.status?.start(ctx, taskId, name);
          try {
            const prepared = await prepareWorkflowToolSource(normalizedParams, ctx, taskId, (resumeTaskId) =>
              taskManager.isActive(resumeTaskId));
            if (!prepared.ok) {
              throw new Error(prepared.details.error);
            }

            const {
              script,
              journalWriter,
              resumeSubagentResults,
            } = prepared.value;
            const profiles = filterProfilesForModelRegistry(getSubagentProfiles(getAgentDir()), ctx.modelRegistry);
            const runner = createWorkflowSubagentRunner({
              profiles,
              ctx,
              thinkingLevel: options.getThinkingLevel(),
              timeoutMs: options.getSubagentTimeoutMs(),
              toolCallId: taskId,
              onProgress: ctx.hasUI && options.status ? () => options.status?.refresh(ctx) : undefined,
              onUsage: (index, usage, telemetry) => options.updateStatus(ctx, `${taskId}:subagent:${index}`, usage, telemetry),
            });

            try {
              const result = await runWorkflow(script, {
                args: normalizedParams.args,
                cwd: ctx.cwd,
                signal,
                limiter: options.getLimiter(),
                serializeSubagent: runner.serializeSubagent,
                runSubagent: runner.runSubagent,
                resumeSubagentResults,
                onSubagentQueued: () => options.status?.queueSubagent(ctx, taskId),
                onSubagentEnd: () => options.status?.finishSubagent(ctx, taskId),
                onLog: (message) => {
                  if (journalWriter) {
                    void journalWriter.appendLog(message).catch(() => {});
                  }
                },
                onSubagentResult: async (event) => {
                  runner.restoreSessionBinding(event);
                  await journalWriter?.appendSubagentResult(event);
                },
              });
              try {
                await journalWriter?.complete(result.result);
              } catch {
                // A completed workflow result remains valid when only replay journaling fails.
              }
              return workflowContent(result.result);
            } catch (error) {
              try {
                await journalWriter?.fail(error instanceof Error ? error.message : String(error));
              } catch {
                // Preserve the execution failure as the terminal task result.
              }
              throw error;
            }
          } finally {
            options.status?.finish(taskId);
          }
        },
      });
      return taskToolResult(accepted);
    },
    renderCall(args, theme, context) {
      if (context.executionStarted) {
        return new Text("", 0, 0);
      }
      const name = typeof args.name === "string" ? args.name.trim() : "";
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

function requiredWorkflowName(params: WorkflowToolParams): string {
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!name) {
    throw new Error("Workflow name must contain non-whitespace characters");
  }
  return name;
}

function workflowContent(result: unknown): string {
  return typeof result === "string" ? result : JSON.stringify(result) ?? "null";
}
