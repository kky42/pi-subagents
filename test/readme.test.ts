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
  it("keeps package metadata and local documentation links valid", () => {
    expect(packageJson.files).toContain("assets");
    expect(packageJson.files).not.toContain("docs");
    expect(packageJson.pi).not.toHaveProperty("image");
    expect(readme).toContain("pi install npm:@kky42/pi-flow");
    expect(readme).not.toContain("—");

    const localTargets = [...readme.matchAll(/\((\.\/[^)#\s]+)(?:#[^)]+)?\)/g)]
      .map((match) => match[1]);
    expect(localTargets.length).toBeGreaterThan(0);
    for (const target of localTargets) {
      expect(existsSync(resolve(root, target))).toBe(true);
    }
  });

  it("keeps documented custom profile examples parseable", () => {
    const gettingStarted = readme.slice(
      readme.indexOf("## Try it"),
      readme.indexOf("## License"),
    );
    const profileExamples = [...gettingStarted.matchAll(/```md\n([\s\S]*?)\n```/g)];
    expect(profileExamples.length).toBeGreaterThan(0);

    const agentDir = mkdtempSync(join(tmpdir(), "pi-flow-readme-"));
    tempDirs.push(agentDir);
    const subagentsDir = join(agentDir, "subagents");
    mkdirSync(subagentsDir);
    for (const [index, match] of profileExamples.entries()) {
      writeFileSync(join(subagentsDir, `readme-profile-${index}.md`), match[1]);
    }

    const profiles = loadCustomSubagentProfiles(agentDir);
    expect(profiles.size).toBe(profileExamples.length);
    for (const profile of profiles.values()) {
      expect(profile.description.trim().length).toBeGreaterThan(0);
      expect(["pi", "codex", "claude"]).toContain(profile.backend);
    }
  });
});
