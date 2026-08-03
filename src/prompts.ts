import type { SavedWorkflow } from "./workflow/registry.ts";
import type { SubagentProfile } from "./types.ts";

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

export function buildFlowPrompt(
  profiles: Map<string, SubagentProfile>,
  savedWorkflows: SavedWorkflow[],
): string {
  return `# PiFlow delegation

Handle narrow local work directly when delegation adds no value. Agent subagents and workflows both run in the background and automatically notify you when they complete or fail. Each launch returns an accepted task immediately; correlate its \`task_id\` with the later terminal notification. An accepted envelope is not completion: do not launch dependent work or placeholder tool calls until the matching terminal notification appears. If no independent work remains, end the current turn; Pi will start another when the notification arrives. Reuse an Agent's returned \`session_key\` when a follow-up should continue that child conversation.

When Agent is available, use it for independent parallel work or context-heavy exploration whose intermediate context can be discarded. When workflow is available, use it for a matching saved workflow or complex multi-agent coordination, including dependent stages, structured decisions, replay, or larger fan-out. Synthesize terminal task results instead of repeating them.

Registered subagents:
${formatAvailableAgents(profiles)}

Registered workflows:
${formatSavedWorkflows(savedWorkflows)}`;
}
