import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/src/subagents", { recursive: true });
await cp("src/subagents", "dist/src/subagents", { recursive: true });
