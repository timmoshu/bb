import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { VESPYN_RUNTIME_SKILLS } from "./selection.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("bundled skill catalog", () => {
  it("ships exactly the ten selected skills", async () => {
    const entries = await readdir(join(root, "skills"), { withFileTypes: true });
    const names = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual([...VESPYN_RUNTIME_SKILLS].sort());
  });

  it.each(VESPYN_RUNTIME_SKILLS)("ships a correctly named %s skill", async (name) => {
    const source = await readFile(
      join(root, "skills", name, "SKILL.md"),
      "utf8",
    );
    expect(source).toMatch(new RegExp(`^---\\nname: ${name}\\n`, "m"));
    expect(source).not.toContain("[TODO:");
  });

  it("ships every directly referenced support file", async () => {
    await expect(
      readFile(
        join(root, "skills/vespyn-codebase-design/DEEPENING.md"),
        "utf8",
      ),
    ).resolves.toContain("# Deepening");
    await expect(
      readFile(
        join(root, "skills/vespyn-codebase-design/DESIGN-IT-TWICE.md"),
        "utf8",
      ),
    ).resolves.toContain("# Design It Twice");
    await expect(
      readFile(
        join(root, "skills/vespyn-domain-modeling/CONTEXT-FORMAT.md"),
        "utf8",
      ),
    ).resolves.toContain("# CONTEXT.md Format");
    await expect(
      readFile(
        join(root, "skills/vespyn-domain-modeling/ADR-FORMAT.md"),
        "utf8",
      ),
    ).resolves.toContain("# ADR Format");
    await expect(
      readFile(
        join(root, "skills/vespyn-delegate-external/scripts/external_agent.py"),
        "utf8",
      ),
    ).resolves.toContain("grok-4.6");
  });

  it("prevents Grok parent sessions from recursively delegating to Grok", async () => {
    const source = await readFile(
      join(root, "skills/vespyn-delegate-external/SKILL.md"),
      "utf8",
    );
    expect(source).toContain("never recursively delegate back to Grok");
    expect(source).toContain('reasoning_effort = "high"');
  });
});
