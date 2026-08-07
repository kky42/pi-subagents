import { spawn, type ChildProcess } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProgressEmitter, textResult, type SubagentToolResult } from "./progress.ts";
import { createBoundedBuffer, MAX_STDERR_CHARS, MAX_STDOUT_LINE_CHARS } from "./stream.ts";
import type { SubagentProfile, SubagentTelemetry, SubagentUsage, ThinkingLevel } from "../types.ts";

const FORCE_KILL_DELAY_MS = 3000;

function hasChildExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChildTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below. This can happen if the process
      // exited between hasChildExited() and the process-group signal.
    }
  }
  child.kill(signal);
}

function abortChild(child: ChildProcess): void {
  if (hasChildExited(child)) {
    return;
  }
  signalChildTree(child, "SIGTERM");
  setTimeout(() => {
    if (!hasChildExited(child)) {
      signalChildTree(child, "SIGKILL");
    }
  }, FORCE_KILL_DELAY_MS).unref();
}

/** Mutable per-run state the backend-specific event handler updates from parsed CLI events. */
export interface CliSubagentRunState {
  setSessionId(sessionId: string): void;
  setResultText(text: string): void;
  setEventError(message: string): void;
  setDiagnosticError(message: string): void;
  addActivity(line: string): void;
  publishUsage(usage: SubagentUsage, telemetry: SubagentTelemetry): void;
}

export interface CliSubagentAdapter {
  command: string;
  buildArgs(taskPrompt: string): Promise<{ args: string[]; cleanup?: () => Promise<void> }>;
  isTerminalEvent(event: Record<string, unknown>): boolean;
  parseLine(line: string): Record<string, unknown> | undefined;
  extractSessionId(event: Record<string, unknown>): string | undefined;
  extractActivity(event: Record<string, unknown>): string | undefined;
  extractFinalText(event: Record<string, unknown>): string | undefined;
  handleEvent(event: Record<string, unknown>, state: CliSubagentRunState): void;
}

