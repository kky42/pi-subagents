import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { MAX_MODEL_VISIBLE_TEXT_CHARS } from "../src/core/progress.ts";
import {
  MAX_WORKFLOW_DETAILS_JSON_CHARS,
  MAX_WORKFLOW_UPDATE_JSON_CHARS,
  WORKFLOW_ACTIVITY_PREVIEW_CHARS,
  WORKFLOW_ACTIVITY_PREVIEW_LINES,
  WORKFLOW_DISPLAY_LOG_LIMIT,
  WORKFLOW_DISPLAY_PHASE_LIMIT,
  WORKFLOW_DISPLAY_SUBAGENT_LIMIT,
  WORKFLOW_LOG_PREVIEW_CHARS,
  WORKFLOW_PHASE_PREVIEW_CHARS,
  WORKFLOW_RESULT_PREVIEW_CHARS,
} from "../src/pi-workflow.ts";
import type { WorkflowToolDetails } from "../src/types.ts";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

const TASK_NOTIFICATION_TYPE = "pi-flow-task-notification";

type TerminalWorkflow = {
  task_id: string;
  task_type: "workflow";
  status: "completed" | "failed";
  name: string;
  content: string;
};

type WorkflowToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: WorkflowToolDetails;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil<T>(read: () => T | undefined, timeoutMs = 1_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await delay(2);
  }
  throw new Error("condition was not met before timeout");
}

function taskNotifications(session: { messages: readonly any[] }): unknown[] {
  return session.messages.filter((message) => message.customType === TASK_NOTIFICATION_TYPE);
}

async function executeWorkflow(
  session: { messages: readonly any[]; getToolDefinition: (name: string) => unknown },
  params: Record<string, unknown>,
  context: unknown,
  onUpdate?: (result: WorkflowToolResult) => void,
): Promise<{ result: WorkflowToolResult; terminal: TerminalWorkflow }> {
  const tool = session.getToolDefinition("run_workflow") as any;
  const result = await tool.execute("workflow-test", params, undefined, onUpdate, context) as WorkflowToolResult;
  const terminal = JSON.parse(result.content[0]?.text ?? "null") as TerminalWorkflow;

  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(terminal) }]);
  expect(Object.keys(terminal).sort()).toEqual(["content", "name", "status", "task_id", "task_type"]);
  expect(terminal).toMatchObject({ task_type: "workflow", name: params.name });
  expect(terminal.task_id).toMatch(/^task_[a-f0-9]+$/);
  expect(result.details).toMatchObject({ taskId: terminal.task_id, name: terminal.name });
  if (terminal.status === "completed") {
    expect(result.details.status).toBe("completed");
  } else {
    expect(["error", "aborted"]).toContain(result.details.status);
  }
  expect(taskNotifications(session)).toEqual([]);
  return { result, terminal };
}

function workflowStateDir(tempDir: string): string {
  return join(tempDir, "sessions", "session.workflows");
}

