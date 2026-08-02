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

## pi-flow Agent contract (v1)

- This repo implements a lightweight pi extension named `pi-flow`, not a fork of `refs/pi-subagents`.
- The registered tool is `Agent`. v2 adds an opt-in `workflow` tool (see "pi-flow workflows (v2)" below); the v1 contract here still governs the `Agent` tool.
- Tool parameters follow the Claude Code-style shape: `description`, `prompt`, optional `subagent_type`, and optional `session_key` for an explicitly resumable child conversation.
- `description` is UI/routing metadata. `prompt` is the full subagent task.
- The only V1 built-in profile is `general-purpose`. There are no built-in aliases.
- `subagent_type` defaults to `general-purpose`.
- `general-purpose` adds no role prompt.
- Do not replace pi's base system prompt in v1.
- V1 is foreground-only. Do not add background execution, result polling, steering, scheduling, per-call model override, or per-call thinking override. Session continuation is explicit and foreground-only via caller-chosen `session_key`.
- Tool calls still only accept `description`, `prompt`, optional `subagent_type`, and optional `session_key`; backend/model/thinking selection is profile-based.
- Subagent timeout is a global operator-facing guardrail (`subagentTimeoutMs` / `--subagent-timeout-ms`), not a per-call Agent or workflow `agent()` parameter. The runtime timeout is owned by `spawnSubagent` after callers acquire a concurrency slot, so queue time does not count against it.
- Subagents start with a fresh one-shot conversation and the same working directory when `session_key` is omitted. Parent conversation messages and tool results are not inherited. Passing the same caller-chosen `session_key` creates/continues that child backend conversation instead. The extension maps `session_key` to the backend-native session/thread id internally and persists the direct-Agent mapping as parent-session custom state.
- Pi-backed subagents inherit the caller's current model and thinking level unless a custom profile pins `model` or `thinking`.
- Custom profiles may set `backend: pi` (default), `backend: codex`, or `backend: claude`. Codex-backed profiles run external `codex exec --json --dangerously-bypass-approvals-and-sandbox --ephemeral -- -` for one-shot calls, omit `--ephemeral` for keyed first calls, and use `codex exec resume --json ... <session_id> -` for keyed continuation; they send the task prompt on stdin, pass the profile body as `developer_instructions`, pass profile `model`/`thinking` through Codex CLI, parse `thread.started.thread_id`, token usage from Codex JSONL events, and estimate cost for listed models. Claude-backed profiles run external `claude -p --output-format stream-json --verbose --dangerously-skip-permissions --no-session-persistence` for one-shot calls, omit `--no-session-persistence` for keyed first calls, add `--resume <session_id>` for keyed continuation, send the task prompt on stdin, pass the profile body as `--append-system-prompt`, pass profile `model`/`thinking` through Claude Code, parse `system/init.session_id`, parse token usage from stream JSON, and use Claude Code's reported `total_cost_usd` when available. External CLI backends intentionally run in yolo/no-approval mode; only use them in trusted repositories.
- `tools` frontmatter is a pi-backend child-session allowlist only. External CLI profiles use their CLI's own tool and permission surface.
- There is no pi-flow permissions system in v1. Profiles are ordinary agents with optional prompts and tool allow-lists; external backends are explicit user dependencies.
- Pi-backed child sessions cannot launch other pi subagents. Do not give pi child sessions the `Agent` or `workflow` tool, or the flow prompt (`buildFlowPrompt`).
- External CLI backends are not given pi `Agent`/`workflow` tools, but their own CLIs may expose nested/delegation features; do not try to block that from this extension.
- Parallel delegation is allowed and bounded by a global `maxConcurrentSubagents` limit (default `12`), which caps how many subagents run concurrently across the whole agent run. A slot is taken on launch and released on completion/failure/abort. In v2 this same cap is shared with the `workflow` tool.
- Do not put exact concurrency values in model-facing text. The Agent tool description states that parallel delegation is bounded and queued; the concise coordinator prompt remains routing-only.
- Users can override the limit with the pi extension flag `--max-concurrent-subagents <n>`; embedded extension setups can set the default with `createFlowExtension({ maxConcurrentSubagents })` (compatibility alias: `createSubagentExtension`).
- Custom subagent profiles are supported from `~/.pi/agent/subagents/*.md`; the only built-in is `general-purpose`. A user can define a custom profile named `explorer`, but it is not bundled.

