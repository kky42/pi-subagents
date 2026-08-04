export function normalizeSubagentLabel(value: string | undefined): string | undefined {
  const label = value?.trim();
  return label || undefined;
}

export function normalizeProfileName(value: string | undefined): string | undefined {
  const profile = value?.trim();
  return profile || undefined;
}
