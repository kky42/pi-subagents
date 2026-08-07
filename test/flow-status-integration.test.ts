import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { setupPiSubagentTestHarness } from "./helpers/pi-subagent-harness.ts";

type Widget = { key: string; content: unknown; placement: string | undefined };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await delay(5);
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("pi-flow bottom status widget", () => {
  const {
    disposeSession,
    createSession,
    setContextRoutingResponses,
    makeExecutionContext,
    makeMockTheme,
    renderToText,
  } = setupPiSubagentTestHarness();

  function widgetTexts(widgets: Widget[]): string[] {
    return widgets.map((widget) => {
      if (typeof widget.content === "function") {
        return renderToText(
          (widget.content as (tui: unknown, theme: Theme) => { render: (width: number) => string[] })(null, makeMockTheme()),
        ).trimEnd();
      }
      return (widget.content as string[] | undefined)?.join("\n") ?? "";
    });
  }

  it("publishes only the cumulative usage line after a direct subagent completes", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const widgets: Widget[] = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      tui: true,
      onWidget: (key, lines, placement) => widgets.push({ key, content: lines, placement }),
    });
    const childGate = deferred();
    setContextRoutingResponses(registration, async () => {
      await childGate.promise;
      return fauxAssistantMessage("widget child done");
    });
    const tool = session.getToolDefinition("run_agent") as any;
    const pending = tool.execute(
      "widget-agent-call",
      { label: "Widget child", prompt: "Wait for release." },
      undefined,
      () => {},
      context,
    );

    childGate.resolve();
    await pending;

    const summary = widgetTexts(widgets).find((text) => text.startsWith("pi-flow "))!;
    expect(summary).toContain("↑");
    expect(summary).not.toMatch(/agent|workflow|idle|active|done|queued/);
    expect(widgets.every((widget) => widget.key === "pi-flow")).toBe(true);
    disposeSession(session);
  });

  it("publishes only the cumulative usage line after a workflow completes", async () => {
    const { session, registration, model, modelRegistry } = await createSession();
    const widgets: Widget[] = [];
    const context = makeExecutionContext({
      hasUI: true,
      model,
      modelRegistry,
      tui: true,
      onWidget: (key, lines, placement) => widgets.push({ key, content: lines, placement }),
    });
    const childGate = deferred();
    setContextRoutingResponses(registration, async () => {
      await childGate.promise;
      return fauxAssistantMessage("widget workflow child done");
    });
    const script = `export const meta = { name: 'widget_flow', description: 'check the bottom widget' };\nreturn await run_agent('analyze', { label: 'wf-child' });`;
    const tool = session.getToolDefinition("run_workflow") as any;
    const pending = tool.execute(
      "widget-workflow-call",
      { name: "widget_flow", script },
      undefined,
      () => {},
      context,
    );

    childGate.resolve();
    await pending;

    const summary = widgetTexts(widgets).find((text) => text.startsWith("pi-flow "))!;
    expect(summary).toContain("↑");
    expect(summary).not.toMatch(/agent|workflow|idle|active|done|queued/);
    disposeSession(session);
  });
});
