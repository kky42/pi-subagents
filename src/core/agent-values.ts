export function normalizeAgentLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  return label || undefined;
}

export function normalizeAgentSubagentType(value: string | undefined): string | undefined {
  const subagentType = value?.trim();
  return subagentType || undefined;
}
