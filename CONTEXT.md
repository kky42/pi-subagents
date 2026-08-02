# pi-flow

This context describes the domain language for `pi-flow`: a lightweight Pi extension for background subagent tasks, multi-backend agent profiles, and trusted dynamic workflows.

## Language

**Flow**:
The root-agent-controlled coordination of one or more subagents. A flow may be one top-level `Agent` task or a `workflow` script that launches many internal `agent()` calls and synthesizes one result.
_Avoid_: Background daemon, hidden scheduler, autonomous swarm

**Task**:
One top-level `Agent` or `workflow` execution. A valid launch immediately returns a compact accepted envelope. Completion or failure arrives later as one custom notification with the same `task_id`.
_Avoid_: Pollable job, scheduled process

**Subagent**:
A delegated agent that handles a scoped task in a child conversation. Parent messages, tool results, and reasoning are not copied into a fresh child, so the caller must send a self-contained prompt.
_Avoid_: Implicit inherited context, hidden forked context

**Session Key**:
The logical handle for one resumable subagent conversation. A direct Agent call without a key receives a generated key. Reusing the returned key continues that child. A caller may also supply a stable key before the first turn. Workflow scripts commonly use workflow-local keys such as `worker` and `reviewer` for iterative loops.
_Avoid_: Task ID, backend-native thread ID

**Backend Profile**:
A Markdown profile selected by `subagent_type`. The profile chooses the backend (`pi`, `codex`, or `claude`), optional model/thinking settings, tools for Pi children, and an optional role prompt.
_Avoid_: Per-call model override, hidden provider switch

**Dynamic Workflow**:
A trusted JavaScript script run inside one outer background Workflow task. It can call `agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, and `log(message)`, then return a JSON-serializable result. Internal dependencies remain awaited and do not individually notify the foreground.
_Avoid_: Long-running service, cron, workflow platform

**Saved Workflow**:
A workflow script stored under `~/.pi/agent/workflows/*.js` or trusted `.pi/workflows/*.js`, identified by `meta.name`, and invoked by natural-language routing through the `workflow` tool.
_Avoid_: Slash command, auto-run hook

**Resume-by-Replay**:
Rerunning a persisted workflow with `resumeFromTaskId` so cached subagent outputs are reused for the longest unchanged prefix of `agent()` calls. The first changed or new call and everything after it runs live. Workflow task IDs are also journal identities.
_Avoid_: Separate run ID, checkpointed process

**Global Concurrency Limit** (`maxConcurrentSubagents`):
The maximum number of subagents running concurrently. A slot is taken when a subagent starts and released when it completes, fails, or is aborted. Requests above the cap queue and drain as slots become free. Direct Agent tasks and Workflow-internal agents share the same limiter.
_Avoid_: Delegation width, fan-out quota, per-turn budget

**Foreground Agent**:
The root Pi coordinator. It receives accepted task envelopes immediately, may continue independent work, and correlates terminal notifications by task ID. In print and JSON modes, the extension keeps the session alive until all accepted tasks and resulting notification turns finish.
_Avoid_: Task worker, scheduler

## Example Dialogue

Developer: "Should this subagent keep the parent conversation?"
Domain expert: "No. A fresh child starts without parent context. Give it a self-contained task. Reuse its returned session key only when a later task should continue that child conversation."

Developer: "Can a Pi-backed subagent call another subagent?"
Domain expert: "No. The root agent coordinates delegation. Pi-backed children do not receive `Agent` or `workflow`. External CLI backends use their own tool surface."

Developer: "Does the workflow tool block the root agent?"
Domain expert: "No. The outer tool returns an accepted task immediately. The workflow runs in the background, awaits its own internal stages, then sends one terminal notification."

Developer: "Can workflows route lanes to Codex or Claude Code?"
Domain expert: "Yes. Use `subagent_type` to select a profile whose frontmatter sets `backend: codex` or `backend: claude`."