export async function spawnCliSubagent(params: {
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
  adapter: CliSubagentAdapter;
}): Promise<SubagentToolResult> {
  const { adapter } = params;
  const profile = params.profile.name;
  const taskPrompt = params.appendInstructions ? `${params.prompt}\n\n${params.appendInstructions}` : params.prompt;
  const emitter = createProgressEmitter({
    label: params.label,
    profile,
    backend: params.profile.backend,
    enabled: params.progressEnabled,
    onProgress: params.onProgress,
  });
  const progress = emitter.progress;
  let latestUsage: SubagentUsage | undefined;
  let latestTelemetry: SubagentTelemetry | undefined;
  let resultText = "";
  let sessionId = params.sessionId?.trim() || undefined;
  const stderrBuffer = createBoundedBuffer(MAX_STDERR_CHARS);
  let sawTerminalEvent = false;
  let eventError: string | undefined;
  let diagnosticError: string | undefined;
  let oversizeError: string | undefined;
  let child: ChildProcess | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  let abortHandler: (() => void) | undefined;

  const publishUsage = (usage: SubagentUsage, telemetry: SubagentTelemetry): void => {
    latestUsage = usage;
    latestTelemetry = telemetry;
    emitter.setUsage(usage, telemetry);
    params.onUsage(usage, telemetry);
    emitter.emitSoon();
  };
  const emitFinalUsage = (): void => {
    if (latestUsage && latestTelemetry) {
      params.onUsage(latestUsage, latestTelemetry);
    }
  };
  const state: CliSubagentRunState = {
    setSessionId: (id) => {
      sessionId = id;
    },
    setResultText: (text) => {
      resultText = text;
      if (text.trim()) {
        emitter.addActivity(text.split("\n").find((line) => line.trim()) ?? text);
        emitter.emitSoon();
      }
    },
    setEventError: (message) => {
      eventError ??= message;
    },
    setDiagnosticError: (message) => {
      diagnosticError ??= message;
    },
    addActivity: (line) => {
      emitter.addActivity(line);
      emitter.emitSoon();
    },
    publishUsage,
  };

  const handleEvent = (event: Record<string, unknown>): void => {
    if (adapter.isTerminalEvent(event)) {
      sawTerminalEvent = true;
    }
    const parsedSessionId = adapter.extractSessionId(event);
    if (params.persistSession === true && parsedSessionId) {
      state.setSessionId(parsedSessionId);
    }
    const activity = adapter.extractActivity(event);
    if (activity) {
      state.addActivity(activity);
    }
    const text = adapter.extractFinalText(event);
    if (text !== undefined) {
      state.setResultText(text);
    }
    adapter.handleEvent(event, state);
  };

  try {
    if (params.signal?.aborted) {
      throw new Error("Subagent aborted before prompt start");
    }

    const prepared = await adapter.buildArgs(taskPrompt);
    cleanup = prepared.cleanup;

    const proc = spawn(adapter.command, prepared.args, {
      cwd: params.ctx.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    child = proc;
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error(`${adapter.command} stdin/stdout/stderr pipes were not available`);
    }

    abortHandler = () => {
      abortChild(proc);
    };
    params.signal?.addEventListener("abort", abortHandler, { once: true });
    if (params.signal?.aborted) {
      abortChild(proc);
      throw new Error("Subagent aborted before prompt start");
    }

    let stdoutBuffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdin.on("error", () => {
      // If the CLI exits before reading stdin, the process close/error path below
      // reports the real failure. Avoid an unhandled EPIPE on the writable side.
    });

    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      if (stdoutBuffer.length > MAX_STDOUT_LINE_CHARS) {
        // A single newline-free line this large means the stream is unparseable.
        // Fail loudly instead of silently dropping what might be real output.
        oversizeError ??= `${adapter.command} emitted a stdout line over ${MAX_STDOUT_LINE_CHARS} chars without a newline; stream is unparseable`;
        stdoutBuffer = "";
        abortChild(proc);
        return;
      }
      for (const line of lines) {
        const event = adapter.parseLine(line);
        if (event) {
          handleEvent(event);
        }
      }
    });

    proc.stderr.on("data", (chunk) => {
      stderrBuffer.append(String(chunk));
    });

    emitter.emit();
    emitter.startHeartbeat();
    proc.stdin.end(taskPrompt);

    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("close", (code, signal) => {
        if (stdoutBuffer.trim()) {
          const event = adapter.parseLine(stdoutBuffer);
          if (event) {
            handleEvent(event);
          }
        }
        resolve({ code, signal });
      });
    });

    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
      abortHandler = undefined;
    }

    if (params.signal?.aborted) {
      throw new Error("Subagent aborted");
    }
    if (oversizeError) {
      throw new Error(oversizeError);
    }
    if (eventError) {
      throw new Error(eventError);
    }
    if (closeResult.code !== 0) {
      const stderr = stderrBuffer.text().trim();
      const diagnostic = diagnosticError ? `: ${diagnosticError}` : "";
      throw new Error(
        `${adapter.command} exited with code ${closeResult.code}${closeResult.signal ? ` (signal ${closeResult.signal})` : ""}${stderr ? `: ${stderr}` : diagnostic}`,
      );
    }
    if (!sawTerminalEvent && !resultText.trim()) {
      // Hard-fail only when the CLI produced nothing usable. If it exited cleanly
      // (code 0) with final text but no recognized terminal event, for example a CLI
      // stream-format change renamed the event, accept the output rather than
      // turning a good run into a failure.
      throw new Error(diagnosticError ?? `${adapter.command} exited without a terminal JSON event`);
    }

    if (params.persistSession && !sessionId) {
      throw new Error(`${adapter.command} completed without a resumable session ID`);
    }
    emitFinalUsage();
    const result = resultText.trim() || "(no final text output)";
    if (progress) {
      progress.status = "done";
      progress.result = result;
      progress.telemetry = latestTelemetry;
      progress.endedAt = Date.now();
    }
    return textResult(`Subagent "${params.label}" (${profile}) completed:\n\n${result}`, {
      label: params.label,
      profile,
      backend: params.profile.backend,
      status: "done",
      result,
      telemetry: latestTelemetry,
      ...(sessionId ? { sessionId } : {}),
      ...(progress ? { progress } : {}),
    }, latestUsage);
  } catch (error) {
    if (child && !hasChildExited(child)) {
      abortChild(child);
    }
    const message = error instanceof Error ? error.message : String(error);
    const status = params.signal?.aborted ? "aborted" : "error";
    emitFinalUsage();
    if (progress) {
      progress.status = status;
      progress.error = message;
      progress.telemetry = latestTelemetry;
      progress.endedAt = Date.now();
    }
    const verb = status === "aborted" ? "aborted" : "failed";
    return textResult(`Subagent "${params.label}" (${profile}) ${verb}: ${message}`, {
      label: params.label,
      profile,
      backend: params.profile.backend,
      status,
      error: message,
      telemetry: latestTelemetry,
      ...(sessionId ? { sessionId } : {}),
      ...(progress ? { progress } : {}),
    }, latestUsage);
  } finally {
    emitter.stop();
    if (abortHandler) {
      params.signal?.removeEventListener("abort", abortHandler);
    }
    await cleanup?.().catch(() => undefined);
  }
}
