import { readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface SkillInvocationPolicy {
  userInvocable: boolean;
  disableModelInvocation: boolean;
}

export interface SkillEntry {
  name: string;
  description: string;
  triggers?: string[];
  body: string;
  path: string;
  invocation: SkillInvocationPolicy;
}

const MAX_SKILL_FILE_BYTES = 256 * 1024;

function findSkillFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findSkillFiles(full));
    } else if (entry === "SKILL.md") {
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        console.warn(`Skipping oversized skill file (${stat.size} bytes): ${full}`);
        continue;
      }
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

function parseFrontmatterBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === "") return defaultValue;
  if (typeof value === "boolean") return value;
  const str = String(value).trim().toLowerCase();
  if (str === "true" || str === "yes" || str === "1") return true;
  if (str === "false" || str === "no" || str === "0") return false;
  return defaultValue;
}

function resolveInvocationPolicy(meta: Record<string, unknown>): SkillInvocationPolicy {
  return {
    userInvocable: parseFrontmatterBool(
      meta["user-invocable"] ?? meta["user_invocable"],
      true,
    ),
    disableModelInvocation: parseFrontmatterBool(
      meta["disable-model-invocation"] ?? meta["disable_model_invocation"],
      false,
    ),
  };
}

export async function loadSkills(skillsDir: string): Promise<SkillEntry[]> {
  const files = findSkillFiles(skillsDir);
  const skills: SkillEntry[] = [];

  for (const filePath of files) {
    const content = readFileSync(filePath, "utf-8");
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
      invocation: resolveInvocationPolicy(meta),
    });
  }

  return skills;
}
