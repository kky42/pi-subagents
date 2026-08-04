<div align="center">

# pi-flow

**Give Pi a team.**

Run asynchronous subagents and multi-agent workflows across **Pi**, **Codex CLI**, and **Claude Code** without leaving your Pi session.

[![CI](https://github.com/kky42/pi-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/pi-flow/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40kky42%2Fpi-flow?label=npm)](https://www.npmjs.com/package/@kky42/pi-flow)
[![license](https://img.shields.io/npm/l/%40kky42%2Fpi-flow)](./LICENSE)

</div>

![A real Pi interactive session showing parallel subagents and workflows with live progress](./assets/pi-flow-interactive.png)

<p align="center"><sub>Captured from a real Pi interactive session running parallel subagents and workflows.</sub></p>

## One coordinator, asynchronous specialists

`run_agent` and `run_workflow` run as background tasks. Pi receives an `accepted` result immediately, continues independent work, then receives one correlated `completed` or `failed` notification. `accepted` means launched, not finished, and there is nothing to poll.

| Primitive | Use it for |
| --- | --- |
| **`run_agent`** | One focused, resumable specialist or several independent specialists in parallel. |
| **`run_workflow`** | Parallel or staged subagents, branching, structured results, saved orchestration, and replay. |

Every subagent runs through a named profile, so one Pi coordinator can mix Pi, Codex CLI, and Claude Code specialists in the same task.

## Install and try it

```bash
pi install npm:@kky42/pi-flow
```

> **Upgrading from v2?** Rename `Agent` to `run_agent`, `workflow` to `run_workflow`, `description` to `label`, and `subagent_type` to `profile`. Workflow scripts now call `run_agent()` and use `script_path` / `resume_from_task_id`.

Ask Pi naturally:

```text
Use three subagents in parallel to review architecture, tests, and documentation, then synthesize their findings.
```

```text
Use a workflow to classify each changed file by risk, run the matching review, and return structured results.
```

Pi shows each task as `accepted` immediately, then posts one correlated `completed` or `failed` notification.

### Add simple specialists

Profiles live at `~/.pi/agent/subagents/<name>.md`. The filename becomes the profile name. Codex and Claude profiles bypass their native permission prompts, so use them only in trusted repositories.

**Pi explorer**

```md
---
description: Fast read-only repository explorer.
tools: read, grep, find, ls
---
Map the repository and return the important paths.
```

**Codex reviewer**

```md
---
description: Reviews code for correctness and missed edge cases.
backend: codex
---
Review the current diff and lead with concrete findings.
```

**Claude UI reviewer**

```md
---
description: Reviews UI quality and accessibility.
backend: claude
---
Inspect the UI and recommend specific improvements.
```

## Why pi-flow?

- **Asynchronous by default.** Delegation runs in the background while Pi remains available.
- **Parallel but bounded.** Direct and workflow subagents share one concurrency limit.
- **Multi-backend.** Mix Pi, Codex CLI, and Claude Code through simple profiles.
- **Real orchestration.** Workflows support parallel stages, pipelines, branching, schemas, saved scripts, and replay.
- **Resumable specialists.** Reuse a direct subagent's `session_key` to continue its backend conversation.
- **Visible progress.** Pi's TUI distinguishes queued from running subagents, folds each workflow's child progress into one row, and reports cumulative tokens, cache usage, and cost when available. The widget stays within five lines while active and collapses to one idle line.

## Extension coordination events

PiFlow emits `pi-flow:task-state` on Pi's synchronous event bus when an agent or workflow task is accepted and immediately before its terminal notification:

```ts
{
  version: 1,
  task_id: string,
  task_type: "agent" | "workflow",
  status: "accepted" | "completed" | "failed"
}
```

Other extensions can track accepted task IDs until their matching completed or failed events without depending on PiFlow internals.

## Requirements

- [Pi](https://github.com/earendil-works/pi) 0.83.0 or newer
- Node.js 22.19 or newer
- [Codex CLI](https://github.com/openai/codex), installed and authenticated only for `backend: codex`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and authenticated only for `backend: claude`

Pi-backed specialists require no external CLI.

## Trust and safety

`run_workflow` JavaScript runs as trusted local code, not inside a security sandbox. Run only scripts you trust.

## License

[MIT](./LICENSE)