## pi-flow workflows (v2)

- Adds a second registered tool, `workflow`, alongside `Agent`: one product, two entry points. Built on the same spawn core, not a reimplementation of `refs/pi-dynamic-workflows`.
- Opt-in via `createFlowExtension({ workflow })` (compatibility alias: `createSubagentExtension`); defaults to `true`. Set `false` for a subagents-only runtime surface. The coordinator prompt deliberately does not branch on active/registered tool subsets; its static wording says "when available" for both entry points.
- The `workflow` tool runs a trusted, model-written JavaScript script in an isolated Worker-hosted `node:vm` context so pi can detect stalls and abort unresponsive scripts. Initial synchronous execution is bounded (5s by default), and post-`await` event-loop stalls are caught by a heartbeat watchdog. This is not a security sandbox; saved workflows are trusted code like extensions, and inline workflows are model-written code executed by the local process. Globals: `agent(prompt, opts)`, `parallel(thunks)`, `pipeline(items, ...stages)`, `phase(title)`, `log(message)`, `args`, `cwd`. The script must start with `export const meta = { name, description }` (a plain literal) and call `agent()` at least once.
- Determinism is a cooperative parse-time lint via an `acorn` AST scan: Date APIs and `Math.random()` uses, including simple aliases/destructuring, are rejected for normal model-written scripts. Dynamic authoring, deterministic-by-convention execution. The scan checks determinism ONLY — it intentionally permits ordinary computed member access (`obj[key]`, `arr[i]`, `{ [k]: v }`) except static `Math['random']`, and does not attempt vm-escape hardening. Do not claim malicious JavaScript is sandboxed.
- `agent()` reuses the shared spawn core, so a `subagent_type` selects a real profile and the subagent gets that profile's configured backend, model, thinking level, prompt, optional `session_key`, and (for pi-backed profiles only) tool allow-list — not stubbed guidance. `agent({ schema })` requires a portable strict JSON Schema: every object must have `additionalProperties: false` and list all its properties in `required`; optional values use nullable types. Static schemas (inline object literals and top-level `const` references) are validated at script parse time before any subagent starts; dynamic options are validated at runtime before the requested agent launches. On a valid schema the subagent is forced to return one validated object: pi-backed subagents receive a terminating `structured_output` tool via `createAgentSession`'s `customTools` with the profile tool allow-list extended to admit it, while Codex-backed subagents use Codex CLI `--output-schema` and Claude-backed subagents use Claude Code `--json-schema`. The first successful structured result is captured; duplicate successful calls are ignored.
- Concurrency is the SAME global cap as `Agent`: both tools share one `ConcurrencyLimiter`. Normal `Agent` calls and workflow `agent()` calls both queue and drain via `acquire`; the cap limits simultaneously running subagents, not total requested subagents. The `workflow` tool itself does not consume a slot; only its `agent()` calls do. A workflow also has hard caps on total `agent()` calls, retained logs, and orchestration-worker memory (512MB old generation by default; subagent/tool subprocess memory is not included).
- Foreground-only still holds: the `workflow` tool blocks until the script completes. No background execution, polling, steering, or scheduling — orchestration is front-loaded into the script, not a reactive coordinator. V3 adds foreground resume-by-replay using a run journal. Per-call model/thinking *override* remains out of contract; profile-based selection via `subagent_type` is the supported path.
- Nesting is hard-blocked for pi-backed workflow subagents: they get neither `Agent` nor `workflow`. External CLI backends use their own tool surface; this extension does not try to prevent nested/delegation features inside those CLIs.
- Do not put exact concurrency values in model-facing workflow text; the workflow tool description may state that fan-out is bounded and queued.
- Architecture: `src/core/{spawn,concurrency,model,progress,stream}.ts` is the shared core; `src/workflow/{runtime,tool,structured-output,output-schema}.ts` is the workflow layer; `src/pi-subagent.ts` wires both tools and shares one limiter. Adds an `acorn` dependency (the only runtime dependency).
- The throttled progress-emit + heartbeat machinery lives ONCE in `progress.ts` as `createProgressEmitter` and is shared by all three backends (`spawn.ts` pi, `codex.ts`, `claude.ts`); do not re-inline per-backend copies. The queued→running and abort emit timing is owned by that emitter.
- External-CLI backends bound parent-side child output via `createBoundedBuffer` (`stream.ts`): stderr is capped (`MAX_STDERR_CHARS`) and a single newline-free stdout line over `MAX_STDOUT_LINE_CHARS` aborts/fails the run clearly, so one runaway subagent cannot OOM the host pi process. A clean exit (code 0) with usable final text but no recognized terminal event is accepted rather than failed, so a CLI stream-format change does not turn good runs into failures.

