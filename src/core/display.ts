import type { SubagentBackend } from "../types.ts";

export function getBackendSubagentLabel(backend: SubagentBackend | undefined): string {
  if (backend === "pi") {
    return "Pi Subagent";
  }
  if (backend === "codex") {
    return "Codex Subagent";
  }
  if (backend === "claude") {
    return "Claude Subagent";
  }
  return "Subagent";
}
