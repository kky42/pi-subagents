# Agent Notes

## Comment standards

- Code must explain its own behavior through clear names, types, structure, and tests. Do not use comments to narrate what the next line, branch, loop, function, or assertion does.
- Keep a comment only when it preserves information that cannot be recovered from the code itself. Allowed cases are:
  - why a design was chosen and which tradeoff it accepts;
  - why a default, limit, timeout, or threshold has its particular value;
  - an external constraint, compatibility requirement, protocol rule, security boundary, or non-obvious failure mode;
  - a temporary workaround or compromise and the condition under which it can be removed;
  - an actionable `TODO`/`FIXME` with the missing behavior or blocking condition.
- Prefer improving unclear code over explaining it with a comment. Delete decorative section labels, comments that repeat symbol names or test assertions, and stale historical narration.
- Documentation for public APIs exposed through `package.json` exports may describe contracts, inputs, outputs, and failure semantics, but must not paraphrase the implementation. A TypeScript `export` alone does not justify documentation.
- When changing nearby code, update or remove its comments in the same change. A misleading comment is worse than no comment.
- These rules apply to source, tests, scripts, and examples. Do not edit generated output, vendored dependencies, or `refs/` solely to enforce them.

## pi-flow run_agent contract

- This repo implements a lightweight pi extension named `pi-flow`, not a fork of `refs/pi-subagents`.
- The registered tool is `run_agent`. v2 adds an opt-in `run_workflow` tool (see "pi-flow workflows (v2)" below); the v1 contract here still governs the `run_agent` tool.
- Tool parameters use `label`, `prompt`, optional `profile`, and optional `session_key` for a resumable child conversation.
- `label` is UI/routing metadata. `prompt` is the full subagent task.
- The only V1 built-in profile is `general-purpose`. There are no built-in aliases.
- `profile` defaults to `general-purpose`.
- `general-purpose` adds no role prompt.
- Do not replace pi's base system prompt in v1.
- Every top-level `run_agent` call follows Pi's normal Tool lifecycle: `execute()` remains pending until the child completes, fails, or is aborted, and then returns one terminal envelope containing `task_type`, `status`, `label`, and plain-text `content`, plus `session_key` only when a resumable child session actually started. There is no accepted Tool result, custom completion notification, polling, steering, scheduling, per-call model override, or per-call thinking override.
- Top-level calls use the Tool abort signal. Before session-tree navigation or shutdown, abort and drain active PiFlow calls, then reset task and session-key state without creating a model turn.
- Tool calls accept only `label`, `prompt`, optional `profile`, and optional `session_key`; backend/model/thinking selection is profile-based.
- Subagent timeout is a global operator-facing guardrail (`subagentTimeoutMs` / `--subagent-timeout-ms`), not a per-call parameter on `run_agent` or workflow `run_agent()`. The runtime timeout is owned by `spawnSubagent` after callers acquire a concurrency slot, so queue time does not count against it.
- Direct subagents start with a fresh persisted conversation and the same working directory when `session_key` is omitted. PiFlow generates and returns the effective key once the child starts, so a later call can resume it; failed calls that never started a child carry no key. A supplied unbound key names a new child; a bound key continues that child. Parent messages and tool results are not inherited. The extension maps the key to the backend-native session/thread id and persists the direct-subagent binding as parent-session custom state.
- Pi-backed subagents inherit the caller's current model and thinking level unless a custom profile pins `model` or `thinking`.
- Custom profiles may set `backend: pi` (default), `backend: codex`, or `backend: claude`. Every direct run_agent call is persistent from its first turn. Unkeyed Workflow-internal calls may remain one-shot. Codex uses `codex exec resume --json ... <session_id> -` for continuation; Claude uses `--resume <session_id>`. Both receive the task on stdin, profile prompt/model/thinking settings, bounded output handling, usage parsing, and the existing external CLI permission bypasses. Only use external backends in trusted repositories.
- `tools` frontmatter is a pi-backend child-session allowlist only. External CLI profiles use their CLI's own tool and permission surface.
- There is no pi-flow permissions system in v1. Profiles are ordinary agents with optional prompts and tool allow-lists; external backends are explicit user dependencies.
- Subagents cannot invoke PiFlow delegation tools. Pi-backed children receive neither `run_agent` nor `run_workflow` nor the flow prompt (`buildFlowPrompt`); external CLI children do not load the PiFlow extension.
- External CLIs may still expose their own native nested/delegation features; do not try to block those unrelated capabilities from this extension.
- Parallel delegation is allowed and bounded by a global `maxConcurrentSubagents` limit (default `12`), which caps how many subagents run concurrently across the whole agent run. A slot is taken on launch and released on completion/failure/abort. In v2 this same cap is shared with the `run_workflow` tool.
- Do not put exact concurrency values in model-facing text. Runtime concurrency remains bounded and queued without exposing the operator's configured limit to the model.
- Users can override the limit with the pi extension flag `--max-concurrent-subagents <n>`; embedded extension setups can set the default with `createFlowExtension({ maxConcurrentSubagents })` (compatibility alias: `createSubagentExtension`).
- Custom subagent profiles are supported from `~/.pi/agent/subagents/*.md`; the only built-in is `general-purpose`. A user can define a custom profile named `explorer`, but it is not bundled.