## Headless workflow execution

- `@kky42/pi-flow/runtime` remains the lightweight plain-Node orchestration engine: callers provide `runAgent`, and the export must not gain runtime dependencies on Pi peer packages.
- `@kky42/pi-flow/headless` is the batteries-included programmatic executor for schedulers and services. It loads current profiles and reuses the same canonical profile/model/thinking/backend/tools/session-key/structured-output spawn path as the interactive `workflow` tool, without requiring an `ExtensionContext` or TUI.
- The shared profile-aware runner lives in `src/workflow/agent-runner.ts`; do not reimplement that behavior in headless consumers. Headless callers may restrict allowed backends as an execution policy and receive cumulative usage callbacks.

## Saved workflows (v3)

- The `workflow` tool now accepts exactly one source: inline `script` for ad-hoc orchestration, `name` for a saved workflow, or `scriptPath` for a persisted script. `args` is still exposed to the script as the `args` global.
- Saved workflow files are plain JavaScript under `~/.pi/agent/workflows/*.js` (global) and trusted `.pi/workflows/*.js` (project-local). There is no per-workflow slash command surface; the agent discovers saved workflows from the prompt roster and invokes `workflow({ name, args })` from natural language.
- Project workflows are loaded only when `ctx.isProjectTrusted()` is true. Saved files are realpath-checked to stay inside an allowed workflow root, must end in `.js`, and are parsed with the same `export const meta = { name, description }` plus determinism-lint and schema-preflight validators before every run. Never auto-run on discovery.
- Workflow identity is `meta.name`; valid saved names match lowercase letters/digits plus `_` or `-`. Project workflows override global workflows with the same name.
- The root prompt includes the complete effective saved-workflow roster (`name`, `description`) with no count or description truncation and shows an explicit empty roster when none exist. Put both summary and “when to use” routing guidance in `description`; do not include script bodies in the prompt.
- Inline workflow runs auto-persist their script under the current persisted session's workflow directory and return `scriptPath`, `runId`, and `journalPath` in tool details. In-memory sessions may run without persistence.
- Resume uses `workflow({ scriptPath, resumeFromRunId, args })`: the runtime replays the script and returns cached results for the longest unchanged prefix of `agent()` calls using a JSONL run journal. The first fingerprint mismatch and everything after it runs live. Cached fingerprints include prompt, label, phase, `subagent_type`, `session_key` when present, and schema; the journal also stores backend-native ids so later live calls can continue keyed sessions after cached prefix replay.
- No background execution, dynamic command registration, nested workflow calls, model override, or worktree isolation in v3.

## CI and release workflow

- CI lives in `.github/workflows/ci.yml` and runs on pull requests plus pushes to `main`. It installs with `npm ci` and runs `npm run check` on Node 22.x and 24.x.
- E2E scripts are intentionally not part of required CI because they use real models and can be slow or inconclusive. Run them manually before risky releases: `npm run e2e -- --timeout-ms 300000`, `npm run e2e:workflow-features`, `npm run e2e:prompt-routing` when prompt or routing guidance changes, and `npm run e2e:session-key-resume -- --backend all` when session continuation changes.
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
- `refs/claude-code-system-prompts` for Agent tool guidance and built-in agent prompts.
- Official Claude Code subagent docs: https://code.claude.com/docs/en/sub-agents

## E2E Evidence

Interactive tmux TUI runs use `deepseek/deepseek-v4-flash` with high thinking and isolated `--no-*` resource flags.

