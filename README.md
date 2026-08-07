<div align="center">

# pi-flow

**Give Pi a team.**

Run subagents and multi-agent workflows across **Pi**, **Codex CLI**, and **Claude Code** without leaving your Pi session.

[![CI](https://github.com/kky42/pi-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/pi-flow/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40kky42%2Fpi-flow)](./LICENSE)

</div>

> This branch is the synchronous PiFlow experiment. The published npm package currently uses the background execution contract.

## One coordinator, focused specialists

`run_agent` and `run_workflow` behave like normal Pi tools: the tool remains active, shows live progress, and returns its final result when the delegated work finishes. Independent `run_agent` calls issued together still execute concurrently under PiFlow's shared limit.

| Primitive | Use it for |
| --- | --- |
| **`run_agent`** | One focused, resumable specialist or several independent specialists in parallel. |
| **`run_workflow`** | Parallel or staged subagents, branching, structured results, and saved orchestration. |

Every subagent runs through a named profile, so one Pi coordinator can mix Pi, Codex CLI, and Claude Code specialists in the same task.

## Try this branch

```bash
git clone --branch experiment/synchronous-execution https://github.com/kky42/pi-flow.git
cd pi-flow
npm ci
pi -e .
```

Ask Pi naturally:

```text
Use three subagents in parallel to review architecture, tests, and documentation, then synthesize their findings.
```

```text
Use a workflow to classify each changed file by risk, run the matching review, and return structured results.
```

The active Tool row shows queued and running work. Pi receives the final Tool result after the direct subagent or outer workflow finishes.

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

## Why this synchronous branch?

- **Direct results.** Delegation completes through the standard Pi Tool result path without a separate completion notification.
- **Parallel but bounded.** Direct and workflow subagents share one concurrency limit.
- **Multi-backend.** Mix Pi, Codex CLI, and Claude Code through simple profiles.
- **Real orchestration.** Workflows support parallel stages, pipelines, branching, schemas, and saved scripts.
- **Resumable specialists.** Pass a direct `session_key` up front or omit it and reuse the generated key returned with the result. Workflow scripts can reuse a key across internal `run_agent()` calls.
- **Visible progress.** Tool rows distinguish queued, running, completed, failed, and aborted work and show usage when available.

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
