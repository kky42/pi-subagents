import { calculateCost, type Model, type Usage } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { type SubagentToolResult } from "./progress.ts";
import { spawnCliSubagent, type CliSubagentRunState } from "./cli-spawn.ts";
import type { SubagentProfile, SubagentTelemetry, SubagentUsage, ThinkingLevel } from "../types.ts";

const CLAUDE_COMMAND = "claude";

export interface ClaudeTokenUsage {
  inputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  outputTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseModelReference(model: string | undefined): { provider?: string; modelId?: string } {
  const normalized = model?.trim();
  if (!normalized) {
    return { provider: undefined, modelId: undefined };
  }
  const separator = normalized.indexOf("/");
  return separator === -1
    ? { provider: undefined, modelId: normalized }
    : { provider: normalized.slice(0, separator), modelId: normalized.slice(separator + 1) };
}

// Anthropic usage buckets are disjoint; each is priced at its own rate.
function calculateClaudeCostUsd(pricingModel: Model<string>, usage: ClaudeTokenUsage): number {
  const input = Math.max(0, usage.inputTokens);
  const cacheRead = Math.max(0, usage.cacheReadInputTokens);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens);
  const output = Math.max(0, usage.outputTokens);
  const piUsage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  return calculateCost(pricingModel, piUsage).total;
}

const builtinClaudeModelLookup = getBuiltinModel as unknown as (
  provider: string,
  modelId: string,
) => Model<string> | undefined;

// Claude Code aliases ("haiku", "sonnet", ...) and third-party providers are not
// in Pi's model catalog, so the lookup just misses for those.
function resolveClaudeCostUsd(
  model: string | undefined,
  usage: ClaudeTokenUsage,
  modelRegistry: ModelRegistry | undefined,
): number | undefined {
  const { provider, modelId } = parseModelReference(model);
  if (!modelId) {
    return undefined;
  }
  const providers = provider && provider !== "anthropic" ? [provider, "anthropic"] : ["anthropic"];
  if (modelRegistry) {
    for (const candidate of providers) {
      const pricingModel = modelRegistry.find(candidate, modelId);
      if (pricingModel) {
        return calculateClaudeCostUsd(pricingModel, usage);
      }
    }
  }
  for (const candidate of providers) {
    const pricingModel = builtinClaudeModelLookup(candidate, modelId);
    if (pricingModel) {
      return calculateClaudeCostUsd(pricingModel, usage);
    }
  }
  return undefined;
}

export function buildClaudeArgs({
  profile,
  thinkingLevel,
  sessionId,
  persistSession = false,
  outputSchema,
}: {
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  sessionId?: string;
  persistSession?: boolean;
  outputSchema?: unknown;
}): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
  ];
  if (sessionId) {
    args.push("--resume", sessionId);
  } else if (!persistSession) {
    args.push("--no-session-persistence");
  }
  if (profile.systemPrompt) {
    args.push("--append-system-prompt", profile.systemPrompt);
  }
  if (profile.model) {
    args.push("--model", profile.model);
  }
  if (thinkingLevel) {
    args.push("--effort", thinkingLevel);
  }
  if (outputSchema !== undefined && outputSchema !== null) {
    args.push("--json-schema", JSON.stringify(outputSchema));
  }
  return args;
}

