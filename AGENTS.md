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
- Every top-level `run_agent` call is a background task. A valid call immediately returns a compact `accepted` envelope with `task_id`, `task_type`, `status`, `session_key`, and `label`; one later custom notification returns `completed` or `failed` with the same identifiers and plain-text `content`. There is no model-facing polling, steering, scheduling, per-call model override, or per-call thinking override.
- PiFlow emits versioned `pi-flow:task-state` events on Pi's synchronous event bus when a run_agent or run_workflow task is accepted and immediately before its terminal notification. The payload contains only `version`, `task_id`, `task_type`, and `status`, allowing other extensions to coordinate without depending on PiFlow internals.
- Retain each terminal envelope until Pi emits `message_end` for its custom message. Before session-tree navigation or shutdown, bind persistence to the owning session, abort owned tasks, append every retained or newly failed notification, then reset task state. Shutdown persistence must not trigger a model turn or replacement session.
- Tool calls accept only `label`, `prompt`, optional `profile`, and optional `session_key`; backend/model/thinking selection is profile-based.
- Subagent timeout is a global operator-facing guardrail (`subagentTimeoutMs` / `--subagent-timeout-ms`), not a per-call parameter on `run_agent` or workflow `run_agent()`. The runtime timeout is owned by `spawnSubagent` after callers acquire a concurrency slot, so queue time does not count against it.
- Direct subagents start with a fresh persisted conversation and the same working directory when `session_key` is omitted. PiFlow generates and returns the effective key so a later call can resume it. A supplied unbound key names a new child; a bound key continues that child. Parent messages and tool results are not inherited. The extension maps the key to the backend-native session/thread id and persists the direct-subagent binding as parent-session custom state.
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
- The outer `run_workflow` tool is always a background task and immediately returns a compact accepted envelope with `name` instead of run_agent's `label`, and without `session_key`. Its script still awaits internal `run_agent()` dependencies normally and emits one outer terminal notification. Internal subagents do not notify the foreground individually. There is no model-facing polling, steering, or scheduling. Per-call model/thinking override remains out of contract; profile-based selection via `profile` is the supported path.
- Nesting is hard-blocked for pi-backed workflow subagents: they get neither `run_agent` nor `run_workflow`. External CLI backends use their own tool surface; this extension does not try to prevent nested/delegation features inside those CLIs.
- Do not put exact concurrency values in model-facing workflow text; the runtime owns bounded queueing.
- Architecture: `src/core/{spawn,concurrency,flow-status,model,progress,stream,task-manager}.ts` is the shared core; `src/workflow/{runtime,tool,structured-output,output-schema}.ts` is the workflow layer; `src/pi-subagent.ts` wires both tools, one task manager, one limiter, notifications, print-mode draining, and the compact activity widget.
- The throttled progress-emit + heartbeat machinery lives ONCE in `progress.ts` as `createProgressEmitter` and is shared by all three backends (`spawn.ts` pi, `codex.ts`, `claude.ts`); do not re-inline per-backend copies. The queued→running and abort emit timing is owned by that emitter.
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
- Inline workflow tasks auto-persist their script under the current persisted session's workflow directory. Public task results do not expose script paths or journal paths.
- Workflow `task_id` is also its replay and journal identity. `run_workflow({ name, resume_from_task_id, args })` replays the persisted script only when `name` matches the journal; adding `script_path` permits an edited script whose `meta.name` must also match. Successful cached subagent results are reused for the longest unchanged prefix, then execution continues live. Cached fingerprints include prompt, label, phase, `profile`, `session_key` when present, and schema; journals retain backend-native IDs for keyed continuation.
- Replay rejects a source task only while that task remains active. A journal still marked `running` after its task is no longer active is recoverable. Journals retain workflow logs and subagent failure details without changing successful Workflow terminal content.
- No status polling, steering, dynamic command registration, nested workflow calls, model override, or worktree isolation is provided.
- Session bindings and workflow journals read and write only the current format. Do not add legacy readers, migrations, or tests whose sole purpose is asserting rejection of old persistence versions unless the user asks.

## CI and release workflow

- CI lives in `.github/workflows/ci.yml` and runs on pull requests plus pushes to `main`. It installs with `npm ci` and runs `npm run check` on Node 22.x and 24.x.
- Real-model E2E scripts are intentionally not part of required CI because they can be slow or inconclusive. Run them manually before risky releases: `npm run e2e -- --timeout-ms 300000`, `npm run e2e:workflow-features`, `npm run e2e:prompt-routing` when prompt or routing guidance changes, `npm run e2e:duplicate-messages` when foreground/background message behavior changes, `npm run e2e:background-idle` when background waiting guidance changes, and `npm run e2e:session-key-resume -- --backend all` when session continuation changes.
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

## E2E Evidence

Interactive tmux TUI runs use `deepseek/deepseek-v4-flash` with high thinking and isolated `--no-*` resource flags.

