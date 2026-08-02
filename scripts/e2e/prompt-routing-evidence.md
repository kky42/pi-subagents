# Prompt-routing behavior observations

This document describes the observation protocol in `scripts/e2e/prompt-routing.mjs`. The driver is intentionally not a routing test oracle: model choices are stochastic, so Agent, session continuation, workflow, tool-count, task-outcome, and fixture-change observations never pass or fail the run.

## Fixed model

Every scenario uses the same root configuration:

- Model: `openai-codex/gpt-5.6-luna`
- Thinking: `xhigh`
- Tools: `read`, `bash`, `Agent`, `workflow`
- Current worktree extension

The model and thinking level are pinned in the driver and cannot be overridden through CLI flags. This keeps observations comparable across prompt revisions.

## Background task contract

Agent and workflow are always-background public tools. A tool result only accepts a task and returns a compact envelope with `status: "accepted"` and a `task_id`. Agent acceptance also returns the resumable `session_key`; workflow acceptance does not.

A task later emits one custom terminal message with `customType: "pi-flow-task-notification"`. The driver parses those messages and correlates their `task_id` and task type with accepted tool results. Each accepted task is reported with a `completed`, `failed`, or `pending` outcome, and aggregate accepted/completed/failed/pending counts are included. `pending` means no matching terminal notification was retained before the root process ended. Unmatched terminal notifications are counted separately.

The terminal notification's content is not interpreted by this routing driver. In particular, the driver does not assume a workflow tool result or notification exposes a final workflow agent tree, child statuses, child session keys, or child usage. Usage in the report is root assistant usage only.

## Scenarios

The driver preserves five small, read-oriented scenarios:

- `direct`: narrow package lookup
- `focused`: context-heavy repository exploration
- `flat`: three independent review lanes
- `continuation`: two sequential calls intended to continue one child context
- `staged`: dependent classification and structured follow-up work

Each run records root tool calls, Agent call groups, requested Agent session keys, accepted Agent session keys, workflow source and script-shape signals, correlated task outcomes, model identity, root usage, duration, process status, and changed fixture files.

Accepted Agent session keys are anonymized as `key-1`, `key-2`, and so on in the pattern summary. This captures whether accepted calls used the same child conversation without retaining generated key values in that summary. Workflow scripts are inspected only for coarse authoring signals such as `pipeline()`, `parallel()`, schemas, and session-key expressions.

All routing values are observations only. Direct root work, one Agent, several Agents, workflow, completed tasks, failed tasks, pending tasks, and fixture changes are recorded without an expected behavioral assertion. No fresh real-model sample is claimed by this document for the new background contract.

## Infrastructure failures

The driver exits nonzero only when it cannot produce a trustworthy observation, including:

- Pi exits unsuccessfully or times out
- retained output exceeds safety bounds
- retained JSONL is malformed
- no terminal root response is produced
- the observed root model is not the pinned model
- setup, credential, artifact, or cleanup operations fail

A missing accepted task, failed background task, pending background task, unmatched notification, unexpected routing choice, or fixture change remains an observation rather than an infrastructure failure. A successful run prints `[OBSERVED]`. `[INFRA FAILURE]` means the harness failed, not that the model selected an unexpected route or a delegated task failed.

## Privacy and authentication

The driver creates a five-file fixture and an isolated Pi agent directory. Discovered extensions, skills, prompt templates, themes, context files, and session persistence are disabled. It copies only the `openai-codex` credential entry into a mode-0600 isolated auth file, so the pinned subscription can authenticate without exposing other provider credentials or mutating the operator's live auth store. The isolated directory is removed after every normal run, including retained-observation runs.

The repository-wide Claude safety guard remains installed. A DeepSeek credential is therefore still required so any accidental Claude Code process cannot fall back to Anthropic login or another provider. DeepSeek values, initial and refreshed isolated OpenAI Codex credential values, and machine-specific paths are redacted from retained output.

## Running observations

Run every scenario twice:

```bash
npm run e2e:prompt-routing
```

Run selected scenarios or change repetition count:

```bash
npm run e2e:prompt-routing -- \
  --only focused,flat,staged \
  --repetitions 3
```

Use `--keep` to retain sanitized `stdout.jsonl`, `stderr.log`, and `report.json`. Use `--auth-agent-dir` when the OpenAI Codex login is stored outside the normal Pi agent directory.

The report states explicitly that routing choices and fixture changes do not affect exit status. Compare reports across prompt revisions rather than treating one sample as deterministic evidence.