export function parseClaudeJsonLine(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function parseUsageRecord(value: unknown): ClaudeTokenUsage | undefined {
  const usage = asRecord(value);
  if (!usage) {
    return undefined;
  }
  const inputTokens = asFiniteNumber(usage.input_tokens);
  const cacheReadInputTokens = asFiniteNumber(usage.cache_read_input_tokens ?? 0);
  const cacheCreationInputTokens = asFiniteNumber(usage.cache_creation_input_tokens ?? 0);
  const outputTokens = asFiniteNumber(usage.output_tokens);
  if (
    inputTokens === undefined ||
    cacheReadInputTokens === undefined ||
    cacheCreationInputTokens === undefined ||
    outputTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, cacheReadInputTokens, cacheCreationInputTokens, outputTokens };
}

function parseModelUsage(value: unknown): ClaudeTokenUsage | undefined {
  const modelUsage = asRecord(value);
  if (!modelUsage) {
    return undefined;
  }
  const totals: ClaudeTokenUsage = {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
  let found = false;
  for (const item of Object.values(modelUsage)) {
    const usage = asRecord(item);
    if (!usage) {
      continue;
    }
    const inputTokens = asFiniteNumber(usage.inputTokens);
    const cacheReadInputTokens = asFiniteNumber(usage.cacheReadInputTokens ?? 0);
    const cacheCreationInputTokens = asFiniteNumber(usage.cacheCreationInputTokens ?? 0);
    const outputTokens = asFiniteNumber(usage.outputTokens);
    if (
      inputTokens === undefined ||
      cacheReadInputTokens === undefined ||
      cacheCreationInputTokens === undefined ||
      outputTokens === undefined
    ) {
      continue;
    }
    found = true;
    totals.inputTokens += inputTokens;
    totals.cacheReadInputTokens += cacheReadInputTokens;
    totals.cacheCreationInputTokens += cacheCreationInputTokens;
    totals.outputTokens += outputTokens;
  }
  return found ? totals : undefined;
}

function sumModelUsageCost(value: unknown): number | undefined {
  const modelUsage = asRecord(value);
  if (!modelUsage) {
    return undefined;
  }
  let total = 0;
  let found = false;
  for (const item of Object.values(modelUsage)) {
    const cost = asFiniteNumber(asRecord(item)?.costUSD);
    if (cost !== undefined) {
      found = true;
      total += cost;
    }
  }
  return found ? total : undefined;
}

export function extractClaudeSessionId(event: Record<string, unknown>): string | undefined {
  if (event.type !== "system" || event.subtype !== "init") {
    return undefined;
  }
  return typeof event.session_id === "string" && event.session_id.trim() !== "" ? event.session_id : undefined;
}

export function extractClaudeUsage(event: Record<string, unknown>): ClaudeTokenUsage | undefined {
  if (event.type === "result") {
    return parseModelUsage(event.modelUsage) ?? parseUsageRecord(event.usage);
  }
  if (event.type !== "assistant") {
    return undefined;
  }
  const message = asRecord(event.message);
  return message ? parseUsageRecord(message.usage) : undefined;
}

export function extractClaudeCostUsd(event: Record<string, unknown>): number | undefined {
  if (event.type !== "result") {
    return undefined;
  }
  return asFiniteNumber(event.total_cost_usd) ?? sumModelUsageCost(event.modelUsage);
}

export function claudeUsageToSubagentUsage(usage: ClaudeTokenUsage, costUsd: number | undefined): SubagentUsage {
  const input = Math.max(0, usage.inputTokens);
  const cacheRead = Math.max(0, usage.cacheReadInputTokens);
  const cacheWrite = Math.max(0, usage.cacheCreationInputTokens);
  const output = Math.max(0, usage.outputTokens);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costUsd ?? 0 },
  };
}

function textFromClaudeContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      const block = asRecord(part);
      return block?.type === "text" && typeof block.text === "string" ? block.text : undefined;
    })
    .filter((part): part is string => part !== undefined)
    .join("");
  return text ? text : undefined;
}

function structuredTextFromClaudeValue(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function extractClaudeFinalText(event: Record<string, unknown>): string | undefined {
  if (event.type === "result") {
    return (
      structuredTextFromClaudeValue(event.structured_output) ??
      (typeof event.result === "string" ? event.result : undefined)
    );
  }
  if (event.type !== "assistant") {
    return undefined;
  }
  const message = asRecord(event.message);
  return message ? textFromClaudeContent(message.content) : undefined;
}

export function extractClaudeError(event: Record<string, unknown>): string | undefined {
  if (event.type === "result" && event.is_error === true) {
    const errors = Array.isArray(event.errors) ? event.errors : [];
    const first = errors.find((candidate) => typeof candidate === "string");
    const result = typeof event.result === "string" && event.result.trim() ? event.result.trim() : undefined;
    const apiStatus = event.api_error_status !== undefined && event.api_error_status !== null
      ? `API error ${String(event.api_error_status)}`
      : undefined;
    return `Claude failed: ${first ?? result ?? apiStatus ?? (typeof event.subtype === "string" ? event.subtype : "turn failed")}`;
  }
  if (event.type === "error") {
    return `Claude error: ${typeof event.message === "string" ? event.message : "unknown error"}`;
  }
  return undefined;
}

function getPreviewFromRecord(record: Record<string, unknown>): string {
  const candidates = [
    record.command,
    record.cmd,
    record.file_path,
    record.path,
    record.pattern,
    record.query,
    record.prompt,
    record.description,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.replace(/\s+/g, " ").trim();
    }
  }
  const input = asRecord(record.input) ?? asRecord(record.arguments) ?? asRecord(record.args);
  return input ? getPreviewFromRecord(input) : "";
}

