# Prompt-routing behavior evidence

This document records the bounded real-model comparison for the prompt consolidation based on commit `8954ab8` (`v2.1.5`). It is maintainer evidence, not a claim that stochastic routing is deterministic.

## Accepted behavior boundary

- Narrow local work may stay in the root.
- One focused delegation or a small flat fan-out uses direct `Agent` calls.
- Saved workflows, dependent stages, control flow, structured results or branching, replay, and larger fan-out use `workflow`.
- One logical child stream may reuse a `session_key`; independent work stays fresh.
- Routing expectations do not name or assert any profile, child model, specialist, or default.

## Privacy and isolation

`scripts/e2e/prompt-routing.mjs` creates a five-file report-CLI fixture and an isolated Pi agent directory. It disables discovered extensions, skills, templates, themes, context files, and session persistence, then loads only the extension under test. It checks that every fixture file remains byte-for-byte unchanged.

The driver does not read normal Pi session history or copy local profiles. The Pi process receives a minimal environment containing basic process settings plus one resolved DeepSeek credential; unrelated and alternate credential variables are not forwarded. Only terminal JSON events needed to assess tool calls, results, and usage are retained, high-volume streaming updates are discarded, and every discovered DeepSeek credential value plus local root paths are redacted before artifacts are analyzed or written. The driver always removes its isolated child-session directory and Claude runtime directory, even when other sanitized artifacts are retained.

## Reproduction

Prerequisites for the recorded run:

- Node `v22.23.1`
- npm `10.9.8`
- Pi `0.83.0`
- `DEEPSEEK_API_KEY` or `DEEPSEEK_API_TOKEN`

The driver intentionally requires the root model and thinking level instead of encoding defaults:

```bash
npm run e2e:prompt-routing -- \
  --model deepseek/deepseek-v4-flash \
  --thinking high \
  --repetitions 2
```

Useful scoped form:

```bash
npm run e2e:prompt-routing -- \
  --model deepseek/deepseek-v4-flash \
  --thinking high \
  --repetitions 2 \
  --only flat,continuation,staged
```

The run installs the repository's DeepSeek Claude-provider guard even though these scenarios use Pi-backed children. `--extension <entry>` can compare another checkout or archived baseline. `--run-root` must identify a new or empty real directory; the driver marks ownership before writing and refuses to remove an unmarked root. An explicit `--agent-dir` must stay outside that root, while omitting it uses a driver-owned isolated directory. `--keep` retains sanitized fixture artifacts and `report.json`, while driver-owned session/runtime directories are always removed. The default removes the marked artifact root after a passing run.

## Prompt size

The same built-in-only profile map and the same counting method were used before and after. “Native” is the concatenated tool snippets/guidelines; “appended” is the `before_agent_start` pi-flow section.

| Prompt contribution | Before | After |
| --- | ---: | ---: |
| Tool-native metadata | 5,438 chars | 734 chars |
| Appended contract | 5,224 chars | 3,893 chars |
| Combined | 10,662 chars / 1,587 words | 4,627 chars / 675 words |
| Roster entry occurrences | 2 | 1 |

The combined contract shrank 56.6% by characters and 57.5% by words. The detailed appended contract remains because custom Pi system prompts omit normal tool-native snippets and guidelines.

## Real-model comparison

Setup for both sides:

- Root model: `deepseek/deepseek-v4-flash`
- Thinking: `high`
- Two repetitions per scenario
- Active tools: `read`, `bash`, `Agent`, `workflow`
- Ephemeral root session and isolated agent directory
- Same generated fixture, prompts, driver, process timeout, and checks
- Baseline extension: archived `8954ab8`
- Modified extension: this change

### Routing outcomes

| Scenario | Baseline | Modified | Accepted result |
| --- | --- | --- | --- |
| Narrow package lookup | root direct in 2/2 | root direct in 2/2 | yes |
| Focused repository map | root direct in 2/2 | root direct in 2/2 | yes; focused delegation is deliberately soft |
| Small flat three-lane review | three parallel Agent calls in 2/2 | three parallel Agent calls in 2/2 | yes; all calls fresh and completed |
| Same-child follow-up | two sequential Agent calls sharing one non-empty key in 2/2 | same in 2/2 | yes |
| Structured classify-then-follow-up | a pipeline workflow with at least two agent expressions and six completed children in 2/2 | same in 2/2 | yes |

All hard checks passed on both sides. The focused-map delegation observation was inconclusive in all four runs because the root handled the tiny fixture directly without workflow. Under the committed driver, the modified run's duplicate successful staged execution is also reported as inconclusive rather than hidden or treated as deterministic proof.

### Usage and cost

Usage sums root assistant usage plus nested usage from `Agent` and `workflow` tool results. Tokens include cache reads/writes as reported by Pi; costs are provider-reported.

| Side | Runs | Reported tokens | Reported cost | Summed wall time |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 10 | 622,059 | $0.014483 | 267.3s |
| Modified | 10 | 710,465 | $0.014233 | 256.0s |

Modified-run tokens were 14.2% higher, while reported cost was 1.7% lower and summed wall time was 4.2% lower. These small mixed differences are not evidence of an execution-cost improvement: child output and root search behavior dominated this stochastic sample despite the much smaller static prompt.

## Variance and limitations

- Two repetitions expose obvious route variance but cannot prove deterministic behavior or generalize to other root models.
- The focused scenario is intentionally soft. Direct investigation of this tiny fixture is acceptable.
- Both prompt versions sometimes inspected files in the root before delegating. The modified flat scenario did this in one repetition; prompt wording does not reliably eliminate duplicate search.
- An intermediate modified-prompt trial exposed a staged-authoring regression: one run compressed classification and follow-up into three children. Restoring the `pipeline()` stage argument contract and a concise dependent-stage example produced six-child pipeline workflows in the final 2/2 rerun.
- In the final modified sample, one staged run retried an invalid workflow before succeeding, while the other ran two successful six-child workflows despite guidance not to repeat completed branches. The driver reports duplicate successful execution as inconclusive; it accepts the route only when the terminal script contains a schema-bearing pipeline with at least two agent expressions and completes at least six children.
- The driver tests entry-point and continuation behavior only. It neither selects nor grades profile names, child models, or specialist roles.
- Saved-name and replay behavior remain covered by `npm run e2e:workflow-features`; this driver focuses on root prompt routing.
- After artifact-safety hardening, the final driver was rerun once each for flat fan-out, continuation, and staged orchestration: all three passed with 294,296 reported tokens, $0.007482 reported cost, and 107.2s summed wall time.

## Deterministic validation

The committed suite separately covers:

- active Agent/workflow prompt sections for both, either, and neither tool;
- detailed contract retention with a custom Pi base system prompt;
- one dynamic profile roster occurrence;
- same-stream continuation and fresh parallel Agent execution;
- dynamic-schema and saved-workflow filename guidance matching runtime behavior.

Run all required checks with:

```bash
npm run check
```
