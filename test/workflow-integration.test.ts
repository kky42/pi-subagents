import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

const TASK_NOTIFICATION_TYPE = "pi-flow-task-notification";

type AcceptedWorkflow = {
  task_id: string;
  task_type: "workflow";
  status: "accepted";
  name: string;
};

type TerminalWorkflow = {
  task_id: string;
  task_type: "workflow";
  status: "completed" | "failed";
  name: string;
  content: string;
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

function taskNotifications(session: { messages: readonly any[] }): TerminalWorkflow[] {
  return session.messages
    .filter((message) => message.customType === TASK_NOTIFICATION_TYPE)
    .map((message) => JSON.parse(message.content) as TerminalWorkflow);
}

async function executeWorkflow(
  session: { messages: readonly any[]; getToolDefinition: (name: string) => unknown },
  params: Record<string, unknown>,
  context: unknown,
): Promise<{ accepted: AcceptedWorkflow; notification: TerminalWorkflow }> {
  const tool = session.getToolDefinition("workflow") as any;
  const result = await tool.execute("workflow-test", params, undefined, undefined, context);
  const accepted = result.details as AcceptedWorkflow;

  expect(result.content).toEqual([{ type: "text", text: JSON.stringify(accepted) }]);
  expect(Object.keys(accepted).sort()).toEqual(["name", "status", "task_id", "task_type"]);
  expect(accepted).toMatchObject({ task_type: "workflow", status: "accepted", name: params.name });
  expect(accepted.task_id).toMatch(/^task_[a-f0-9]+$/);

  const notification = await waitUntil(() =>
    taskNotifications(session).find((message) => message.task_id === accepted.task_id),
  );
  expect(Object.keys(notification).sort()).toEqual(["content", "name", "status", "task_id", "task_type"]);
  expect(notification).toMatchObject({ task_id: accepted.task_id, task_type: "workflow" });
  expect(notification.name).toBe(accepted.name);
  return { accepted, notification };
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

  it("accepts immediately, runs a real subagent, and emits one outer notification", async () => {
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

    const tool = session.getToolDefinition("workflow") as any;
    const script = `export const meta = { name: 'inspect', description: 'inspect a module' };\nreturn await agent('analyze the module', { label: 'analyze' });`;
    const pending = tool.execute(
      "wf-text",
      { name: "inspect", script },
      undefined,
      undefined,
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );
    const result = await pending;
    expect(result.details).toMatchObject({ task_type: "workflow", status: "accepted", name: "inspect" });
    expect(taskNotifications(session)).toEqual([]);

    await waitUntil(() => releaseChild);
    releaseChild?.();
    const notification = await waitUntil(() => taskNotifications(session)[0]);
    expect(notification).toEqual({
      task_id: result.details.task_id,
      task_type: "workflow",
      status: "completed",
      name: "inspect",
      content: "child analysis done",
    });
    expect(taskNotifications(session)).toHaveLength(1);
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("shows completed Workflow counts and child usage in the widget", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("workflow usage done")]);
    const widgets: Array<{ key: string; lines: string[] | undefined }> = [];
    const script = `export const meta = { name: 'footer_flow', description: 'Footer flow' };\nreturn await agent('report usage', { label: 'usage' });`;

    await executeWorkflow(
      session,
      { name: "footer_flow", script },
      makeExecutionContext({
        hasUI: true,
        model,
        modelRegistry,
        onWidget: (key, lines) => widgets.push({ key, lines }),
      }),
    );

    const flowWidgets = widgets.filter((widget) => widget.key === "pi-flow");
    expect(flowWidgets.some((widget) => widget.lines?.some((line) => line.includes("Workflow(footer_flow)")))).toBe(true);
    expect(flowWidgets.at(-1)?.lines).toHaveLength(1);
    const line = flowWidgets.at(-1)?.lines?.[0] ?? "";
    expect(line).toContain("pi-flow idle · 0 agents and 1 workflow done");
    expect(line).toMatch(/↑\S+ ↓\S+ (?:R\S+ |W\S+ )*CH\d+\.\d%/);
    disposeSession(session);
  });

  it("reports invalid scripts and sources through failed notifications without launching subagents", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("must remain unused")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });

    const invalidScript = await executeWorkflow(
      session,
      {
        name: "invalid_schema",
        script: `export const meta = { name: 'invalid_schema', description: 'invalid schema' };\nreturn await agent('x', { schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } } });`,
      },
      context,
    );
    expect(invalidScript.notification.status).toBe("failed");
    expect(invalidScript.notification.content).toMatch(/no subagents were started.*schema preflight.*additionalProperties/is);

    const script = `export const meta = { name: 'actual_name', description: 'name mismatch' };\nreturn await agent('x');`;
    const mismatch = await executeWorkflow(session, { name: "requested_name", script }, context);
    expect(mismatch.notification.status).toBe("failed");
    expect(mismatch.notification.content).toContain(
      'Workflow name "requested_name" does not match script meta.name "actual_name"',
    );

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
let draft = await agent('Create the initial draft.', { label: 'worker-1', session_key: 'worker' });
let review = await agent('Review this draft:\\n' + draft, { label: 'reviewer-1', session_key: 'reviewer' });
draft = await agent('Revise using this feedback:\\n' + review, { label: 'worker-2', session_key: 'worker' });
return await agent('Review this revision:\\n' + draft, { label: 'reviewer-2', session_key: 'reviewer' });`;
    const { notification } = await executeWorkflow(
      session,
      { name: "review_loop", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(notification).toMatchObject({ status: "completed", content: "approved" });
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

    const script = `export const meta = { name: 'slow-flow', description: 'slow workflow child' };\nreturn await agent('wait too long', { label: 'slow' });`;
    const started = Date.now();
    const { accepted, notification } = await executeWorkflow(
      session,
      { name: "slow-flow", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
    );

    expect(notification).toMatchObject({ status: "completed", name: "slow-flow", content: "null" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
    const entries = readFileSync(
      join(workflowStateDir(tempDir), `task-${accepted.task_id}.jsonl`),
      "utf8",
    ).trim().split("\n").map((line) => JSON.parse(line));
    const agentResult = entries.find((entry) => entry.type === "agent_result");
    expect(agentResult).toMatchObject({ failed: true, error: expect.stringMatching(/timed out|timeout/i) });
    expect(entries.find((entry) => entry.type === "task_log")?.message).toMatch(/timed out|timeout/i);

    disposeSession(session);
  });

  it("persists a failed Workflow notification when reload aborts it", async () => {
    const { session, registration, model, modelRegistry, sessionManager } = await createSession({ mode: "tui" });
    let childStarted = false;
    let rootNotificationCalls = 0;
    setContextRoutingResponses(registration, (providerContext, options) => {
      if (getToolNames(providerContext).includes("Agent")) {
        rootNotificationCalls++;
        return fauxAssistantMessage("notification observed");
      }
      childStarted = true;
      return new Promise((resolve) => {
        options.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("aborted workflow child")), { once: true });
      });
    });
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry });
    const tool = session.getToolDefinition("workflow") as any;
    const script = `export const meta = { name: 'reload_flow', description: 'Wait for reload' };\nreturn await agent('wait for reload', { label: 'worker' });`;

    const result = await tool.execute("reload-workflow", { name: "reload_flow", script }, undefined, undefined, context);
    const accepted = result.details as AcceptedWorkflow;
    await waitUntil(() => childStarted || undefined);
    await session.reload();

    const terminalEntry = sessionManager.getEntries().find((entry) =>
      entry.type === "custom_message" && entry.customType === TASK_NOTIFICATION_TYPE);
    const terminal = terminalEntry?.type === "custom_message" ? terminalEntry.details : undefined;
    expect(terminal).toMatchObject({ status: "failed", task_id: accepted.task_id, content: "Pi session shut down" });
    expect(taskNotifications(session).find((item) => item.task_id === accepted.task_id)).toBeUndefined();
    expect(rootNotificationCalls).toBe(0);
    disposeSession(session);
  });

  it("journals explicit logs without changing a successful JSON result", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("logged child done")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    const script = `export const meta = { name: 'logged_flow', description: 'Persist workflow logs' };\nlog('starting review');\nreturn { reply: await agent('finish review', { label: 'reviewer' }) };`;

    const { accepted, notification } = await executeWorkflow(session, { name: "logged_flow", script }, context);

    expect(JSON.parse(notification.content)).toEqual({ reply: "logged child done" });
    const entries = readFileSync(
      join(workflowStateDir(tempDir), `task-${accepted.task_id}.jsonl`),
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
      `export const meta = { name: 'saved-review', description: 'Review through a saved workflow' };\nreturn await agent('saved workflow task', { label: 'saved' });`,
    );
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("saved child done")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });

    const { accepted, notification } = await executeWorkflow(session, { name: "saved-review" }, context);

    expect(accepted.name).toBe("saved-review");
    expect(notification).toMatchObject({ status: "completed", name: "saved-review", content: "saved child done" });

    writeFileSync(
      savedPath,
      `export const meta = { name: 'saved-review', description: 'Edited saved workflow' };\nreturn await agent('changed workflow task', { label: 'changed' });`,
    );
    const replay = await executeWorkflow(
      session,
      { name: "saved-review", resume_from_task_id: accepted.task_id },
      context,
    );
    expect(replay.accepted.name).toBe("saved-review");
    expect(replay.notification).toMatchObject({ status: "completed", name: "saved-review", content: "saved child done" });
    expect(registration.getPendingResponseCount()).toBe(0);

    disposeSession(session);
  });

  it("rejects replay when name does not match the task journal", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    registration.setResponses([fauxAssistantMessage("original child done")]);
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    const script = `export const meta = { name: 'journal_name', description: 'Replay name guard' };\nreturn await agent('run once');`;
    const first = await executeWorkflow(session, { name: "journal_name", script }, context);

    const mismatch = await executeWorkflow(
      session,
      { name: "wrong_name", resume_from_task_id: first.accepted.task_id },
      context,
    );

    expect(mismatch.notification.status).toBe("failed");
    expect(mismatch.notification.content).toContain(
      `task ${first.accepted.task_id} belongs to workflow "journal_name", not "wrong_name"`,
    );
    expect(registration.getPendingResponseCount()).toBe(0);
    disposeSession(session);
  });

  it("reports an unknown saved workflow with the available roster", async () => {
    mkdirSync(join(agentDir, "workflows"), { recursive: true });
    writeFileSync(
      join(agentDir, "workflows", "known.js"),
      `export const meta = { name: 'known-flow', description: 'Known flow' };\nreturn await agent('known');`,
    );
    const { session, model, modelRegistry } = await createSession();

    const { notification } = await executeWorkflow(
      session,
      { name: "missing-flow" },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(notification.status).toBe("failed");
    expect(notification.content).toContain('Unknown saved workflow "missing-flow"');
    expect(notification.content).toContain("known-flow");

    disposeSession(session);
  });

  it("rejects resume_from_task_id with an inline script", async () => {
    const { session, model, modelRegistry } = await createSession();
    const script = `export const meta = { name: 'resume_inline', description: 'resume misuse' };\nreturn await agent('x');`;

    const { notification } = await executeWorkflow(
      session,
      { name: "resume_inline", script, resume_from_task_id: "task_previous" },
      makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true }),
    );

    expect(notification.status).toBe("failed");
    expect(notification.content).toContain("resume_from_task_id may only be used with name and optional script_path");

    disposeSession(session);
  });

  it("rejects replay while the original workflow task is still running", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setContextRoutingResponses(registration, async (providerContext) => {
      if (getToolNames(providerContext).includes("Agent")) {
        return fauxAssistantMessage("notification observed");
      }
      await gate;
      return fauxAssistantMessage("original done");
    });
    const tool = session.getToolDefinition("workflow") as any;
    const script = `export const meta = { name: 'active_replay', description: 'Active replay guard' };\nreturn await agent('wait', { label: 'worker' });`;

    const firstResult = await tool.execute(
      "workflow-active",
      { name: "active_replay", script },
      undefined,
      undefined,
      context,
    );
    const first = firstResult.details as AcceptedWorkflow;
    await waitUntil(() => existsSync(join(workflowStateDir(tempDir), `task-${first.task_id}.jsonl`)) || undefined);

    const replayResult = await tool.execute(
      "workflow-active-replay",
      { name: "active_replay", resume_from_task_id: first.task_id },
      undefined,
      undefined,
      context,
    );
    const replay = replayResult.details as AcceptedWorkflow;
    const replayTerminal = await waitUntil(() => taskNotifications(session).find((item) => item.task_id === replay.task_id));
    expect(replayTerminal).toMatchObject({ status: "failed" });
    expect(replayTerminal.content).toContain(`task ${first.task_id} is still running`);

    release();
    const firstTerminal = await waitUntil(() => taskNotifications(session).find((item) => item.task_id === first.task_id));
    expect(firstTerminal.status).toBe("completed");
    disposeSession(session);
  });

  it("replays an orphaned running journal when no live task owns it", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    registration.setResponses([fauxAssistantMessage("journaled result")]);
    const script = `export const meta = { name: 'orphan_replay', description: 'Replay an orphaned journal' };\nreturn await agent('run once', { label: 'worker' });`;

    const first = await executeWorkflow(session, { name: "orphan_replay", script }, context);
    const journalPath = join(workflowStateDir(tempDir), `task-${first.accepted.task_id}.jsonl`);
    const runningJournal = readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((line) => !line.includes('"type":"task_complete"'))
      .join("\n");
    writeFileSync(journalPath, runningJournal);

    const replay = await executeWorkflow(
      session,
      { name: "orphan_replay", resume_from_task_id: first.accepted.task_id },
      context,
    );

    expect(replay.notification).toMatchObject({ status: "completed", content: "journaled result" });
    expect(registration.getPendingResponseCount()).toBe(0);
    disposeSession(session);
  });

  it("rejects implicit replay when the persisted script snapshot changed", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    registration.setResponses([fauxAssistantMessage("original result")]);
    const script = `export const meta = { name: 'immutable_replay', description: 'Immutable replay snapshot' };\nreturn await agent('original prompt', { label: 'worker' });`;

    const first = await executeWorkflow(session, { name: "immutable_replay", script }, context);
    const stateDir = workflowStateDir(tempDir);
    const scriptPath = join(stateDir, readdirSync(stateDir).find((name) => name.endsWith(".js")) ?? "");
    writeFileSync(scriptPath, readFileSync(scriptPath, "utf8").replace("original prompt", "mutated prompt"));

    const replay = await executeWorkflow(
      session,
      { name: "immutable_replay", resume_from_task_id: first.accepted.task_id },
      context,
    );

    expect(replay.notification.status).toBe("failed");
    expect(replay.notification.content).toContain(`persisted script for task ${first.accepted.task_id} has changed`);
    expect(registration.getPendingResponseCount()).toBe(0);
    disposeSession(session);
  });

  it("persists inline scripts and replays an edited script_path by task ID", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const context = makeExecutionContext({ hasUI: false, model, modelRegistry, persistedSession: true });
    registration.setResponses([fauxAssistantMessage("first v1"), fauxAssistantMessage("second v1")]);

    const script = `export const meta = { name: 'resume_flow', description: 'Resume test flow' };