## pi-flow workflows (v2)

- Adds a second registered tool, `run_workflow`, alongside `run_agent`: one product, two entry points. Built on the same spawn core, not a reimplementation of `refs/pi-dynamic-workflows`.
- Opt-in via `createFlowExtension({ workflow })` (compatibility alias: `createSubagentExtension`); defaults to `true`. Set `false` for a subagents-only runtime surface.
- The `run_workflow` tool runs a trusted, model-written JavaScript script in an isolated Worker-hosted `node:vm` context so pi can detect stalls and abort unresponsive scripts. Initial synchronous execution is bounded (5s by default), and post-`await` event-loop stalls are caught by a heartbeat watchdog. This is not a security sandbox; saved workflows are trusted code like extensions, and inline workflows are model-written code executed by the local process. Globals: `run_agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`, `cwd`. The script must start with `export const meta = { name, description }` (a plain literal) and call `run_agent()` at least once.
- Determinism is a cooperative parse-time lint via an `acorn` AST scan: Date APIs and `Math.random()` uses, including simple aliases/destructuring, are rejected for normal model-written scripts. Dynamic authoring, deterministic-by-convention execution. The scan checks determinism ONLY - it intentionally permits ordinary computed member access (`obj[key]`, `arr[i]`, `{ [k]: v }`) except static `Math['random']`, and does not attempt vm-escape hardening. Do not claim malicious JavaScript is sandboxed.
- `run_agent()` reuses the shared spawn core, so a `profile` selects a real profile and the subagent gets that profile's configured backend, model, thinking level, prompt, optional `session_key`, and (for pi-backed profiles only) tool allow-list - not stubbed guidance. `run_agent(prompt, { schema })` requires a portable strict JSON Schema: every object must have `additionalProperties: false` and list all its properties in `required`; optional values use nullable types. Static schemas (inline object literals and top-level `const` references) are validated at script parse time before any subagent starts; dynamic options are validated at runtime before the requested agent launches. On a valid schema the subagent is forced to return one validated object: pi-backed subagents receive a terminating `structured_output` tool via `createAgentSession`'s `customTools` with the profile tool allow-list extended to admit it, while Codex-backed subagents use Codex CLI `--output-schema` and Claude-backed subagents use Claude Code `--json-schema`. The first successful structured result is captured; duplicate successful calls are ignored.
- Concurrency is the SAME global cap as `run_agent`: both tools share one `ConcurrencyLimiter`. Normal `run_agent` calls and workflow `run_agent()` calls both queue and drain via `acquire`; the cap limits simultaneously running subagents, not total requested subagents. The `run_workflow` tool itself does not consume a slot; only its `run_agent()` calls do. A workflow also has hard caps on total `run_agent()` calls, retained logs, and orchestration-worker memory (512MB old generation by default; subagent/tool subprocess memory is not included).
- The outer `run_workflow` Tool remains pending until its script and internal subagents finish, then returns one terminal envelope with its `name`, status, and result. Workflow-internal `run_agent()` calls keep their normal awaited, parallel, pipeline, and session-key semantics and do not produce top-level Tool results. Per-call model/thinking override remains out of contract; profile-based selection via `profile` is the supported path.
- Nesting is hard-blocked for pi-backed workflow subagents: they get neither `run_agent` nor `run_workflow`. External CLI backends use their own tool surface; this extension does not try to prevent nested/delegation features inside those CLIs.
- Do not put exact concurrency values in model-facing workflow text; the runtime owns bounded queueing.
- Architecture: `src/core/{spawn,concurrency,model,progress,stream,task-manager}.ts` is the shared core; `src/pi-subagent.ts` owns the direct-agent Tool and extension lifecycle; `src/pi-workflow.ts` owns the Pi-facing workflow Tool and phase-tree renderer; `src/workflow/{runtime,source,structured-output,output-schema}.ts` is the workflow engine. The synchronous task manager owns active-call abort/drain behavior, but not background scheduling or notifications.
- The throttled progress-emit + heartbeat machinery lives once in `progress.ts` as `createProgressEmitter` and is shared by all three backends (`spawn.ts` Pi, `codex.ts`, `claude.ts`); do not re-inline per-backend copies. Direct and workflow callers own queued state because limiter wait time is outside the per-subagent runtime timeout.
- External-CLI backends bound parent-side child output via `createBoundedBuffer` (`stream.ts`): stderr is capped (`MAX_STDERR_CHARS`) and a single newline-free stdout line over `MAX_STDOUT_LINE_CHARS` aborts/fails the run clearly, so one runaway subagent cannot OOM the host pi process. A clean exit (code 0) with usable final text but no recognized terminal event is accepted rather than failed, so a CLI stream-format change does not turn good runs into failures.