- `background-ui`: validated immediate accepted receipts, independent root turns, and correlated terminal notifications in an interactive tmux run.
- `activity-widget`: a real Pi 0.83.0 TUI run with DeepSeek launched four subagent tasks and two workflow tasks. The active widget stayed within five lines, removed each completed task's detail immediately, updated cumulative child usage while other tasks remained active, and collapsed to one idle line. A real RPC run emitted matching `setWidget` active/idle payloads with `belowEditor` placement, one terminal notification, and no stderr.
- `task-ui`: a real Pi 0.83.0 TUI run with `openai-codex/gpt-5.6-luna` validated `Pi Agent(profile: label) accepted/completed task_id` and `Workflow(name) accepted/completed task_id` across live background execution and terminal notifications.
- `width`: previously validated eight parallel foreground delegations under the old contract.
- `proactive-multirepo-v3`: validated two-repo parallel run_agent fan-out under the previous routing contract.
- `proactive-fanout-v3`: validated three-lane TODO/FIXME/skipped-test run_agent fan-out under the previous routing contract.
- `proactive-migration-v2`: validated second-opinion run_agent delegation under the previous routing contract.
- `max-concurrent-queue`: validates `--max-concurrent-subagents 1` with two parallel normal `run_agent` calls; both completed (`FIRST_OK`, `SECOND_OK`) and no max-concurrency rejection was emitted.

Root-direct handling of narrow or small fixtures is intentional: the coordinator prompt explicitly permits staying in the root when delegation adds no value.

### Prompt routing behavior (current contract)

The appended PiFlow prompt owns shared lifecycle semantics, the ad-hoc workflow authoring guide and example, and the complete effective subagent and saved-workflow rosters. `run_agent` and `run_workflow` tool descriptions explain their distinct selection boundaries in one to three sentences. Their concise `promptSnippet` values provide active-tool discovery, `promptGuidelines` hold tool-specific behavior, and parameter descriptions remain field-specific. The prompt intentionally avoids wait, polling, and end-turn narration instructions.

`scripts/e2e/prompt-routing.mjs` is an observation-only real-model driver pinned to `openai-codex/gpt-5.6-luna` with `xhigh` thinking. It records routing, continuation, workflow shape, usage, timing, and fixture changes across scenarios without behavioral PASS/FAIL assertions; only harness or process failures make the command fail. Deterministic tests cover roster injection, tool-schema shape, run_agent execution, and session continuation without asserting explanatory prompt wording; review that prose directly and use observational E2E for model behavior.

### Duplicate-message observation E2E

`scripts/e2e/duplicate-messages.mjs` preserves the real RPC scenario that exposed identical foreground text blocks while PiFlow subagents were active. It pins the foreground to `openai-codex/gpt-5.6-sol` with `xhigh` thinking, uses delayed Pi-backed `openai-codex/gpt-5.6-luna` expert children, and records text-block phases, multi-block responses, exact duplicates, notification timing, delegation counts, and foreground reads. Duplicate and multi-block observations never affect exit status; process failures, timeouts, and incomplete accepted-task delivery do.

### Background-idle behavior E2E

`scripts/e2e/background-idle.mjs` runs a real RPC session in a temporary working directory with foreground Bash enabled and one deliberately delayed Pi-backed child. The user prompt specifies the delegated task but no waiting strategy. The command fails if the foreground invokes Bash between task acceptance and its terminal notification, if lifecycle correlation is incomplete, or if the final response omits the delegated result.

### run_workflow tool (v2)

A real `pi -p --mode json` matrix with `openai-codex/gpt-5.6-luna` (high thinking) validated all nine workflow-feature scenarios under the background contract. Every accepted Workflow task correlated with one terminal notification, print mode drained before exit, task journals used the same task IDs, replay worked through `resume_from_task_id`, and parallel, pipeline, structured output, branching, routing, queueing, determinism rejection, saved workflows, and schema discoverability all passed. A separate real Pi-backend session-key E2E proved that an omitted first-call key is generated, returned, reused on the second call, and correlated across both terminal notifications.

### Basic metrics semi-E2E

The direct-harness matrix in `scripts/e2e/basic-metrics.mjs` replaces the old Claude Code versus pi-flow delegation comparison and the duplicate single-backend smoke drivers. It runs one read-only fixture through each requested harness/model pair at medium thinking, feeds the real JSONL through pi-flow's production telemetry parsers/formatter, and reports per-row process, completion, model, tool, result, usage, token, CH, cost, and display checks. Unknown upstream pricing is a warning; missing usage/token/CH/display telemetry or missing locally estimated Codex cost is a failure. Failed runs retain raw artifacts automatically.

Real filtered runs on 2026-07-10 covered all five rows successfully: Claude Code 2.1.206 via DeepSeek `deepseek-v4-flash[1m]` (`↑19k ↓201 R19k CH49.8% $0.112`), Codex CLI 0.145.0-alpha.2 with `gpt-5.5` (`↑4.8k ↓115 R22k CH81.9% $0.010`) and `gpt-5.6-luna` (`↑17k ↓129 R7.9k CH32.1% $0.018`), and installed Pi 0.80.6 with `openai-codex/gpt-5.5` (`↑1.3k ↓40 CH0.0% $0.008`) and `openai-codex/gpt-5.6-luna` (`↑1.3k ↓53 CH0.0% $0.002`). All rows completed, used the read tool, returned the fixture token, exposed valid usage/tokens/CH, and exposed valid reported or estimated cost.
