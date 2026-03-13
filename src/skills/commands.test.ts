/**
 * Tests for src/skills/commands.ts
 *
 * Covers:
 *   - matchSkillCommand (legacy)
 *   - resolveSkillCommandInvocation (OpenClaw-style)
 *   - buildSkillCommandSpecs
 *   - listSkills
 */

import { describe, it, expect } from "vitest";
import type { SkillEntry } from "./loader.js";
import {
  matchSkillCommand,
  listSkills,
  buildSkillCommandSpecs,
  resolveSkillCommandInvocation,
} from "./commands.js";
import type { SkillCommandSpec } from "./commands.js";

const defaultInvocation = { userInvocable: true, disableModelInvocation: false };

const sampleSkills: SkillEntry[] = [
  {
    name: "github",
    description: "GitHub operations",
    triggers: ["github", "gh"],
    body: "Interact with GitHub.",
    path: "/skills/github/SKILL.md",
    invocation: defaultInvocation,
  },
  {
    name: "deploy",
    description: "Deploy the application",
    triggers: ["deploy", "ship"],
    body: "Run deployment.",
    path: "/skills/deploy/SKILL.md",
    invocation: defaultInvocation,
  },
];

// ---------------------------------------------------------------------------
// matchSkillCommand (legacy)
// ---------------------------------------------------------------------------

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

  it("matches trigger that includes leading slash", () => {
    const skillsWithSlash: SkillEntry[] = [
      {
        name: "daily-standup",
        description: "Daily standup",
        triggers: ["/standup"],
        body: "Do standup.",
        path: "/skills/standup/SKILL.md",
        invocation: defaultInvocation,
      },
    ];
    const result = matchSkillCommand("/standup", skillsWithSlash);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("daily-standup");
  });

  it("non-slash text returns null", () => {
    const result = matchSkillCommand("just a regular message", sampleSkills);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildSkillCommandSpecs
// ---------------------------------------------------------------------------

describe("buildSkillCommandSpecs", () => {
  it("builds specs from skills with sanitised names (including trigger aliases)", () => {
    const specs = buildSkillCommandSpecs(sampleSkills);
    // github → name "github" + trigger "gh" = 2, deploy → name "deploy" + trigger "ship" = 2
    expect(specs).toHaveLength(4);
    expect(specs[0]!.name).toBe("github");
    expect(specs[0]!.skillName).toBe("github");
    expect(specs[1]!.name).toBe("gh");
    expect(specs[1]!.skillName).toBe("github");
    expect(specs[2]!.name).toBe("deploy");
    expect(specs[3]!.name).toBe("ship");
  });

  it("filters out non-user-invocable skills", () => {
    const skills: SkillEntry[] = [
      {
        name: "internal-only",
        description: "Not user-invocable",
        body: "...",
        path: "/skills/internal/SKILL.md",
        invocation: { userInvocable: false, disableModelInvocation: false },
      },
      ...sampleSkills,
    ];
    const specs = buildSkillCommandSpecs(skills);
    // 4 from sampleSkills, 0 from internal-only
    expect(specs).toHaveLength(4);
    expect(specs.find((s) => s.skillName === "internal-only")).toBeUndefined();
  });

  it("deduplicates against reserved names", () => {
    const reserved = new Set(["github"]);
    const specs = buildSkillCommandSpecs(sampleSkills, reserved);
    // github should be renamed to github-2
    const ghSpec = specs.find((s) => s.skillName === "github");
    expect(ghSpec).toBeDefined();
    expect(ghSpec!.name).toBe("github-2");
  });

  it("truncates long descriptions", () => {
    const skills: SkillEntry[] = [
      {
        name: "verbose",
        description: "A".repeat(200),
        body: "...",
        path: "/skills/verbose/SKILL.md",
        invocation: defaultInvocation,
      },
    ];
    const specs = buildSkillCommandSpecs(skills);
    expect(specs[0]!.description.length).toBeLessThanOrEqual(100);
    expect(specs[0]!.description).toContain("…");
  });

  it("sanitises special characters in names", () => {
    const skills: SkillEntry[] = [
      {
        name: "my awesome_skill!",
        description: "test",
        body: "...",
        path: "/skills/test/SKILL.md",
        invocation: defaultInvocation,
      },
    ];
    const specs = buildSkillCommandSpecs(skills);
    expect(specs[0]!.name).toBe("my-awesome-skill");
  });
});

// ---------------------------------------------------------------------------
// resolveSkillCommandInvocation
// ---------------------------------------------------------------------------

describe("resolveSkillCommandInvocation", () => {
  const specs: SkillCommandSpec[] = [
    { name: "github", skillName: "github", description: "GitHub operations" },
    { name: "deploy", skillName: "deploy", description: "Deploy the application" },
    { name: "daily-standup", skillName: "daily-standup", description: "Daily standup" },
  ];

  it("resolves direct /command", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/github",
      skillCommands: specs,
    });
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
    expect(result!.args).toBeUndefined();
  });

  it("resolves /command with args", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/github create issue my-issue",
      skillCommands: specs,
    });
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
    expect(result!.args).toBe("create issue my-issue");
  });

  it("resolves /skill meta-command", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill github create issue",
      skillCommands: specs,
    });
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
    expect(result!.args).toBe("create issue");
  });

  it("returns null for /skill without skill name", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/skill",
      skillCommands: specs,
    });
    expect(result).toBeNull();
  });

  it("returns null for unknown command", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/unknown",
      skillCommands: specs,
    });
    expect(result).toBeNull();
  });

  it("returns null for non-slash text", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "just a message",
      skillCommands: specs,
    });
    expect(result).toBeNull();
  });

  it("matches with normalised lookup (underscores/spaces → dashes)", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/daily_standup",
      skillCommands: specs,
    });
    expect(result).not.toBeNull();
    expect(result!.command.skillName).toBe("daily-standup");
  });

  it("case-insensitive matching", () => {
    const result = resolveSkillCommandInvocation({
      commandBodyNormalized: "/GitHub",
      skillCommands: specs,
    });
    expect(result).not.toBeNull();
    expect(result!.command.name).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// listSkills
// ---------------------------------------------------------------------------

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