- `width`: validates eight parallel foreground delegations.
- `proactive-multirepo-v3`: validated two-repo parallel Agent fan-out under the previous routing contract.
- `proactive-fanout-v3`: validated three-lane TODO/FIXME/skipped-test Agent fan-out under the previous routing contract.
- `proactive-migration-v2`: validated second-opinion Agent delegation under the previous routing contract.
- `max-concurrent-queue`: validates `--max-concurrent-subagents 1` with two parallel normal `Agent` calls; both completed (`FIRST_OK`, `SECOND_OK`) and no max-concurrency rejection was emitted.

Root-direct handling of narrow or small fixtures is intentional: the coordinator prompt explicitly permits staying in the root when delegation adds no value.

### Prompt routing behavior (current contract)

The appended PiFlow coordinator prompt stays concise: it keeps narrow local work in the root when delegation adds no value, explains that fresh subagents have independent context, suggests Agent for independent parallel work or context-heavy exploration whose intermediate context is disposable, briefly identifies session-key continuation, suggests workflow for complex multi-agent orchestration, and tells the root to synthesize rather than repeat completed delegated work. It always includes the complete effective subagent and saved-workflow rosters without count or description truncation, and it does not branch on the active tool subset. Exact invocation, workflow authoring, replay, and schema rules live in the Agent and workflow tool descriptions and parameter schemas instead of being duplicated in the coordinator prompt. Agent and workflow each retain a concise `promptSnippet` so Pi's normal active-tool `Available tools` section can discover them; cross-tool routing remains in the coordinator instead of `promptGuidelines`.

`scripts/e2e/prompt-routing.mjs` is an observation-only real-model driver pinned to `openai-codex/gpt-5.6-luna` with `xhigh` thinking. It records routing, continuation, workflow shape, usage, timing, and fixture changes across scenarios without behavioral PASS/FAIL assertions; only harness or process failures make the command fail. `scripts/e2e/prompt-routing-evidence.md` documents that protocol. Deterministic tests cover prompt injection and roster behavior, tool-schema shape, Agent execution, and session continuation. They do not duplicate explanatory prompt or schema prose in string assertions; review that prose directly and use observational E2E for model behavior.

### Workflow tool (v2)

A headless `pi -p` run with `deepseek/deepseek-v4-flash` (high thinking) on a tiny fixture validated the end-to-end workflow path: the model reached for the `workflow` tool (root toolCalls `{bash:2, read:5, workflow:1}`, zero `Agent`), wrote a valid deterministic script (`export const meta`, `parallel([() => agent(prompt, { label, subagent_type })])`, synthesized `return`), fanned out three real subagents through the shared spawn core, and the tool returned `status: completed, agentCount: 3` with all agents `done`. Structured output, abort propagation, and limiter queueing are covered by unit/faux-integration tests rather than this run. Manual interactive validation is acceptable for the workflow tool.

### Basic metrics semi-E2E

The direct-harness matrix in `scripts/e2e/basic-metrics.mjs` replaces the old Claude Code versus pi-flow delegation comparison and the duplicate single-backend smoke drivers. It runs one read-only fixture through each requested harness/model pair at medium thinking, feeds the real JSONL through pi-flow's production telemetry parsers/formatter, and reports per-row process, completion, model, tool, result, usage, token, CH, cost, and display checks. Unknown upstream pricing is a warning; missing usage/token/CH/display telemetry or missing locally estimated Codex cost is a failure. Failed runs retain raw artifacts automatically.

Real filtered runs on 2026-07-10 covered all five rows successfully: Claude Code 2.1.206 via DeepSeek `deepseek-v4-flash[1m]` (`↑19k ↓201 R19k CH49.8% $0.112`), Codex CLI 0.145.0-alpha.2 with `gpt-5.5` (`↑4.8k ↓115 R22k CH81.9% $0.010`) and `gpt-5.6-luna` (`↑17k ↓129 R7.9k CH32.1% $0.018`), and installed Pi 0.80.6 with `openai-codex/gpt-5.5` (`↑1.3k ↓40 CH0.0% $0.008`) and `openai-codex/gpt-5.6-luna` (`↑1.3k ↓53 CH0.0% $0.002`). All rows completed, used the read tool, returned the fixture token, exposed valid usage/tokens/CH, and exposed valid reported or estimated cost.
