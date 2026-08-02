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

Handle narrow local work directly when delegation adds no value. Fresh subagents have independent context. When Agent is available, prefer it for independent parallel work or context-heavy exploration whose intermediate context can be discarded. Reuse \`session_key\` only when later work should continue the same child.

When workflow is available, prefer it for a matching registered workflow or complex multi-agent coordination, including dependent stages, structured decisions, replay, or larger fan-out. Synthesize returned results instead of repeating completed work.

Registered subagents:
${formatAvailableAgents(profiles)}

Registered workflows:
${formatSavedWorkflows(savedWorkflows)}`;
}
