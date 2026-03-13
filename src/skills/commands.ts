/**
 * Skill command resolution — ported from OpenClaw's auto-reply/skill-commands.ts.
 *
 * Supports:
 *   /skillname args        → direct skill invocation
 *   /skill skillname args  → explicit skill dispatch (meta-command)
 */
import type { SkillEntry } from "./loader.js";

// ---------------------------------------------------------------------------
// SkillCommandSpec — intermediate representation between SkillEntry and router
// ---------------------------------------------------------------------------

export interface SkillCommandSpec {
  /** Sanitised slash-command name (unique across the workspace). */
  name: string;
  /** Original skill name from SKILL.md frontmatter. */
  skillName: string;
  /** Human-readable description (truncated to 100 chars for Discord compat). */
  description: string;
}

const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

// ---------------------------------------------------------------------------
// Command-name sanitisation (matches OpenClaw workspace.ts)
// ---------------------------------------------------------------------------

function sanitizeSkillCommandName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Build command specs from loaded skills
// ---------------------------------------------------------------------------

export function buildSkillCommandSpecs(
  skills: SkillEntry[],
  reservedNames?: Set<string>,
): SkillCommandSpec[] {
  const userInvocable = skills.filter((s) => s.invocation.userInvocable);
  const used = new Set<string>();
  for (const reserved of reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const rawDescription = (entry: SkillEntry): string => {
    const raw = entry.description.trim() || entry.name;
    return raw.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
      ? raw.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
      : raw;
  };

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    // Register the skill name as a command
    const base = sanitizeSkillCommandName(entry.name);
    if (!base) continue;
    const unique = resolveUniqueSkillCommandName(base, used);
    used.add(unique.toLowerCase());
    specs.push({ name: unique, skillName: entry.name, description: rawDescription(entry) });

    // Register each trigger as an additional command spec (OpenClaude extension).
    // This allows triggers like "/standup" to resolve for skill "daily-standup".
    if (entry.triggers) {
      for (const trigger of entry.triggers) {
        const triggerBase = sanitizeSkillCommandName(trigger.replace(/^\//, ""));
        if (!triggerBase || triggerBase === unique) continue;
        const triggerUnique = resolveUniqueSkillCommandName(triggerBase, used);
        used.add(triggerUnique.toLowerCase());
        specs.push({ name: triggerUnique, skillName: entry.name, description: rawDescription(entry) });
      }
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Normalised lookup (matches OpenClaw normalizeSkillCommandLookup)
// ---------------------------------------------------------------------------

function normalizeSkillCommandLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

function findSkillCommand(
  specs: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | undefined {
  const trimmed = rawName.trim();
  if (!trimmed) return undefined;

  const lowered = trimmed.toLowerCase();
  const normalized = normalizeSkillCommandLookup(trimmed);

  return specs.find((entry) => {
    if (entry.name.toLowerCase() === lowered) return true;
    if (entry.skillName.toLowerCase() === lowered) return true;
    return (
      normalizeSkillCommandLookup(entry.name) === normalized ||
      normalizeSkillCommandLookup(entry.skillName) === normalized
    );
  });
}

// ---------------------------------------------------------------------------
// Resolve a slash-command invocation — ported from OpenClaw
// ---------------------------------------------------------------------------

export interface SkillCommandInvocation {
  command: SkillCommandSpec;
  args?: string;
}

export function resolveSkillCommandInvocation(params: {
  commandBodyNormalized: string;
  skillCommands: SkillCommandSpec[];
}): SkillCommandInvocation | null {
  const trimmed = params.commandBodyNormalized.trim();
  if (!trimmed.startsWith("/")) return null;

  const match = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!match) return null;

  const commandName = match[1]?.trim().toLowerCase();
  if (!commandName) return null;

  // Meta-command: /skill <skillname> <args>
  if (commandName === "skill") {
    const remainder = match[2]?.trim();
    if (!remainder) return null;
    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;
    const skillCommand = findSkillCommand(params.skillCommands, skillMatch[1] ?? "");
    if (!skillCommand) return null;
    const args = skillMatch[2]?.trim();
    return { command: skillCommand, args: args || undefined };
  }

  // Direct command: /skillname <args>
  const command = findSkillCommand(params.skillCommands, commandName);
  if (!command) return null;
  const args = match[2]?.trim();
  return { command, args: args || undefined };
}

// ---------------------------------------------------------------------------
// Legacy helpers (kept for backward compatibility)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use resolveSkillCommandInvocation instead.
 */
export function matchSkillCommand(
  text: string,
  skills: SkillEntry[],
): SkillEntry | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const command = trimmed.slice(1).split(/\s+/)[0]!.toLowerCase();

  for (const skill of skills) {
    if (skill.triggers?.some((t) => t.replace(/^\//, "").toLowerCase() === command)) {
      return skill;
    }
    if (skill.name.toLowerCase() === command) {
      return skill;
    }
  }
  return null;
}

export function listSkills(skills: SkillEntry[]): string {
  if (skills.length === 0) return "No skills loaded.";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}
