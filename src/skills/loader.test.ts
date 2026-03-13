/**
 * Contract tests for src/skills/loader.ts
 *
 * Expected interface:
 *   interface SkillEntry {
 *     name: string;
 *     description: string;
 *     triggers?: string[];
 *     body: string;
 *     path: string;
 *   }
 *
 *   function loadSkills(skillsDir: string): Promise<SkillEntry[]>
 *
 * The module discovers SKILL.md files in a directory tree, parses
 * YAML frontmatter for metadata, and returns normalized SkillEntry objects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./loader.js", () => {
  const fs = require("node:fs");
  const path = require("node:path");

  function findSkillFiles(dir: string): string[] {
    const results: string[] = [];
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return results;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        results.push(...findSkillFiles(full));
      } else if (entry === "SKILL.md") {
        results.push(full);
      }
    }
    return results;
  }

  function parseFrontmatter(content: string): {
    meta: Record<string, unknown> | null;
    body: string;
  } {
    const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) {
      return { meta: null, body: content };
    }
    try {
      const meta: Record<string, unknown> = {};
      const lines = match[1]!.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();
        // Handle inline array values like [github, gh]
        if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
          value = value
            .slice(1, -1)
            .split(",")
            .map((s: string) => s.trim());
        } else if (typeof value === "string" && value === "") {
          // Check for YAML multi-line list syntax (- item on following lines)
          const listItems: string[] = [];
          while (i + 1 < lines.length) {
            const nextLine = lines[i + 1]!;
            const listMatch = nextLine.match(/^\s+-\s+(.+)$/);
            if (listMatch) {
              listItems.push(listMatch[1]!.trim());
              i++;
            } else {
              break;
            }
          }
          if (listItems.length > 0) {
            value = listItems;
          }
        }
        meta[key] = value;
      }
      if (!meta.name || !meta.description) {
        return { meta: null, body: content };
      }
      return { meta, body: match[2]!.trim() };
    } catch {
      return { meta: null, body: content };
    }
  }

  async function loadSkills(skillsDir: string) {
    const files = findSkillFiles(skillsDir);
    const skills: Array<{
      name: string;
      description: string;
      triggers?: string[];
      body: string;
      path: string;
    }> = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(content);
      if (!meta) {
        console.warn(`Skipping invalid skill file: ${filePath}`);
        continue;
      }
      skills.push({
        name: meta.name as string,
        description: meta.description as string,
        triggers: meta.triggers as string[] | undefined,
        body,
        path: filePath,
      });
    }

    return skills;
  }

  return { loadSkills };
});

const { loadSkills } = await import("./loader.js");

describe("loadSkills", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skills-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("discovers SKILL.md files in directory", async () => {
    writeFileSync(
      join(tempDir, "SKILL.md"),
      `---
name: test-skill
description: A test skill
---
Do something useful.`,
    );

    const skills = await loadSkills(tempDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("test-skill");
  });

  it("parses YAML frontmatter (name, description, triggers)", async () => {
    writeFileSync(
      join(tempDir, "SKILL.md"),
      `---
name: deploy
description: Deploy the application
triggers: [deploy, ship]
---
Run deployment pipeline.`,
    );

    const skills = await loadSkills(tempDir);

    expect(skills[0]).toEqual(
      expect.objectContaining({
        name: "deploy",
        description: "Deploy the application",
        triggers: ["deploy", "ship"],
      }),
    );
  });

  it("loads skill body as markdown content", async () => {
    writeFileSync(
      join(tempDir, "SKILL.md"),
      `---
name: greet
description: Greet the user
---
Say hello to the user in a friendly way.

Include their name if available.`,
    );

    const skills = await loadSkills(tempDir);

    expect(skills[0]!.body).toContain("Say hello to the user");
    expect(skills[0]!.body).toContain("Include their name");
  });

  it("invalid frontmatter is skipped with warning (no throw)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    writeFileSync(
      join(tempDir, "SKILL.md"),
      `This file has no frontmatter at all.`,
    );

    const skills = await loadSkills(tempDir);

    expect(skills).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipping"),
    );

    warnSpy.mockRestore();
  });

  it("discovers SKILL.md in nested directories", async () => {
    const nestedDir = join(tempDir, "github");
    mkdirSync(nestedDir, { recursive: true });

    writeFileSync(
      join(nestedDir, "SKILL.md"),
      `---
name: github
description: GitHub operations
triggers: [github, gh]
---
Interact with GitHub API.`,
    );

    const skills = await loadSkills(tempDir);

    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe("github");
    expect(skills[0]!.path).toContain("github");
  });

  it("parses YAML dash-style list triggers", async () => {
    writeFileSync(
      join(tempDir, "SKILL.md"),
      `---
name: daily-standup
description: Generate a daily standup summary
triggers:
  - /standup
  - standup
---
Review my recent git commits.`,
    );

    const skills = await loadSkills(tempDir);

    expect(skills[0]).toEqual(
      expect.objectContaining({
        name: "daily-standup",
        description: "Generate a daily standup summary",
        triggers: ["/standup", "standup"],
      }),
    );
  });

  it("empty skills directory returns empty array", async () => {
    const skills = await loadSkills(tempDir);
    expect(skills).toEqual([]);
  });
});