## Headless workflow execution

- `@kky42/pi-flow/runtime` remains the lightweight plain-Node orchestration engine: callers provide `runSubagent`, and the export must not gain runtime dependencies on Pi peer packages.
- `@kky42/pi-flow/headless` is the batteries-included programmatic executor for schedulers and services. It loads current profiles and reuses the same canonical profile/model/thinking/backend/tools/session-key/structured-output spawn path as the interactive `run_workflow` tool, without requiring an `ExtensionContext` or TUI.
- The shared profile-aware runner lives in `src/workflow/subagent-runner.ts`; do not reimplement that behavior in headless consumers. Headless callers may restrict allowed backends as an execution policy and receive cumulative usage callbacks.

## Saved workflows (v3)

- The `run_workflow` tool requires `name` on every call. With no script source, `name` selects a saved workflow. Inline `script` and persisted `script_path` are optional mutually exclusive sources whose `meta.name` must match `name`. `args` is still exposed to the script as the `args` global.
- Saved workflow files are plain JavaScript under `~/.pi/agent/workflows/*.js` (global) and trusted `.pi/workflows/*.js` (project-local). There is no per-workflow slash command surface; the agent discovers saved workflows from the prompt roster and invokes `run_workflow({ name, args })` from natural language.
- Project workflows are loaded only when `ctx.isProjectTrusted()` is true. Saved files are realpath-checked to stay inside an allowed workflow root, must end in `.js`, and are parsed with the same `export const meta = { name, description }` plus determinism-lint and schema-preflight validators before every run. Never auto-run on discovery.
- Workflow identity is `meta.name`; valid saved names match lowercase letters/digits plus `_` or `-`. Project workflows override global workflows with the same name.
- The root prompt includes the complete effective saved-workflow roster (`name`, `description`) with no count or description truncation and shows an explicit empty roster when none exist. Put both summary and “when to use” routing guidance in `description`; do not include script bodies in the prompt.
- Inline workflow tasks are executed directly and are not auto-persisted. `script_path` resolves only inside trusted global or project saved-workflow roots.
- Workflow replay, workflow journals, status polling, steering, dynamic command registration, nested workflow calls, model override, and worktree isolation are not provided.

