import type { SubagentProfile } from "./types.ts";
import { INLINE_WORKFLOW_EXAMPLE } from "./workflow/source.ts";
import type { SavedWorkflow } from "./workflow/registry.ts";

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

- Start with the plain literal \`export const meta = { name: 'short_name', description: 'non-empty' }\`. Optional \`phases\` entries may contain \`title\`, \`detail\`, and \`model\`.
- Workflow-specific globals are \`agent(prompt, opts)\`, \`parallel(thunks)\`, \`pipeline(items, ...stages)\`, \`phase(title)\`, \`log(message)\`, \`args\`, and \`cwd\`.
- Call \`agent()\` at least once, await or return every call, and return a JSON-serializable value.
- \`agent()\` options are \`label\`, \`phase\`, \`subagent_type\`, \`session_key\`, and \`schema\`. The profile defaults to \`general-purpose\`; a reused workflow-local session key continues the same child conversation. Nonfatal failures resolve to \`null\`.
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

\`Agent\` and \`workflow\` calls return an \`accepted\` task immediately and continue in the background; you receive one notification when each task completes or fails.

${WORKFLOW_AUTHORING_GUIDE}

Registered subagents:
${formatAvailableAgents(profiles)}

Registered workflows:
${formatSavedWorkflows(savedWorkflows)}`;
}