describe("pi-subagent workflow integration", () => {
  let tempDir = "";
  let agentDir = "";

  const {
    createSession,
    disposeSession,
    makeExecutionContext,
    getToolNames,
    setContextRoutingResponses,
  } = setupPiSubagentTestHarness((state) => {
    tempDir = state.tempDir;
    agentDir = state.agentDir;
  });

  it("waits for a real child and returns terminal details, progress, and usage without notifications", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    let releaseChild: (() => void) | undefined;
    registration.setResponses([
      async () => {
        await new Promise<void>((resolve) => {
          releaseChild = resolve;
        });
        return fauxAssistantMessage("child analysis done");
      },
    ]);

    const updates: WorkflowToolResult[] = [];
    const script = `export const meta = { name: 'inspect', description: 'inspect a module' };\nreturn await run_agent('analyze the module', { label: 'analyze' });`;
    let settled = false;
    const pending = executeWorkflow(
      session,
      { name: "inspect", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
      (update) => updates.push(update),
    ).then(
      (value) => {
        settled = true;
        return value;
      },
      (error: unknown) => {
        settled = true;
        throw error;
      },
    );

    await waitUntil(() => releaseChild);
    expect(settled).toBe(false);
    expect(taskNotifications(session)).toEqual([]);
    releaseChild?.();

    const { result, terminal } = await pending;
    expect(terminal).toEqual({
      task_id: result.details.taskId,
      task_type: "workflow",
      status: "completed",
      name: "inspect",
      content: "child analysis done",
    });
    expect(result.details).toMatchObject({
      status: "completed",
      result: "child analysis done",
      subagentCount: 1,
      subagents: [{ label: "analyze", status: "done", result: "child analysis done" }],
    });
    expect(updates.some((update) => update.details.subagents.some((subagent) => subagent.status === "queued"))).toBe(true);
    expect(updates.some((update) => update.details.subagents.some((subagent) => subagent.status === "running"))).toBe(true);
    expect(updates.some((update) => update.details.subagents.some((subagent) => subagent.status === "done"))).toBe(true);
    expect(result.usage?.input).toBeGreaterThan(0);
    expect(result.usage?.output).toBeGreaterThan(0);
    expect(result.details.subagents[0]?.usage?.totalTokens).toBeGreaterThan(0);
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("bounds completed child previews without spinner-only RPC update amplification", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ mode: "rpc" });
    const largeResult = "large-child-result ".repeat(2_000);
    let releaseSlowChild: (() => void) | undefined;
    setContextRoutingResponses(registration, async (providerContext) => {
      const messages = JSON.stringify(providerContext.messages);
      if (messages.includes("wait for release")) {
        await new Promise<void>((resolve) => {
          releaseSlowChild = resolve;
        });
        return fauxAssistantMessage("slow child done");
      }
      if (messages.includes("return a large result")) {
        return fauxAssistantMessage(largeResult);
      }
      throw new Error(`Unexpected child prompt: ${messages}`);
    });

    const updates: WorkflowToolResult[] = [];
    const script = `export const meta = { name: 'bounded_progress', description: 'Bound child progress previews' };
return await parallel([
  () => run_agent('return a large result', { label: 'large' }),
  () => run_agent('wait for release', { label: 'slow' }),
]);`;
    const pending = executeWorkflow(
      session,
      { name: "bounded_progress", script },
      { ...makeExecutionContext({ hasUI: true, model, modelRegistry }), mode: "rpc" },
      (update) => updates.push(update),
    );
    let stalledSnapshot: WorkflowToolResult | undefined;

    try {
      const snapshot = await waitUntil(() => updates.find((update) => {
        const large = update.details.subagents.find((subagent) => subagent.label === "large");
        const slow = update.details.subagents.find((subagent) => subagent.label === "slow");
        return large?.status === "done" && slow?.status === "running" ? update : undefined;
      }), 3_000);
      stalledSnapshot = snapshot;
      const completedPreview = snapshot.details.subagents.find((subagent) => subagent.label === "large");
      expect(completedPreview?.result).toContain("[truncated]");
      expect(completedPreview?.result?.length).toBeLessThanOrEqual(2_000);
      expect(completedPreview?.activity?.every((line) => line.length <= 240)).toBe(true);

      const immutableSnapshot = JSON.stringify(snapshot.details);
      await delay(250);
      expect(updates.every((update) => update.details.frame === undefined)).toBe(true);
      expect(JSON.stringify(snapshot.details)).toBe(immutableSnapshot);
    } finally {
      releaseSlowChild?.();
    }

    const { result, terminal } = await pending;
    expect(terminal.content).toContain("[truncated]");
    expect(terminal.content.length).toBeLessThanOrEqual(MAX_MODEL_VISIBLE_TEXT_CHARS);
    expect(terminal.content).toContain("large-child-result");
    expect(result.details.subagents.find((subagent) => subagent.label === "large")?.result).toContain("[truncated]");
    expect(result.details.subagents.find((subagent) => subagent.label === "slow")?.status).toBe("done");
    expect(stalledSnapshot?.details.subagents.find((subagent) => subagent.label === "slow")?.status).toBe("running");
    expect(JSON.stringify(result.details.result).length).toBeLessThanOrEqual(2_100);
    expect(result.usage?.totalTokens).toBeGreaterThan(0);
    disposeSession(session);
  });

  it("bounds aggregate workflow snapshots while preserving totals, terminal content, and journals", async () => {
    const childCount = 32;
    const { session, registration, model, modelRegistry } = await createSession({ mode: "rpc" });
    const fullResults = Array.from(
      { length: childCount },
      (_, index) => `RESULT_${index}:${"result ".repeat(800)}RESULT_TAIL_${index}`,
    );
    registration.setResponses(fullResults.map((text) => fauxAssistantMessage(text)));

    const updateSizes: number[] = [];
    const immutableSamples: Array<{ update: WorkflowToolResult; serialized: string }> = [];
    const script = `export const meta = { name: 'stress_progress', description: 'Stress bounded progress snapshots' };
const tasks = [];
for (let index = 0; index < ${childCount}; index++) {
  const phaseTitle = 'phase-' + index + '-' + 'P'.repeat(1000) + '-PHASE_TAIL_' + index;
  phase(phaseTitle);
  log('log-' + index + '-' + 'L'.repeat(1000) + '-LOG_TAIL_' + index);
  tasks.push(() => run_agent('child ' + index, {
    label: 'agent-' + index + '-' + 'A'.repeat(1000) + '-LABEL_TAIL_' + index,
    phase: phaseTitle,
  }));
}
return await parallel(tasks);`;
    const { result, terminal } = await executeWorkflow(
      session,
      { name: "stress_progress", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
      (update) => {
        const serialized = JSON.stringify(update);
        updateSizes.push(serialized.length);
        if (immutableSamples.length < 5) {
          immutableSamples.push({ update, serialized });
        }
      },
    );

    expect(updateSizes.length).toBeGreaterThan(childCount);
    expect(Math.max(...updateSizes)).toBeLessThanOrEqual(MAX_WORKFLOW_UPDATE_JSON_CHARS);
    expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(MAX_WORKFLOW_DETAILS_JSON_CHARS);
    expect(result.details).toMatchObject({
      subagentCount: childCount,
      phaseCount: childCount,
      logCount: childCount,
      subagentStatusCounts: { queued: 0, running: 0, done: childCount, error: 0, aborted: 0 },
    });
    expect(result.details.subagents.length).toBeLessThanOrEqual(WORKFLOW_DISPLAY_SUBAGENT_LIMIT);
    const displayedTokens = result.details.subagents.reduce(
      (total, subagent) => total + (subagent.usage?.totalTokens ?? 0),
      0,
    );
    expect(result.usage?.totalTokens).toBeGreaterThan(displayedTokens);
    expect(result.details.phaseSummaries.length).toBeLessThanOrEqual(WORKFLOW_DISPLAY_PHASE_LIMIT);
    expect(result.details.logs.length).toBeLessThanOrEqual(WORKFLOW_DISPLAY_LOG_LIMIT);
    expect(result.details.logs.every((line) => line.length <= WORKFLOW_LOG_PREVIEW_CHARS)).toBe(true);
    expect(result.details.phaseSummaries.every((phase) =>
      phase.title === undefined || phase.title.length <= WORKFLOW_PHASE_PREVIEW_CHARS)).toBe(true);
    expect(result.details.subagents.every((subagent) =>
      (subagent.result?.length ?? 0) <= WORKFLOW_RESULT_PREVIEW_CHARS &&
      (subagent.activity?.length ?? 0) <= WORKFLOW_ACTIVITY_PREVIEW_LINES &&
      (subagent.activity?.every((line) => line.length <= WORKFLOW_ACTIVITY_PREVIEW_CHARS) ?? true))).toBe(true);
    expect(immutableSamples.every(({ update, serialized }) => JSON.stringify(update) === serialized)).toBe(true);

    expect(terminal.content).toContain("[truncated]");
    expect(terminal.content.length).toBeLessThanOrEqual(MAX_MODEL_VISIBLE_TEXT_CHARS);
    expect(typeof result.details.result).toBe("string");
    expect((result.details.result as string).length).toBeLessThanOrEqual(WORKFLOW_RESULT_PREVIEW_CHARS);

    const entries = readFileSync(
      join(workflowStateDir(tempDir), `task-${terminal.task_id}.jsonl`),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.filter((entry) => entry.type === "task_log")).toHaveLength(childCount);
    expect(entries.some((entry) => entry.type === "task_log" && entry.message.includes("LOG_TAIL_31"))).toBe(true);
    expect(entries.some((entry) => entry.type === "subagent_result" &&
      typeof entry.result === "string" && entry.result.includes("RESULT_TAIL_31"))).toBe(true);
    disposeSession(session);
  });

  it("keeps spinner frame updates for a running workflow in TUI mode", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ mode: "tui" });
    let releaseChild: (() => void) | undefined;
    registration.setResponses([
      async () => {
        await new Promise<void>((resolve) => {
          releaseChild = resolve;
        });
        return fauxAssistantMessage("tui child done");
      },
    ]);

    const updates: WorkflowToolResult[] = [];
    const script = `export const meta = { name: 'tui_progress', description: 'Render TUI spinner progress' };
return await run_agent('wait for release', { label: 'worker' });`;
    const pending = executeWorkflow(
      session,
      { name: "tui_progress", script },
      { ...makeExecutionContext({ hasUI: true, model, modelRegistry, tui: true }), mode: "tui" },
      (update) => updates.push(update),
    );

    try {
      await waitUntil(() => releaseChild);
      await waitUntil(() => updates.find((update) => (update.details.frame ?? 0) > 0));
    } finally {
      releaseChild?.();
    }

    const { terminal } = await pending;
    expect(terminal).toMatchObject({ status: "completed", content: "tui child done" });
    disposeSession(session);
  });

  it("returns terminal failures for invalid scripts and sources without launching subagents", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("must remain unused")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });

    const invalidScript = await executeWorkflow(
      session,
      {
        name: "invalid_schema",
        script: `export const meta = { name: 'invalid_schema', description: 'invalid schema' };\nreturn await run_agent('x', { schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } });`,
      },
      context,
    );
    expect(invalidScript.terminal.status).toBe("failed");
    expect(invalidScript.result.details.status).toBe("error");
    expect(invalidScript.terminal.content).toMatch(/no subagents were started.*schema preflight.*additionalProperties/is);

    const script = `export const meta = { name: 'actual_name', description: 'name mismatch' };\nreturn await run_agent('x');`;
    const mismatch = await executeWorkflow(session, { name: "requested_name", script }, context);
    expect(mismatch.terminal.status).toBe("failed");
    expect(mismatch.terminal.content).toContain(
      'Workflow name "requested_name" does not match script meta.name "actual_name"',
    );
    expect(registration.getPendingResponseCount()).toBe(1);

    disposeSession(session);
  });

  it("continues separate Worker and Reviewer sessions through a review loop", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    let firstWorkerContext: Context | undefined;
    let firstReviewerContext: Context | undefined;
    let secondWorkerContext: Context | undefined;
    let secondReviewerContext: Context | undefined;
    registration.setResponses([
      (context) => {
        firstWorkerContext = context;
        return fauxAssistantMessage("draft v1");
      },
      (context) => {
        firstReviewerContext = context;
        return fauxAssistantMessage("needs tighter rollback guidance");
      },
      (context) => {
        secondWorkerContext = context;
        return fauxAssistantMessage("draft v2");
      },
      (context) => {
        secondReviewerContext = context;
        return fauxAssistantMessage("approved");
      },
    ]);

    const script = `export const meta = { name: 'review_loop', description: 'Continue Worker and Reviewer sessions' };
let draft = await run_agent('Create the initial draft.', { label: 'worker-1', session_key: 'worker' });
let review = await run_agent('Review this draft:\\n' + draft, { label: 'reviewer-1', session_key: 'reviewer' });
draft = await run_agent('Revise using this feedback:\\n' + review, { label: 'worker-2', session_key: 'worker' });
return await run_agent('Review this revision:\\n' + draft, { label: 'reviewer-2', session_key: 'reviewer' });`;
    const { result, terminal } = await executeWorkflow(
      session,
      { name: "review_loop", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(terminal).toMatchObject({ status: "completed", content: "approved" });
    expect(result.details.subagents).toHaveLength(4);
    expect(result.details.subagents.every((subagent) => subagent.status === "done")).toBe(true);
    expect(JSON.stringify(firstWorkerContext?.messages)).toContain("Create the initial draft.");
    expect(JSON.stringify(firstReviewerContext?.messages)).toContain("draft v1");
    const workerResume = JSON.stringify(secondWorkerContext?.messages);
    expect(workerResume).toContain("Create the initial draft.");
    expect(workerResume).toContain("draft v1");
    expect(workerResume).toContain("needs tighter rollback guidance");
    const reviewerResume = JSON.stringify(secondReviewerContext?.messages);
    expect(reviewerResume).toContain("Review this draft");
    expect(reviewerResume).toContain("needs tighter rollback guidance");
    expect(reviewerResume).toContain("draft v2");

    disposeSession(session);
  });

  it("applies the configured timeout to workflow subagents", async () => {
    const { session, registration, model, modelRegistry } = await createSession({ subagentTimeoutMs: 20 });
    registration.setResponses([
      async () => {
        await delay(80);
        return fauxAssistantMessage("late workflow child output");
      },
    ]);

    const script = `export const meta = { name: 'slow-flow', description: 'slow workflow child' };\nreturn await run_agent('wait too long', { label: 'slow' });`;
    const started = Date.now();
    const { result, terminal } = await executeWorkflow(
      session,
      { name: "slow-flow", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
    );

    expect(terminal).toMatchObject({ status: "completed", name: "slow-flow", content: "null" });
    expect(result.details).toMatchObject({ status: "completed", result: null });
    expect(result.details.subagents[0]).toMatchObject({
      status: "aborted",
      error: expect.stringMatching(/timed out|timeout/i),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    const entries = readFileSync(
      join(workflowStateDir(tempDir), `task-${terminal.task_id}.jsonl`),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const subagentResult = entries.find((entry) => entry.type === "subagent_result");
    expect(subagentResult).toMatchObject({ failed: true, error: expect.stringMatching(/timed out|timeout/i) });
    expect(entries.find((entry) => entry.type === "task_log")?.message).toMatch(/timed out|timeout/i);

    disposeSession(session);
  });

  it("resolves an active call as aborted when reload shuts the session down", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession({ mode: "tui" });
    let childStarted = false;
    let rootNotificationCalls = 0;
    setContextRoutingResponses(registration, (providerContext, options) => {
      if (getToolNames(providerContext).includes("run_agent")) {
        rootNotificationCalls++;
        return fauxAssistantMessage("unexpected root continuation");
      }
      childStarted = true;
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("aborted workflow child")), { once: true });
      });
    });
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    const script = `export const meta = { name: 'reload_flow', description: 'Wait for reload' };\nreturn await run_agent('wait for reload', { label: 'worker' });`;

    const updates: WorkflowToolResult[] = [];
    const pending = executeWorkflow(session, { name: "reload_flow", script }, context, (update) => updates.push(update));
    await waitUntil(() => childStarted || undefined);
    await session.reload();
    const { result, terminal } = await pending;

    expect(terminal).toMatchObject({ status: "failed", content: "Pi session shut down" });
    expect(result.details).toMatchObject({ status: "aborted", error: "Pi session shut down" });
    expect(result.details.subagents[0]).toMatchObject({
      status: "aborted",
      error: "Pi session shut down",
      endedAt: expect.any(Number),
    });
    expect(updates.some((update) => {
      const child = update.details.subagents[0];
      return child?.status === "aborted" && child.error === "Pi session shut down";
    })).toBe(true);
    expect(sessionManager.getEntries().some((entry) =>
      entry.type === "custom_message" && entry.customType === TASK_NOTIFICATION_TYPE)).toBe(false);
    expect(taskNotifications(session)).toEqual([]);
    expect(rootNotificationCalls).toBe(0);
    disposeSession(session);
  });

  it("journals explicit logs without changing a successful JSON result", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("logged child done")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    const script = `export const meta = { name: 'logged_flow', description: 'Persist workflow logs' };\nlog('starting review');\nreturn { reply: await run_agent('finish review', { label: 'reviewer' }) };`;

    const { result, terminal } = await executeWorkflow(session, { name: "logged_flow", script }, context);

    expect(JSON.parse(terminal.content)).toEqual({ reply: "logged child done" });
    expect(result.details.logs).toEqual(["starting review"]);
    const entries = readFileSync(
      join(workflowStateDir(tempDir), `task-${terminal.task_id}.jsonl`),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toContainEqual({ type: "task_log", message: "starting review" });
    disposeSession(session);
  });

  it("runs a saved workflow by name and replays its persisted snapshot", async () => {
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    const savedPath = join(agentDir, "workflows", "saved-review.js");
    writeFileSync(
      savedPath,
      `export const meta = { name: 'saved-review', description: 'Review through a saved workflow' };\nreturn await run_agent('saved workflow task', { label: 'saved' });`,
    );
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("saved child done")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });

    const first = await executeWorkflow(session, { name: "saved-review" }, context);

    expect(first.result.details.name).toBe("saved-review");
    expect(first.terminal).toMatchObject({ status: "completed", name: "saved-review", content: "saved child done" });

    writeFileSync(
      savedPath,
      `export const meta = { name: 'saved-review', description: 'Edited saved workflow' };\nreturn await run_agent('changed workflow task', { label: 'changed' });`,
    );
    const replay = await executeWorkflow(
      session,
      { name: "saved-review", resume_from_task_id: first.terminal.task_id },
      context,
    );
    expect(replay.result.details.name).toBe("saved-review");
    expect(replay.result.details.cachedSubagentCount).toBe(1);
    expect(replay.terminal).toMatchObject({ status: "completed", name: "saved-review", content: "saved child done" });
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("rejects replay when name does not match the task journal", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("original child done")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    const script = `export const meta = { name: 'journal_name', description: 'Replay name guard' };\nreturn await run_agent('run once');`;
    const first = await executeWorkflow(session, { name: "journal_name", script }, context);

    const mismatch = await executeWorkflow(
      session,
      { name: "wrong_name", resume_from_task_id: first.terminal.task_id },
      context,
    );

    expect(mismatch.terminal.status).toBe("failed");
    expect(mismatch.terminal.content).toContain(
      `task ${first.terminal.task_id} belongs to workflow "journal_name", not "wrong_name"`,
    );
    expect(registration.getPendingResponseCount()).toBe(0);
    disposeSession(session);
  });

  it("reports an unknown saved workflow with the available roster", async () => {
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "known.js"),
      `export const meta = { name: 'known-flow', description: 'Known flow' };\nreturn await run_agent('known');`,
    );
    const { session, model, modelRegistry } = await createSession();

    const { terminal } = await executeWorkflow(
      session,
      { name: "missing-flow" },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain('Unknown saved workflow "missing-flow"');
    expect(terminal.content).toContain("known-flow");

    disposeSession(session);
  });

  it("rejects resume_from_task_id with an inline script", async () => {
    const { session, model, modelRegistry } = await createSession();
    const script = `export const meta = { name: 'resume_inline', description: 'resume misuse' };\nreturn await run_agent('x');`;

    const { terminal } = await executeWorkflow(
      session,
      { name: "resume_inline", script, resume_from_task_id: "task_previous" },
      makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
    );

    expect(terminal.status).toBe("failed");
    expect(terminal.content).toContain("resume_from_task_id may only be used with name and optional script_path");

    disposeSession(session);
  });

  it("rejects replay while the original workflow task is still running", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setContextRoutingResponses(registration, async () => {
      await gate;
      return fauxAssistantMessage("original done");
    });
    const script = `export const meta = { name: 'active_replay', description: 'Active replay guard' };\nreturn await run_agent('wait', { label: 'worker' });`;

    const firstPending = executeWorkflow(session, { name: "active_replay", script }, context);
    const firstTaskId = await waitUntil(() => {
      const stateDir = workflowStateDir(tempDir);
      if (!existsSync(stateDir)) return undefined;
      const journalName = readdirSync(stateDir).find((name) => /^task-task_[a-f0-9]+\.jsonl$/.test(name));
      return journalName?.slice("task-".length, -".jsonl".length);
    });

    const replay = await executeWorkflow(
      session,
      { name: "active_replay", resume_from_task_id: firstTaskId },
      context,
    );
    release();
    const first = await firstPending;

    expect(replay.terminal).toMatchObject({ status: "failed" });
    expect(replay.terminal.content).toContain(`task ${firstTaskId} is still running`);
    expect(replay.terminal.task_id).not.toBe(firstTaskId);
    expect(first.terminal).toMatchObject({ task_id: firstTaskId, status: "completed", content: "original done" });
    disposeSession(session);
  });

  it("replays an orphaned running journal when no live task owns it", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    registration.setResponses([fauxAssistantMessage("journaled result")]);
    const script = `export const meta = { name: 'orphan_replay', description: 'Replay an orphaned journal' };\nreturn await run_agent('run once', { label: 'worker' });`;

    const first = await executeWorkflow(session, { name: "orphan_replay", script }, context);
    const journalPath = join(workflowStateDir(tempDir), `task-${first.terminal.task_id}.jsonl`);
    const runningJournal = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((line) => !line.includes('"type":"task_complete"'))
      .join("\n");
    writeFileSync(journalPath, runningJournal);

    const replay = await executeWorkflow(
      session,
      { name: "orphan_replay", resume_from_task_id: first.terminal.task_id },
      context,
    );

    expect(replay.terminal).toMatchObject({ status: "completed", content: "journaled result" });
    expect(replay.result.details.cachedSubagentCount).toBe(1);
    expect(registration.getPendingResponseCount()).toBe(0);
    disposeSession(session);
  });

  it("rejects implicit replay when the persisted script snapshot changed", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    registration.setResponses([fauxAssistantMessage("original result")]);
    const script = `export const meta = { name: 'immutable_replay', description: 'Immutable replay snapshot' };\nreturn await run_agent('original prompt', { label: 'worker' });`;

    const first = await executeWorkflow(session, { name: "immutable_replay", script }, context);
    const stateDir = workflowStateDir(tempDir);
    const scriptPath = join(stateDir, readdirSync(stateDir).find((name) => name.endsWith(".js")) ?? "");
    writeFileSync(scriptPath, readFileSync(scriptPath, "utf8").replace("original prompt", "mutated prompt"));

    const replay = await executeWorkflow(
      session,
      { name: "immutable_replay", resume_from_task_id: first.terminal.task_id },
      context,
    );

    expect(replay.terminal.status).toBe("failed");
    expect(replay.terminal.content).toContain(`persisted script for task ${first.terminal.task_id} has changed`);
    expect(registration.getPendingResponseCount()).toBe(0);
    disposeSession(session);
  });

  it("persists inline scripts and replays an edited script_path by task ID", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    registration.setResponses([fauxAssistantMessage("first v1"), fauxAssistantMessage("second v1")]);

    const script = `export const meta = { name: 'resume_flow', description: 'Resume test flow' };
const a = await run_agent('first prompt', { label: 'first' });
const b = await run_agent('second prompt', { label: 'second' });
return [a, b];`;
    const first = await executeWorkflow(session, { name: "resume_flow", script }, context);
    expect(JSON.parse(first.terminal.content)).toEqual(["first v1", "second v1"]);

    const stateDir = workflowStateDir(tempDir);
    const scriptPath = join(stateDir, readdirSync(stateDir).find((name) => name.endsWith(".js")) ?? "");
    expect(existsSync(scriptPath)).toBe(true);
    expect(existsSync(join(stateDir, `task-${first.terminal.task_id}.jsonl`))).toBe(true);

    const unchanged = await executeWorkflow(
      session,
      { name: "resume_flow", resume_from_task_id: first.terminal.task_id },
      context,
    );
    expect(unchanged.terminal.status).toBe("completed");
    expect(JSON.parse(unchanged.terminal.content)).toEqual(["first v1", "second v1"]);
    expect(unchanged.result.details.cachedSubagentCount).toBe(2);

    writeFileSync(scriptPath, readFileSync(scriptPath, "utf8").replace("second prompt", "second prompt changed"));
    registration.setResponses([fauxAssistantMessage("second v2")]);

    const second = await executeWorkflow(
      session,
      { name: "resume_flow", script_path: scriptPath, resume_from_task_id: first.terminal.task_id },
      context,
    );

    expect(second.terminal.status).toBe("completed");
    expect(JSON.parse(second.terminal.content)).toEqual(["first v1", "second v2"]);
    expect(second.result.details.cachedSubagentCount).toBe(1);
    expect(second.terminal.task_id).not.toBe(first.terminal.task_id);
    expect(registration.getPendingResponseCount()).toBe(0);

    writeFileSync(scriptPath, readFileSync(scriptPath, "utf8").replace("resume_flow", "different_flow"));
    const pathMismatch = await executeWorkflow(
      session,
      { name: "resume_flow", script_path: scriptPath, resume_from_task_id: first.terminal.task_id },
      context,
    );
    expect(pathMismatch.terminal.status).toBe("failed");
    expect(pathMismatch.terminal.content).toContain(
      'Workflow name "resume_flow" does not match script meta.name "different_flow"',
    );

    disposeSession(session);
  });

  it("captures schema-validated structured output from a workflow subagent", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("structured_output", { answer: "42", confidence: 0.9 })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ]);

    const script = `export const meta = { name: 'solve', description: 'solve a task' };
return await run_agent('compute the answer', {
  label: 'solver',
  schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' }, confidence: { type: 'number' } }, required: ['answer', 'confidence'] },
});`;
    const { result, terminal } = await executeWorkflow(
      session,
      { name: "solve", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(terminal.status).toBe("completed");
    expect(JSON.parse(terminal.content)).toEqual({ answer: "42", confidence: 0.9 });
    expect(result.details.result).toEqual({ answer: "42", confidence: 0.9 });

    disposeSession(session);
  });

  it("hides delegation tools from children and emits no custom notifications", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    let childContext: Context | undefined;
    registration.setResponses([
      (context) => {
        childContext = context;
        return fauxAssistantMessage("first done");
      },
      fauxAssistantMessage("second done"),
    ]);

    const script = `export const meta = { name: 'two', description: 'two-agent flow' };
const first = await run_agent('first', { label: 'one' });
const second = await run_agent('second', { label: 'two' });
return [first, second];`;
    const { result, terminal } = await executeWorkflow(
      session,
      { name: "two", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(JSON.parse(terminal.content)).toEqual(["first done", "second done"]);
    expect(result.details.subagents).toHaveLength(2);
    expect(taskNotifications(session)).toEqual([]);
    expect(getToolNames(childContext)).not.toContain("run_agent");
    expect(getToolNames(childContext)).not.toContain("run_workflow");

    disposeSession(session);
  });
});
