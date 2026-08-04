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

export function getAgentDisplayDescriptor(profile: string, label: string): string {
  return label ? `${profile}: ${label}` : profile;
}

export function formatAgentDisplayLabel(metadata: AgentDisplayMetadata, label: string): string {
  return `${getBackendAgentLabel(metadata.backend)}(${getAgentDisplayDescriptor(metadata.profile, label)})`;
}
