import type { SavedWorkflow } from "./workflow/registry.ts";
import type { SubagentProfile } from "./types.ts";

export const DIRECT_WORK_POLICY = "Narrow, local work can stay in the root when delegation adds no value.";
export const AGENT_USE_POLICY =
  "Use Agent for one focused delegated task or a small flat fan-out of independent work.";
export const WORKFLOW_USE_POLICY =
  "Use workflow for a saved workflow, dependent stages or control flow, structured results or branching, replay, or larger fan-out.";

export const AGENT_PROMPT_SNIPPET =
  "Delegate one focused task or a small flat fan-out; session_key continues one logical child stream.";

export const AGENT_PROMPT_GUIDELINES = [
  AGENT_USE_POLICY,
  "Reuse the same Agent session_key only for the same logical child stream. Omit it for independent work, including parallel branches.",
  "Give each fresh Agent call a self-contained task because it does not inherit parent messages, tool results, or reasoning.",
];

export const WORKFLOW_PROMPT_SNIPPET =
  "Run a saved or ad-hoc trusted workflow for staged, structured, replayable, or larger orchestration.";

export const WORKFLOW_PROMPT_GUIDELINES = [
  WORKFLOW_USE_POLICY,
  "Treat workflow scripts as trusted local code, not sandboxed input.",
];

export interface FlowPromptOptions {
  agentActive: boolean;
  workflowActive: boolean;
  savedWorkflows?: SavedWorkflow[];
}

function formatAvailableAgents(profiles: Map<string, SubagentProfile>): string {
  return [...profiles.values()]
    .map((profile) => `- ${profile.name}: ${profile.description}`)
    .join("\n");
}

function truncateWorkflowText(text: string, maxLength = 180): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function formatSavedWorkflows(workflows: SavedWorkflow[], maxItems = 20): string {
  if (workflows.length === 0) {
    return "";
  }
  const shown = workflows.slice(0, maxItems);
  const lines = shown.map((workflow) => `- ${workflow.name}: ${truncateWorkflowText(workflow.description)}`);
  if (workflows.length > shown.length) {
    lines.push(`- … ${workflows.length - shown.length} more saved workflow(s) not shown.`);
  }
  return `\n\nSaved workflows:\n${lines.join("\n")}`;
}

function buildAgentSection(): string {
  return `## Agent

Consider Agent for one focused task that can run independently or would keep substantial search output out of the root context. For a small flat fan-out, issue independent Agent calls in the same assistant response.

- Give each call a short description and a self-contained prompt. Select a \`subagent_type\` from the available-agent roster when its description fits.
- Omit \`session_key\` for a fresh one-shot child. Reuse the same caller-chosen key only to continue the same logical child stream; independent work, including parallel branches, stays fresh.
- Once a search is delegated, do not repeat the same search in the root. The child result is returned to you; relay the useful conclusion to the user.`;
}

function buildWorkflowSection(savedWorkflows: SavedWorkflow[]): string {
  return `## Workflow

Use workflow when the request matches a saved workflow or needs dependent stages, control flow, structured results or decisions, replay, or larger fan-out. After a workflow completes, synthesize its result instead of repeating completed branches through another delegation path.

Source:
- Provide exactly one of \`name\`, \`scriptPath\`, or raw \`script\`. Use \`resumeFromRunId\` with \`scriptPath\` to replay the longest unchanged prefix.
- Reusable \`.js\` files live in the global workflow directory or a trusted project's workflow directory. The filename need not match \`meta.name\`; \`meta.name\` is the saved-workflow identity and must match \`[a-z0-9][a-z0-9_-]*\`. Saved files are parsed before each run and never run on discovery.

Script contract:
- Start with the plain literal \`export const meta = { name: 'short_name', description: 'non-empty' }\` (optional \`phases\`), call \`agent()\` at least once, and return a JSON-serializable value.
- Globals are \`agent(prompt, opts)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`phase(title)\`, \`log(message)\`, \`args\`, and \`cwd\`.
- Write plain JavaScript without imports, filesystem APIs, Date APIs, or Math.random(). Scripts are trusted code; the determinism check is not a security sandbox.
- \`parallel()\` takes functions, not promises. Each \`pipeline(items, ...stages)\` stage receives \`(previousValue, originalItem, index)\`; stage order is preserved per item while different items progress concurrently. For dependent per-item work, use separate stages such as \`await pipeline(items, (item) => agent('classify ' + item, classifyOpts), (classification, item) => agent('follow up ' + item + ': ' + classification, followupOpts))\`.

Workflow agent calls:
- Options are \`label\`, \`phase\`, \`subagent_type\`, \`session_key\`, and \`schema\`. Give each call a unique short label. Reuse a session key only within the same logical child stream; independent branches omit it.
- A schema forces one validated object. Every object schema sets \`additionalProperties: false\`, lists every property in \`required\`, and represents optional values with nullable types.
- Prefer a schema literal or top-level const: statically visible schemas are preflighted before any child starts. A schema supplied through dynamic options is validated immediately before that child launches, so earlier calls may already have run.
- Failed branches resolve to \`null\` unless the workflow is aborted; handle nulls before synthesis.${formatSavedWorkflows(savedWorkflows)}`;
}

export function buildFlowPrompt(profiles: Map<string, SubagentProfile>, options: FlowPromptOptions): string {
  const routing = [
    DIRECT_WORK_POLICY,
    ...(options.agentActive ? [AGENT_USE_POLICY] : []),
    ...(options.workflowActive ? [WORKFLOW_USE_POLICY] : []),
  ];
  const sections = [
    `# Subagent Delegation

Available agents:
${formatAvailableAgents(profiles)}

Routing boundary:
${routing.map((policy) => `- ${policy}`).join("\n")}

Children start with fresh context unless a caller-chosen session key continues the same logical stream. Pi-backed children cannot invoke pi-flow delegation tools; external backends use their own tool surface. All fan-out is bounded and queued.`,
  ];

  if (options.agentActive) {
    sections.push(buildAgentSection());
  }
  if (options.workflowActive) {
    sections.push(buildWorkflowSection(options.savedWorkflows ?? []));
  }

  return sections.join("\n\n");
}
