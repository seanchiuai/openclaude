import type { SkillEntry } from "./loader.js";

export function matchSkillCommand(
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

export function listSkills(skills: SkillEntry[]): string {
  if (skills.length === 0) return "No skills loaded.";
  return skills.map((s) => `- **${s.name}**: ${s.description}`).join("\n");
}
