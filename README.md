<div align="center">

# pi-flow

**Give Pi a team.**

Run asynchronous subagents and multi-agent workflows across **Pi**, **Codex CLI**, and **Claude Code** without leaving your Pi session.

[![CI](https://github.com/kky42/pi-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/pi-flow/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40kky42%2Fpi-flow?label=npm)](https://www.npmjs.com/package/@kky42/pi-flow)
[![license](https://img.shields.io/npm/l/%40kky42%2Fpi-flow)](./LICENSE)

</div>

![A real Pi interactive session showing four direct Agents and two Workflows, live Workflow child progress, and the final one-line idle summary](./docs/images/pi-flow-interactive.png)

<p align="center"><sub>Captured from a real Pi interactive session with four direct Agents, two Workflows, and four Workflow child agents.</sub></p>

## One coordinator, asynchronous specialists

`Agent` and `workflow` run as background tasks. Pi receives an `accepted` result immediately, continues independent work, then receives one correlated `completed` or `failed` notification. `accepted` means launched, not finished, and there is nothing to poll.

| Primitive | Use it for |
| --- | --- |
| **`Agent`** | One focused, resumable specialist or several independent specialists in parallel. |
| **`workflow`** | Parallel or staged child agents, branching, structured results, saved orchestration, and replay. |

Every subagent runs through a named profile, so one Pi coordinator can mix Pi, Codex CLI, and Claude Code specialists in the same task.

## Get started in 30 seconds

```bash
pi install npm:@kky42/pi-flow
```

Ask Pi naturally:

```text
Use three agents in parallel to review architecture, tests, and documentation, then synthesize their findings.
```

```text
Use a workflow to classify each changed file by risk, run the matching review, and return structured results.
```

### Add simple specialists

Profiles live at `~/.pi/agent/subagents/<name>.md`. The filename becomes the `subagent_type`.

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
- **Parallel but bounded.** Direct Agents and Workflow children share one concurrency limit.
- **Multi-backend.** Mix Pi, Codex CLI, and Claude Code through simple profiles.
- **Real orchestration.** Workflows support parallel stages, pipelines, branching, schemas, saved scripts, and replay.
- **Resumable specialists.** Reuse a direct Agent's `session_key` to continue its backend conversation.
- **Visible progress.** Pi's TUI shows active tasks, Workflow child progress, tokens, cache usage, and cost, then collapses to one idle line.

## Requirements

- [Pi](https://github.com/earendil-works/pi)
- Node.js 22.19 or newer
- [Codex CLI](https://github.com/openai/codex), installed and authenticated only for `backend: codex`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code), installed and authenticated only for `backend: claude`

Pi-backed specialists require no external CLI.

## Trust and safety

Use external backends and Workflow scripts only in trusted repositories. Codex and Claude profiles bypass their native permission prompts, and Workflow JavaScript runs as trusted local code rather than inside a security sandbox.

## License

[MIT](./LICENSE)