## CI and release workflow

- CI lives in `.github/workflows/ci.yml` and runs on pull requests plus pushes to `main`. It installs with `npm ci` and runs `npm run check` on Node 22.x and 24.x.
- Real-model E2E scripts are intentionally not part of required CI because they can be slow or inconclusive. Run `npm run e2e` before risky releases; it sequentially runs the complete real-model suite: basic metrics, claude cost fallback, workflow features, prompt routing, and session-key continuation across all backends. Use the individual `e2e:*` scripts only for focused iteration.
- Prompt and routing E2E review is not complete from command exit status alone. Run the relevant driver with `--keep`, then inspect each raw root session JSONL for one terminal Tool result per call, no custom task notification, correct sibling-call parallelism, and no work after a dependent call before its result. Keep raw sessions local and remove them after review.
- Real-model E2E drivers must fail the harness when a child process cannot start, times out, or exits nonzero. Do not classify process failures as inconclusive model behavior.
- Every real-model E2E driver must install the guard from `scripts/e2e/lib/deepseek-claude-env.mjs` so any Claude Code process routes through DeepSeek's Anthropic-compatible endpoint with isolated settings. Drivers must fail fast without `DEEPSEEK_API_KEY`/`DEEPSEEK_API_TOKEN` (or `--deepseek-api-key-env`) and must not fall back to Anthropic login or another Claude Code provider.
- There is intentionally no automated npm publish workflow right now; do not create tags expecting GitHub Actions to publish, and do not add an `NPM_TOKEN`-based workflow unless the user asks.
- Normal version-prep steps for agents:
  1. Bump `package.json` and `package-lock.json` with `npm version patch|minor|major --no-git-tag-version`.
  2. Run `npm run check` (and manual E2E when warranted).
  3. Commit and push `main`.
  4. Stop and ask the user before publishing. Only run `npm publish --access public` when the user explicitly asks for a manual publish from the local authenticated npm session.
  5. After a successful publish, create and push an annotated Git tag for the exact published commit: `git tag -a vX.Y.Z -m "vX.Y.Z" <commit>` then `git push origin vX.Y.Z`.
  6. Create a GitHub Release for that tag with concise release notes, so GitHub tags/releases act as the public changelog: `gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."`.
- `pi.dev` updates from the npm package manifest automatically after a successful npm publish.

## References Read

- `refs/pi` for pi extension and SDK APIs.
- `refs/pi-subagents` for a broader Claude Code-style implementation.
- `refs/claude-code-system-prompts` for delegation-tool guidance and built-in agent prompts.
- Official Claude Code subagent docs: https://code.claude.com/docs/en/sub-agents

## Synchronous E2E evidence

Real Pi runs on 2026-08-05 validated the synchronous Tool lifecycle:

- `prompt-routing`: five scenarios with `openai-codex/gpt-5.6-luna` at xhigh thinking completed with no infrastructure failure. Direct lookup stayed in the root, focused and flat reviews issued parallel sibling `run_agent` calls, continuation reused one generated `session_key`, and staged work used synchronous workflows. Every delegation had one terminal Tool result and no custom task notification.
- `workflow-features`: the prior nine-scenario real-model run passed with `openai-codex/gpt-5.6-luna` at high thinking. The current eight-scenario driver covers parallel, pipeline, structured output, branching, routing, queueing, determinism rejection, saved workflows, and schema discovery; replay and workflow journals were subsequently removed.
- `session-key-resume`: real Pi, Codex CLI, and Claude Code backends each generated a key, resumed the same child conversation, recalled a non-sensitive marker unavailable from the fixture or Git, returned two correlated terminal Tool results, and emitted no custom notification.
- `synchronous-tool-ui`: an interactive tmux run with `deepseek/deepseek-v4-flash` at high thinking showed a live direct Tool row with activity, a live two-child workflow phase tree, compact completed rows, cumulative usage, and one final root response. A follow-up run verified direct completed rows retain usage after Pi removes top-level usage before invoking custom TUI renderers.

