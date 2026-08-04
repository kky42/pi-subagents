import type { SubagentBackend } from "../types.ts";

export interface AgentDisplayMetadata {
  backend: SubagentBackend | undefined;
  profile: string;
}

export function getBackendAgentLabel(backend: SubagentBackend | undefined): string {
  if (backend === "pi") {
    return "Pi Agent";
  }
  if (backend === "codex") {
    return "Codex Agent";
  }
  if (backend === "claude") {
    return "Claude Agent";
  }
  return "Agent";
}

export function getAgentDisplayDescriptor(profile: string, name: string): string {
  return name ? `${profile}: ${name}` : profile;
}

export function formatAgentDisplayLabel(metadata: AgentDisplayMetadata, name: string): string {
  return `${getBackendAgentLabel(metadata.backend)}(${getAgentDisplayDescriptor(metadata.profile, name)})`;
}
