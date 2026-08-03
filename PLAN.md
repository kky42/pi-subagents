# Background Agent and Workflow Plan

Status: implemented and validated.

## Goal

Make every top-level `Agent` and `workflow` tool call a background task implemented entirely inside the pi-flow extension.

A successful launch returns immediately. The foreground agent later receives one terminal notification carrying the same `task_id`.

Keep the model-facing contract small and consistent. Keep usage, telemetry, backend session IDs, progress trees, journal paths, and other runtime details out of tool results and notifications.

## Public contract

### Status model

Expose only three statuses to the foreground agent:

- `accepted`: the task was created
- `completed`: the task finished successfully
- `failed`: the task did not complete successfully

The task manager may track `queued` and `running` internally, but must not expose them to the foreground agent.

### Agent messages

An accepted Agent task returns:

```json
{
  "task_id": "task_...",
  "task_type": "agent",
  "status": "accepted",
  "session_key": "session_...",
  "name": "Inspect authentication"
}
```

Its terminal notification is either:

```json
{
  "task_id": "task_...",
  "task_type": "agent",
  "status": "completed",
  "session_key": "session_...",
  "name": "Inspect authentication",
  "content": "Plain-text subagent result"
}
```

or:

```json
{
  "task_id": "task_...",
  "task_type": "agent",
  "status": "failed",
  "session_key": "session_...",
  "name": "Inspect authentication",
  "content": "Human-readable failure reason"
}
```

`name` is the Agent call's `description`.

### Workflow messages

An accepted Workflow task returns:

```json
{
  "task_id": "task_...",
  "task_type": "workflow",
  "status": "accepted",
  "name": "implement_and_review"
}
```

Its terminal notification has the same shape with `status: "completed"` or `status: "failed"` and a plain-text `content` field.

Workflow messages do not contain `session_key`. The Workflow tool itself has no `session_key` parameter.

If a Workflow returns a string, use it directly as `content`. If it returns another JSON-serializable value, serialize it to text at the notification boundary.

### Tool result size

The accepted envelope is the complete model-facing tool result. Do not include:

- usage or cost
- telemetry
- backend or model metadata
- backend-native session IDs
- progress nodes or active counts
- script paths or journal paths
- internal Agent results from a Workflow

These values may remain available to internal accounting, logs, renderers, and persisted journals.

## Session key behavior

### Shared subagent rule

Both the top-level `Agent` tool and Workflow-internal `agent()` calls accept an optional `session_key`.

- If a non-empty key is supplied, use that key.
- If that key already has a binding in the current scope, resume the bound child conversation.
- If that key has no binding, create a new child conversation under that key.
- Calls using the same key are serialized.
- A key already bound to a different profile or backend fails clearly.

### Top-level Agent

When the foreground agent omits `session_key`, generate one before accepting the task and return it in both the accepted result and terminal notification.

Every top-level Agent session must be persisted from its first call so the foreground agent can decide to resume it later. This includes Pi, Codex, and Claude backends.

Use neutral parameter guidance:

> Optional subagent conversation key. Reuse a session_key returned by an earlier Agent call to continue that child conversation. Omit to start a new conversation; the effective session_key is returned.

Do not reject a caller-selected key merely because PiFlow did not generate it. A supplied new key establishes a new binding and is returned unchanged after normal whitespace validation.

### Workflow-internal agent()

Keep the current workflow-local key behavior. Workflow authors can assign stable keys such as `worker` and `reviewer`, then reuse those keys for iterative conversations.

Use guidance such as:

> Optional workflow-local conversation key. Calls using the same key continue the same child conversation and are serialized.

Workflow-internal `agent()` continues to return its actual text or structured value to the script. Do not wrap that value in a task envelope. Explicit keys are already known to the script and remain recorded in workflow progress and journals.

Top-level Agent keys and Workflow-local keys remain in separate scopes. Equal strings in different scopes must not accidentally share a backend session.

## Workflow behavior

Only the outer Workflow tool call becomes a foreground-visible background task. Workflow execution still awaits its internal dependencies normally.

Existing orchestration remains supported:

- `agent()`
- `parallel()`
- `pipeline()`
- loops and conditionals
- structured output
- repeated Worker and Reviewer turns using stable workflow-local session keys

A Workflow sends one terminal notification for the outer task. Do not send foreground notifications for every internal agent call. Internal progress remains in the Workflow runtime and journal.

Remove the separate Workflow run ID concept. The Workflow `task_id` is also its journal and replay identity. Rename `resumeFromRunId` to `resumeFromTaskId` and do not expose a duplicate `run_id` field.

## Minimal extension runtime

### Task manager

Add one small extension-owned task manager shared by Agent and Workflow tools. It should own only what background execution requires:

- unique task ID generation
- active task promises
- task type and name
- Agent session key when applicable
- internal queued/running state
- task-scoped `AbortController`
- terminal notification delivery
- waiting until no accepted tasks remain

Do not add a task status tool, polling API, steering API, scheduler, database, or general job framework.

Use one opaque task ID namespace for both task types, such as `task_<uuid>`. `task_type` provides the distinction.

### Launch sequence

For each top-level tool call:

1. Let Pi reject structurally invalid tool arguments before execution.
2. Allocate the task ID and, for Agent, the effective session key.
3. Create and register the background promise before returning.
4. Return the minimal `accepted` envelope.
5. Perform profile or Workflow source validation inside the task.
6. Acquire the existing shared concurrency limiter when a subagent is ready to run.
7. Run the existing Agent or Workflow implementation.
8. Convert the result or failure into one terminal envelope.
9. Queue the terminal notification before removing the task from the active set.

Semantic validation failures use the same accepted-then-failed lifecycle as execution failures, which keeps one uniform foreground contract.

A background task must retain its limiter slot for its actual execution lifetime, not merely for the tool call lifetime.

### Notification delivery

Use a custom Pi message, not a user message. Retain each terminal envelope until Pi emits `message_end` for its custom message. Queue it as a follow-up immediately so print and JSON modes drain it before shutdown. If Pi clears the queue before delivery, `agent_settled` retries any retained envelopes.

```ts
pi.sendMessage(
  {
    customType: "pi-flow-task-notification",
    content: JSON.stringify(envelope),
    display: true,
    details: envelope,
  },
  {
    deliverAs: "followUp",
    triggerTurn: true,
  },
);
```

The serialized message content must include the full minimal envelope so the model can see and correlate `task_id`. `details` supports rendering but must not contain extra model-facing runtime data.

Each accepted task produces exactly one terminal notification. Notification delivery failures must not become unhandled promise rejections.

### Interactive and print modes

In TUI and RPC modes, do not wait at `agent_end`. The root agent may become idle, accept more user work, and receive terminal notifications later.

In print and JSON modes, register an async `agent_end` handler that waits for the task manager to become idle. Task completion queues terminal notifications before the handler returns. Pi then processes those follow-up messages before settling.

If a notification-driven turn launches more tasks, its next `agent_end` waits again. This keeps `pi -p` alive until all pi-flow background work and resulting foreground turns are complete without modifying Pi core.

### Lifecycle

Background tasks are scoped to the current Pi session.

- Do not bind their lifetime to the foreground tool call signal after acceptance.
- Abort active tasks when their owning session is shut down or replaced.
- Abort active tasks before session-tree navigation and persist their failed notifications on the originating branch.
- Persist failed notifications without triggering a model turn during session shutdown.
- Prevent a task from notifying a different session or tree branch after a switch.
- Clear task and session-key state only after owned tasks are stopped.

Keep the existing global subagent timeout as the execution guardrail.

## Implementation steps

1. Add minimal task envelope types and an extension-owned task manager under `src/core/`.
2. Change `Agent` execution to validate, allocate identifiers, schedule existing spawn logic, and return `accepted` immediately.
3. Generate and persist an effective session key for every top-level Agent call while preserving supplied keys.
4. Change the outer Workflow tool to schedule existing `runWorkflow` logic and return `accepted` immediately.
5. Keep Workflow-internal `agent()` result and session-key behavior intact.
6. Send compact custom terminal notifications through the shared task manager.
7. Add print/JSON draining and session cleanup handlers in the extension registration layer.
8. Replace Workflow run ID naming and replay parameters with task ID naming.
9. Simplify Agent and Workflow tool descriptions, prompt snippets, result renderers, and coordinator guidance for the always-background contract.
10. Remove foreground-only progress/result fields from model-facing tool results while preserving internal usage accounting.
11. Update public documentation and tests. Do not edit generated changelogs.

## Tests

Add deterministic coverage for:

- Agent returns before its child finishes
- Workflow returns before its workflow finishes
- accepted and terminal envelopes contain only the intended fields
- task IDs match between accepted results and terminal notifications
- successful and failed tasks each emit exactly one terminal notification
- Agent calls without a key receive a generated key
- caller-supplied Agent keys are preserved
- reusing a returned key resumes the same child conversation
- concurrent calls with one key serialize correctly
- profile/backend mismatches fail clearly
- Workflow messages never contain a top-level session key
- Workflow Worker/Reviewer loops resume both internal conversations correctly
- Workflow emits only one outer terminal notification
- task ID replaces run ID in journal replay
- TUI/RPC does not block at `agent_end`
- print/JSON waits for tasks and processes terminal notifications before returning
- session replacement or shutdown cannot leak notifications into another session
- usage and telemetry remain available internally but are absent from model-facing envelopes

Run `npm run check`, then manually exercise one TUI launch and one `pi -p` launch with a real Agent and Workflow before considering the change complete.

## Non-goals

Do not add:

- foreground/background mode flags
- status polling tools
- steering or task messaging
- explicit cancellation tools
- rich background dashboards
- notification history APIs
- a persistent task database
- Pi core changes
- background semantics for the plain Node runtime or headless executor

The plain Node runtime and headless executor may keep their current blocking programmatic return behavior. This plan changes the interactive Pi extension tool surface only.

## Acceptance criteria

The implementation is complete when:

1. Every valid top-level Agent and Workflow launch immediately returns one compact `accepted` envelope.
2. Every accepted task later emits exactly one compact `completed` or `failed` envelope with the same `task_id`.
3. Direct Agent continuation works with both generated and caller-supplied session keys.
4. Workflow-local multi-turn Agent orchestration continues to work unchanged.
5. Interactive foreground work is not blocked by background tasks.
6. `pi -p` does not exit while pi-flow tasks or their terminal notifications remain unfinished.
7. No Pi core modification or unnecessary task-control subsystem is introduced.