## Historical asynchronous E2E evidence

The evidence below was collected for the asynchronous mainline and does not validate this synchronous experiment branch.

Historical interactive tmux TUI runs used `deepseek/deepseek-v4-flash` with high thinking and isolated `--no-*` resource flags.

- `background-ui`: validated immediate accepted receipts, independent root turns, and correlated terminal notifications in an interactive tmux run.
- `activity-widget`: a real Pi 0.83.0 TUI run with DeepSeek launched four subagent tasks and two workflow tasks. The active widget stayed within five lines, removed each completed task's detail immediately, updated cumulative child usage while other tasks remained active, and collapsed to one idle line. A real RPC run emitted matching `setWidget` active/idle payloads with `belowEditor` placement, one terminal notification, and no stderr.
- `task-ui`: a real Pi 0.83.0 TUI run with `openai-codex/gpt-5.6-luna` validated live and completed Pi Agent and Workflow rows across background execution and terminal notifications.
- `width`: previously validated eight parallel foreground delegations under the old contract.
- `proactive-multirepo-v3`: validated two-repo parallel run_agent fan-out under the previous routing contract.
- `proactive-fanout-v3`: validated three-lane TODO/FIXME/skipped-test run_agent fan-out under the previous routing contract.
- `proactive-migration-v2`: validated second-opinion run_agent delegation under the previous routing contract.
- `max-concurrent-queue`: validates `--max-concurrent-subagents 1` with two parallel normal `run_agent` calls; both completed (`FIRST_OK`, `SECOND_OK`) and no max-concurrency rejection was emitted.

Root-direct handling of narrow or small fixtures is intentional: the coordinator prompt explicitly permits staying in the root when delegation adds no value.

### Synchronous prompt routing behavior

The appended PiFlow prompt contains the workflow authoring guide plus complete profile and saved-workflow rosters. Normal Pi Tool semantics already communicate that calls return final results, so do not add lifecycle prose that explains waiting, background notifications, sleeping, or polling. Tool descriptions and prompt guidelines own the stable `run_agent` versus `run_workflow` routing boundary.

### Historical asynchronous prompt routing behavior

The appended PiFlow prompt owns shared lifecycle semantics, including non-overlapping foreground work and automatic background completion, plus the ad-hoc workflow authoring guide and example and the complete effective subagent and saved-workflow rosters. `run_agent` and `run_workflow` tool descriptions explain their distinct selection boundaries in one to three sentences. Their concise `promptSnippet` values provide active-tool discovery, `promptGuidelines` hold tool-specific behavior, and parameter descriptions remain field-specific.

`scripts/e2e/prompt-routing.mjs` is an observation-only real-model driver pinned to `openai-codex/gpt-5.6-luna` with `xhigh` thinking. It records routing, continuation, workflow shape, usage, timing, and fixture changes across scenarios without behavioral PASS/FAIL assertions; only harness or process failures make the command fail. With `--keep`, it retains the raw Pi sessions needed for semantic behavior review. Deterministic tests cover roster injection, tool-schema shape, run_agent execution, and session continuation without asserting explanatory prompt wording; review that prose directly and use observational E2E for model behavior. A retained two-repetition flat/staged run on 2026-08-05 found no foreground work that repeated any of eight active agent/workflow tasks; one flat run used three non-overlapping Bash calls for Git, cwd, and Pi environment checks.

### Historical duplicate-message observation E2E

