import type { SubagentProfile } from "./types.ts";
import type { SavedWorkflow } from "./workflow/registry.ts";

export const INLINE_WORKFLOW_EXAMPLE = `export const meta = {
  name: 'inspect_items',
  description: 'Inspect items in two turns',
  phases: [
    { title: 'inspect', detail: 'First-pass inspection' },
    { title: 'followup', detail: 'One-sentence follow-up advice' },
  ],
};
const replySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string' } },
};
const results = await pipeline(
  args?.items ?? ['src', 'test'],
  (item, _original, index) => run_agent('Inspect ' + item, {
    label: 'inspect-' + index,
    phase: 'inspect',
    profile: 'general-purpose',
    session_key: 'item-' + index,
    schema: replySchema,
  }),
  async (first, item, index) => {
    if (!first) return { item, first: null, followup: null };
    const followup = await run_agent('Continue with one-sentence advice.', {
      label: 'followup-' + index,
      phase: 'followup',
      profile: 'general-purpose',
      session_key: 'item-' + index,
      schema: replySchema,
    });
    return { item, first: first.text, followup: followup?.text ?? null };
  },
);
return { results };`;

function formatAvailableAgents(profiles: Map<string, SubagentProfile>): string {
  const lines = [...profiles.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((profile) => `- ${profile.name}: ${profile.description}`);
  return lines.length > 0 ? lines.join("\n") : "- (none)";
}

function formatSavedWorkflows(workflows: SavedWorkflow[]): string {
  const lines = workflows.map((workflow) => `- ${workflow.name}: ${workflow.description}`);
  return lines.length > 0 ? lines.join("\n") : "- (none)";
}

const WORKFLOW_AUTHORING_GUIDE = `## Workflow authoring

For ad-hoc workflow scripts:

- Start with the plain literal \`export const meta = { name: 'short_name', description: 'non-empty' }\`; its name must match the \`run_workflow\` tool's \`name\` parameter. Optional \`phases\` entries may contain \`title\`, \`detail\`, and \`model\`.
- Workflow-specific globals are \`run_agent(prompt, opts)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`phase(title)\`, \`log(message)\`, \`args\`, and \`cwd\`.
- Call \`run_agent()\` at least once, await or return every call, and return a JSON-serializable value.
- \`run_agent()\` options are \`label\`, \`phase\`, \`profile\`, \`session_key\`, and \`schema\`. The profile defaults to \`general-purpose\`; a reused workflow-local session key continues the same child conversation. Nonfatal failures resolve to \`null\`.
- \`phase\` values are exact string keys: a \`run_agent\` \`phase\` must exactly match a \`meta.phases\` \`title\` (or a prior \`phase(title)\` call) to join that phase; any other value renders as a separate phase row. \`phase(title)\` advances the current phase, and \`run_agent\` without \`phase\` joins the current phase.
- Pass thunk functions to \`parallel()\`, not promises. \`pipeline()\` preserves stage order per item while items run concurrently; stages receive \`(previousValue, originalItem, index)\`.
- Schemas must use a root object. Every object must set \`additionalProperties: false\` and list every property in \`required\`; represent optional values with nullable types. \`anyOf\` is supported, but \`oneOf\` and \`allOf\` are not. Static schemas are validated before any child starts; dynamic schemas are validated immediately before their call.
- Write plain JavaScript without imports, \`require\`, filesystem APIs, Date APIs, or \`Math.random()\`.

Example:

\`\`\`javascript
${INLINE_WORKFLOW_EXAMPLE}
\`\`\``;

export function buildFlowPrompt(
  profiles: Map<string, SubagentProfile>,
  savedWorkflows: SavedWorkflow[],
): string {
  return `# PiFlow delegation

${WORKFLOW_AUTHORING_GUIDE}

Registered subagents:
${formatAvailableAgents(profiles)}

Registered workflows:
${formatSavedWorkflows(savedWorkflows)}`;
}
