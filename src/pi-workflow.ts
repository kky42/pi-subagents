import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { ConcurrencyLimiter } from "./core/concurrency.ts";
import { filterProfilesForModelRegistry } from "./core/model.ts";
import {
  BackgroundTaskManager,
  taskToolResult,
  type WorkflowAcceptedTaskEnvelope,
} from "./core/task-manager.ts";
import { getSubagentProfiles } from "./profiles.ts";
import type { SubagentTelemetry, SubagentUsage } from "./types.ts";
import { runWorkflow } from "./workflow/runtime.ts";
import { prepareWorkflowToolSource } from "./workflow/source.ts";
import { createWorkflowSubagentRunner } from "./workflow/subagent-runner.ts";

const WORKFLOW_PROMPT_SNIPPET = "Orchestrate dependent or larger multi-agent work";

const WORKFLOW_PROMPT_GUIDELINES = [
  "Always provide name. Omit script and script_path to run that saved workflow; replay with the same name and resume_from_task_id.",
  "Only run trusted workflow scripts; worker VM isolation detects stalls but is not a security boundary.",
];

const WORKFLOW_TOOL_DESCRIPTION = [
  "Use run_workflow for multi-agent orchestration that requires dependent stages, branching, structured outputs, replay, or larger fan-out.",
  "Run a matching saved workflow when available; otherwise provide a trusted ad-hoc script.",
].join(" ");

export const workflowToolParameters = Type.Object({
  name: Type.String({
    minLength: 1,
    pattern: ".*\\S.*",
    description: "Workflow meta.name; required and must match the selected script, path, or replay journal.",
  }),
  script: Type.Optional(
    Type.String({
      description: "Trusted ad-hoc workflow JavaScript source whose meta.name matches name; do not include explanatory prose.",
    }),
  ),
  script_path: Type.Optional(
    Type.String({
      description: "Path to a trusted saved or session-persisted workflow script whose meta.name matches name.",
    }),
  ),
  args: Type.Optional(
    Type.Any({ description: "Optional JSON value exposed unchanged to the workflow as the global `args`." }),
  ),
  resume_from_task_id: Type.Optional(
    Type.String({
      description:
        "Prior workflow task ID to replay with the same name. Add script_path for an edited replay; the longest unchanged successful prefix is reused.",
    }),
  ),
}, { additionalProperties: false });

export type WorkflowToolParams = Static<typeof workflowToolParameters>;

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
    promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
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
      return new Text(`${theme.bold("Workflow")}${theme.fg("muted", `(${name})`)}`, 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as WorkflowAcceptedTaskEnvelope;
      return new Text(
        `${theme.bold("Workflow")}${theme.fg("muted", `(${details.name})`)} ${theme.fg("dim", `accepted ${details.task_id}`)}`,
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