export function claudeActivityFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "system" && event.subtype === "init") {
    return "claude session started";
  }
  if (event.type === "result") {
    return "claude turn completed";
  }
  if (event.type === "assistant") {
    const message = asRecord(event.message);
    const content = message?.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const block = asRecord(part);
        if (block?.type === "tool_use") {
          const toolName = typeof block.name === "string" && block.name ? block.name : "tool_use";
          const preview = getPreviewFromRecord(block);
          return `${toolName}${preview ? ` ${preview}` : ""}`;
        }
      }
    }
  }
  const error = extractClaudeError(event);
  return error ? error : undefined;
}

function emptyTokenUsage(): ClaudeTokenUsage {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    outputTokens: 0,
  };
}

function addTokenUsage(total: ClaudeTokenUsage, increment: ClaudeTokenUsage): ClaudeTokenUsage {
  return {
    inputTokens: total.inputTokens + increment.inputTokens,
    cacheReadInputTokens: total.cacheReadInputTokens + increment.cacheReadInputTokens,
    cacheCreationInputTokens: total.cacheCreationInputTokens + increment.cacheCreationInputTokens,
    outputTokens: total.outputTokens + increment.outputTokens,
  };
}

export async function spawnClaudeSubagent(params: {
  label: string;
  prompt: string;
  profile: SubagentProfile;
  thinkingLevel: ThinkingLevel | undefined;
  ctx: ExtensionContext;
  signal: AbortSignal | undefined;
  progressEnabled: boolean;
  onProgress: ((result: SubagentToolResult) => void) | undefined;
  onUsage: (usage: SubagentUsage, telemetry: SubagentTelemetry) => void;
  appendInstructions?: string;
  sessionId?: string;
  persistSession?: boolean;
  outputSchema?: unknown;
}): Promise<SubagentToolResult> {
  let cumulativeAssistantUsage = emptyTokenUsage();
  let latestRawUsage = emptyTokenUsage();
  let tokensKnown = false;
  let latestCostUsd: number | undefined;

  const publishUsage = (state: CliSubagentRunState, usage: ClaudeTokenUsage | undefined, costUsd: number | undefined): void => {
    if (usage) {
      latestRawUsage = usage;
      tokensKnown = true;
    }
    const resolvedCostUsd = costUsd !== undefined
      ? costUsd
      : usage
        ? resolveClaudeCostUsd(params.profile.model, usage, params.ctx.modelRegistry)
        : undefined;
    if (resolvedCostUsd !== undefined) {
      latestCostUsd = resolvedCostUsd;
    }
    const latestUsage = claudeUsageToSubagentUsage(latestRawUsage, latestCostUsd);
    const hasBillableTokens = latestUsage.totalTokens > 0;
    state.publishUsage(latestUsage, {
      tokensKnown,
      costKnown: latestCostUsd !== undefined && (!hasBillableTokens || latestCostUsd > 0),
      costBreakdownKnown: false,
      costEstimated: costUsd === undefined && resolvedCostUsd !== undefined,
    });
  };

  return spawnCliSubagent({
    label: params.label,
    prompt: params.prompt,
    profile: params.profile,
    thinkingLevel: params.thinkingLevel,
    ctx: params.ctx,
    signal: params.signal,
    progressEnabled: params.progressEnabled,
    onProgress: params.onProgress,
    onUsage: params.onUsage,
    appendInstructions: params.appendInstructions,
    sessionId: params.sessionId,
    persistSession: params.persistSession,
    adapter: {
      command: CLAUDE_COMMAND,
      buildArgs: async () => ({
        args: buildClaudeArgs({
          profile: params.profile,
          thinkingLevel: params.thinkingLevel,
          sessionId: params.sessionId?.trim() || undefined,
          persistSession: params.persistSession === true,
          outputSchema: params.outputSchema,
        }),
      }),
      isTerminalEvent: (event) => event.type === "result" || event.type === "error",
      parseLine: parseClaudeJsonLine,
      extractSessionId: extractClaudeSessionId,
      extractActivity: claudeActivityFromEvent,
      extractFinalText: extractClaudeFinalText,
      handleEvent: (event, state: CliSubagentRunState) => {
        const extractedUsage = extractClaudeUsage(event);
        const usage = event.type === "assistant" && extractedUsage
          ? (cumulativeAssistantUsage = addTokenUsage(cumulativeAssistantUsage, extractedUsage))
          : extractedUsage;
        const cost = extractClaudeCostUsd(event);
        if (usage || cost !== undefined) {
          publishUsage(state, usage, cost);
        }
        const error = extractClaudeError(event);
        if (error) {
          state.setEventError(error);
        }
      },
    },
  });
}
