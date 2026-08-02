# Prompt-routing behavior observations

This document describes the observation protocol in `scripts/e2e/prompt-routing.mjs`. The driver is intentionally not a routing test oracle: model choices are stochastic, so Agent, session continuation, workflow, tool-count, and fixture-change observations never pass or fail the run.

## Fixed model

Every scenario uses the same foreground configuration:

- Model: `openai-codex/gpt-5.6-luna`
- Thinking: `xhigh`
- Tools: `read`, `bash`, `Agent`, `workflow`
- Current worktree extension

The model and thinking level are pinned in the driver and cannot be overridden through CLI flags. This keeps observations comparable across prompt revisions.

## Scenarios

The driver runs five small, read-oriented scenarios:

- `direct`: narrow package lookup
- `focused`: context-heavy repository exploration
- `flat`: three independent review lanes
- `continuation`: two sequential calls intended to continue one child context
- `staged`: dependent classification and structured follow-up work

Each run records root tool calls, Agent call groups, session-key usage, workflow source and script-shape signals, child results, model identity, usage, duration, process status, and changed fixture files.

These values are observations only. For example, direct root work, one Agent, several Agents, or workflow are all recorded without an expected routing assertion.

## Full-scenario sample before the pipeline example

One repetition per scenario was observed on 2026-08-02 against the modified working tree based on `325ad60`, before the dependent-pipeline example was added:

| Scenario | Observed route |
| --- | --- |
| `direct` | One root `read`; no Agent or workflow call |
| `focused` | Two fresh Agent calls issued together, plus root `bash`/`read` exploration |
| `flat` | Three fresh Agent calls issued together |
| `continuation` | Two sequential Agent calls using the same non-empty session key |
| `staged` | One six-child structured pipeline ended with a script error, then one six-child structured parallel workflow completed |

All five Pi processes exited successfully, reported `openai-codex/gpt-5.6-luna`, produced terminal responses, and left the fixture unchanged. The focused run still performed root exploration after delegation. The staged retry followed `TypeError: Cannot read properties of undefined (reading 'file')` in the first generated workflow. Both are intentionally preserved as observations rather than classified as failures. This single sample does not establish deterministic routing.

## Dependent-pipeline example comparison

A focused comparison ran the `staged` scenario three times without a dependent-pipeline example and three times after adding one to the workflow `script` parameter description. Both variants used the same fixture, driver, `openai-codex/gpt-5.6-luna` model, and `xhigh` thinking. The example demonstrates a static schema, concurrent pipeline items, explicit stage returns, null handling, and two calls that continue the same per-item child through `session_key`. The separate `parallel()` rule retains a minimal thunk example. Generated scripts and child result details were inspected to confirm that each with-example workflow reused one key across the two calls for each item.

| Observation | Without example | With example |
| --- | ---: | ---: |
| Root runs | 3 | 3 |
| First workflow call completed | 2/3 | 3/3 |
| Generated workflow calls | 6 | 5 |
| Workflow script errors | 2 | 0 |
| Scripts using `pipeline()` | 1/6 | 5/5 |
| Scripts using per-item `session_key` continuation | 0/6 | 5/5 |
| Runs repeating a completed workflow | 1/3 | 2/3 |
| Completed child-agent calls | 24 | 30 |
| Reported tokens, root plus children | 137,238 | 128,684 |
| Reported cost | $0.147169 | $0.137406 |
| Summed wall time | 209.5s | 181.2s |

Without the example, one run first produced a dynamically constructed schema enum rejected by static preflight, then a script with mismatched parentheses. The other generated scripts completed, including one valid pipeline. With the example, every generated script parsed, passed preflight, used a pipeline, reused one session key per file across its two stages, and completed all six children. Two with-example runs still repeated a successful workflow after initially misclassifying `package.json`, so the example improved orchestration shape and script validity in this sample but did not eliminate semantic mistakes or redundant self-correction. The small stochastic sample is not performance or reliability proof.

After correcting the dynamic-schema wording and adding direct session-key observations to the driver, one final run against the resulting prompt completed one six-child pipeline on its first workflow call. Its script contained two `session_key` expressions, and the child details reported six keyed calls across three keys, each reused once. No workflow error or fixture change occurred.

## Infrastructure failures

The driver exits nonzero only when it cannot produce a trustworthy observation, including:

- Pi exits unsuccessfully or times out
- retained output exceeds safety bounds
- retained JSONL is malformed
- no terminal root response is produced
- the observed root model is not the pinned model
- setup, credential, artifact, or cleanup operations fail

A successful run prints `[OBSERVED]`. `[INFRA FAILURE]` means the harness failed, not that the model selected an unexpected route.

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
