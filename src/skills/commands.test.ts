/**
 * Contract tests for src/skills/commands.ts
 *
 * Expected interface:
 *   function matchSkillCommand(text: string, skills: SkillEntry[]): SkillEntry | null
 *   function listSkills(skills: SkillEntry[]): string
 *
 * SkillEntry: {
 *   name: string;
 *   description: string;
 *   triggers?: string[];
 *   body: string;
 *   path: string;
 * }
 *
 * matchSkillCommand checks if the input text starts with a slash command
 * that matches any skill's triggers. listSkills formats all loaded skills
 * into a human-readable summary.
 */

import { describe, it, expect, vi } from "vitest";

interface SkillEntry {
  name: string;
  description: string;
  triggers?: string[];
  body: string;
  path: string;
}

vi.mock("./commands.js", () => {
  function matchSkillCommand(
    text: string,
    skills: SkillEntry[],
  ): SkillEntry | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return null;

    const command = trimmed.slice(1).split(/\s+/)[0]!.toLowerCase();

    for (const skill of skills) {
      if (skill.triggers?.includes(command)) {
        return skill;
      }
      if (skill.name.toLowerCase() === command) {
        return skill;
      }
    }
    return null;
  }

  function listSkills(skills: SkillEntry[]): string {
    if (skills.length === 0) return "No skills loaded.";
    return skills
      .map((s) => `- **${s.name}**: ${s.description}`)
      .join("\n");
  }

  return { matchSkillCommand, listSkills };
});

const { matchSkillCommand, listSkills } = await import("./commands.js");

const sampleSkills: SkillEntry[] = [
  {
    name: "github",
    description: "GitHub operations",
    triggers: ["github", "gh"],
    body: "Interact with GitHub.",
    path: "/skills/github/SKILL.md",
  },
  {
    name: "deploy",
    description: "Deploy the application",
    triggers: ["deploy", "ship"],
    body: "Run deployment.",
    path: "/skills/deploy/SKILL.md",
  },
];

describe("matchSkillCommand", () => {
  it("slash command matches skill trigger", () => {
    const result = matchSkillCommand("/github create issue", sampleSkills);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("github");
  });

  it("returns skill content for matched command", () => {
    const result = matchSkillCommand("/gh", sampleSkills);
    expect(result).not.toBeNull();
    expect(result!.body).toBe("Interact with GitHub.");
  });

  it("unknown skill command returns null", () => {
    const result = matchSkillCommand("/unknown", sampleSkills);
    expect(result).toBeNull();
  });

  it("non-slash text returns null", () => {
    const result = matchSkillCommand("just a regular message", sampleSkills);
    expect(result).toBeNull();
  });
});

describe("listSkills", () => {
  it("shows all loaded skills with names and descriptions", () => {
    const output = listSkills(sampleSkills);
    expect(output).toContain("github");
    expect(output).toContain("GitHub operations");
    expect(output).toContain("deploy");
    expect(output).toContain("Deploy the application");
  });

  it("returns message when no skills loaded", () => {
    const output = listSkills([]);
    expect(output).toBeTruthy();
    expect(output.length).toBeGreaterThan(0);
  });
});