const a = await agent('first prompt', { label: 'first' });
const b = await agent('second prompt', { label: 'second' });
return [a, b];`;
    const first = await executeWorkflow(session, { name: "resume_flow", script }, context);
    expect(JSON.parse(first.notification.content)).toEqual(["first v1", "second v1"]);

    const stateDir = workflowStateDir(tempDir);
    const scriptPath = join(stateDir, readdirSync(stateDir).find((name) => name.endsWith(".js")) ?? "");
    expect(existsSync(scriptPath)).toBe(true);
    expect(existsSync(join(stateDir, `task-${first.accepted.task_id}.jsonl`))).toBe(true);

    const unchanged = await executeWorkflow(
      session,
      { name: "resume_flow", resume_from_task_id: first.accepted.task_id },
      context,
    );
    expect(unchanged.notification.status).toBe("completed");
    expect(JSON.parse(unchanged.notification.content)).toEqual(["first v1", "second v1"]);

    writeFileSync(scriptPath, readFileSync(scriptPath, "utf8").replace("second prompt", "second prompt changed"));
    registration.setResponses([fauxAssistantMessage("second v2")]);

    const second = await executeWorkflow(
      session,
      { name: "resume_flow", script_path: scriptPath, resume_from_task_id: first.accepted.task_id },
      context,
    );

    expect(second.notification.status).toBe("completed");
    expect(JSON.parse(second.notification.content)).toEqual(["first v1", "second v2"]);
    expect(second.accepted.task_id).not.toBe(first.accepted.task_id);
    expect(registration.getPendingResponseCount()).toBe(0);

    writeFileSync(scriptPath, readFileSync(scriptPath, "utf8").replace("resume_flow", "different_flow"));
    const pathMismatch = await executeWorkflow(
      session,
      { name: "resume_flow", script_path: scriptPath, resume_from_task_id: first.accepted.task_id },
      context,
    );
    expect(pathMismatch.notification.status).toBe("failed");
    expect(pathMismatch.notification.content).toContain(
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
return await agent('compute the answer', {
  label: 'solver',
  schema: { type: 'object', additionalProperties: false, properties: { answer: { type: 'string' }, confidence: { type: 'number' } }, required: ['answer', 'confidence'] },
});`;
    const { notification } = await executeWorkflow(
      session,
      { name: "solve", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(notification.status).toBe("completed");
    expect(JSON.parse(notification.content)).toEqual({ answer: "42", confidence: 0.9 });

    disposeSession(session);
  });

  it("hides delegation tools from children and emits no per-agent foreground notifications", async () => {
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
const first = await agent('first', { label: 'one' });
const second = await agent('second', { label: 'two' });
return [first, second];`;
    const { accepted, notification } = await executeWorkflow(
      session,
      { name: "two", script },
      makeExecutionContext({ hasUI: false, model, modelRegistry }),
    );

    expect(JSON.parse(notification.content)).toEqual(["first done", "second done"]);
    expect(taskNotifications(session)).toEqual([notification]);
    expect(taskNotifications(session).every((message) => message.task_id === accepted.task_id)).toBe(true);
    expect(getToolNames(childContext)).not.toContain("Agent");
    expect(getToolNames(childContext)).not.toContain("workflow");

    disposeSession(session);
  });
});
