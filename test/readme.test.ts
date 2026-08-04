import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCustomSubagentProfiles } from "../src/profiles.ts";

const root = resolve(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  files: string[];
  pi: { extensions: string[]; image?: string };
};

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("README", () => {
  it("documents the approved package contents and repository screenshot", () => {
    expect(packageJson.files).toContain("assets");
    expect(packageJson.files).not.toContain("docs");
    expect(packageJson.pi).not.toHaveProperty("image");
    expect(readme).toContain(`pi install npm:${packageJson.name}`);
    expect(readme).not.toContain("—");

    const localTargets = [...readme.matchAll(/\((\.\/[^)#\s]+)(?:#[^)]+)?\)/g)]
      .map((match) => match[1]);
    expect(localTargets).toEqual([
      "./LICENSE",
      "./assets/pi-flow-interactive.png",
      "./LICENSE",
    ]);
    for (const target of localTargets) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }

    const imagePath = join(root, "assets/pi-flow-interactive.png");
    const image = readFileSync(imagePath);
    expect(image.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect(image.readUInt32BE(16)).toBe(1200);
    expect(image.readUInt32BE(20)).toBe(1040);
    expect(image.toString("latin1")).not.toMatch(/(?:tEXt|zTXt|iTXt)/);
  });

  it("states the asynchronous lifecycle immediately after the sanitized screenshot caption", () => {
    const screenshot = readme.indexOf("./assets/pi-flow-interactive.png");
    const caption = readme.indexOf("Captured from a real Pi interactive session", screenshot);
    const lifecycleHeading = readme.indexOf("## One coordinator, asynchronous specialists", caption);
    const lifecycle = readme.indexOf("`run_agent` and `run_workflow` run as background tasks", lifecycleHeading);
    const table = readme.indexOf("| Primitive | Use it for |", lifecycle);

    expect(screenshot).toBeGreaterThan(-1);
    expect(caption).toBeGreaterThan(screenshot);
    expect(lifecycleHeading).toBeGreaterThan(caption);
    expect(lifecycle).toBeGreaterThan(lifecycleHeading);
    expect(table).toBeGreaterThan(lifecycle);
    expect(readme.slice(lifecycle, table)).toContain("`accepted` result immediately");
    expect(readme.slice(lifecycle, table)).toContain("continues independent work");
    expect(readme.slice(lifecycle, table)).toContain("one correlated `completed` or `failed` notification");
    expect(readme.slice(lifecycle, table)).toContain("`accepted` means launched, not finished");
    expect(readme.slice(lifecycle, table)).toContain("nothing to poll");
    expect(readme).not.toMatch(/^## (?:Headless execution|Define your agent team|Use a focused subagent|Choose run_agent or run_workflow by task shape|Built for real work)$/m);
  });

  it("keeps installation, two natural-language examples, and valid custom profiles together", () => {
    const gettingStarted = readme.slice(
      readme.indexOf("## Get started in 30 seconds"),
      readme.indexOf("## Why pi-flow?"),
    );
    const naturalLanguageExamples = [...gettingStarted.matchAll(/```text\n([\s\S]*?)\n```/g)];
    const profileExamples = [...gettingStarted.matchAll(/```md\n([\s\S]*?)\n```/g)];

    expect(naturalLanguageExamples).toHaveLength(2);
    expect(profileExamples).toHaveLength(3);

    const agentDir = mkdtempSync(join(tmpdir(), "pi-flow-readme-"));
    tempDirs.push(agentDir);
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir);
    for (const [index, match] of profileExamples.entries()) {
      writeFileSync(join(subagentsDir, `${["pi-explorer", "codex-reviewer", "claude-ui-reviewer"][index]}.md`), match[1]);
    }

    const profiles = loadCustomSubagentProfiles(agentDir);
    expect(profiles.get("pi-explorer")).toMatchObject({
      backend: "pi",
      tools: ["read", "grep", "find", "ls"],
      systemPrompt: "Map the repository and return the important paths.",
    });
    expect(profiles.get("codex-reviewer")).toMatchObject({
      backend: "codex",
      systemPrompt: "Review the current diff and lead with concrete findings.",
    });
    expect(profiles.get("claude-ui-reviewer")).toMatchObject({
      backend: "claude",
      systemPrompt: "Inspect the UI and recommend specific improvements.",
    });
  });
});