The now-deleted `scripts/e2e/duplicate-messages.mjs` driver preserved the real RPC scenario that exposed identical foreground text blocks while PiFlow subagents were active. It pinned the foreground to `openai-codex/gpt-5.6-sol` with `xhigh` thinking, used delayed Pi-backed `openai-codex/gpt-5.6-luna` expert children, and recorded text-block phases, multi-block responses, exact duplicates, notification timing, delegation counts, and foreground reads. Duplicate and multi-block observations did not affect exit status; process failures, timeouts, and incomplete accepted-task delivery did. A retained 2026-08-05 run kept all 12 foreground evidence-chain reads outside the four delegated repository-review scopes, but still emitted four unnecessary waiting/status messages while tasks remained active.

### Historical background-idle behavior E2E

The now-deleted `scripts/e2e/background-idle.mjs` driver ran a real RPC session in a temporary working directory with foreground Bash enabled and one deliberately delayed Pi-backed child. Its user prompt specified the delegated task without telling the foreground how to behave while it ran. The command failed if the foreground invoked Bash between task acceptance and its terminal notification, if lifecycle correlation was incomplete, or if the final response omitted the delegated result. The former `--keep` option retained raw Pi sessions for behavior review. In three retained 2026-08-05 repetitions, the foreground made no tool calls between each accepted result and terminal notification and only synthesized the child result afterward.

### Historical asynchronous run_workflow E2E

A real `pi -p --mode json` matrix with `openai-codex/gpt-5.6-luna` (high thinking) validated all nine workflow-feature scenarios under the background contract. Every accepted Workflow task correlated with one terminal notification, print mode drained before exit, replay reused successful journaled prefixes, and parallel, pipeline, structured output, branching, routing, queueing, determinism rejection, saved workflows, and schema discoverability all passed. A separate real Pi-backend session-key E2E proved that an omitted first-call key is generated, returned, reused on the second call, and correlated across both terminal notifications.

### Basic metrics semi-E2E

The direct-harness matrix in `scripts/e2e/basic-metrics.mjs` replaces the old Claude Code versus pi-flow delegation comparison and the duplicate single-backend smoke drivers. It runs one read-only fixture through each requested harness/model pair at medium thinking, feeds the real JSONL through pi-flow's production telemetry parsers/formatter, and reports per-row process, completion, model, tool, result, usage, token, CH, cost, and display checks. Unknown upstream pricing is a warning; missing usage/token/CH/display telemetry or missing Codex cost from Pi model pricing is a failure. Failed runs retain raw artifacts automatically.

Real filtered runs on 2026-07-10 covered all five rows successfully: Claude Code 2.1.206 via DeepSeek `deepseek-v4-flash[1m]` (`↑19k ↓201 R19k CH49.8% $0.112`), Codex CLI 0.145.0-alpha.2 with `gpt-5.5` (`↑4.8k ↓115 R22k CH81.9% $0.010`) and `gpt-5.6-luna` (`↑17k ↓129 R7.9k CH32.1% $0.018`), and installed Pi 0.80.6 with `openai-codex/gpt-5.5` (`↑1.3k ↓40 CH0.0% $0.008`) and `openai-codex/gpt-5.6-luna` (`↑1.3k ↓53 CH0.0% $0.002`). All rows completed, used the read tool, returned the fixture token, exposed valid usage/tokens/CH, and exposed valid reported or estimated cost.

### Claude cost fallback E2E

`scripts/e2e/claude-cost-fallback.mjs` runs two real Claude Code turns through the production spawn path with a wrapper that strips only the CLI-computed cost fields, forcing the catalog estimate to price the disjoint Anthropic usage buckets (uncached input + cache read + cache write + output) at Pi catalog rates. The resumed turn must read a larger cache prefix than its uncached input and the estimate must match the catalog sum. A retained 2026-08-07 run on `claude-sonnet-4-5` (`↑0k ↓9 R28k`) priced a real cached turn at $0.0088854 versus $0.0001614 with the old clamping formula (55x undercount); reverting the formula makes the driver fail.
