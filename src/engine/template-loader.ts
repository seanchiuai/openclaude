import { statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In both src/ (vitest) and dist/ (compiled), go up to project root
const PROJECT_ROOT = join(__dirname, "..", "..");
const PROMPTS_DIR = join(PROJECT_ROOT, "src", "engine", "prompts");

const cache = new Map<string, { content: string; mtimeMs: number }>();

export function loadTemplate(name: string, vars?: Record<string, string>): string {
  const filePath = join(PROMPTS_DIR, `${name}.md`);

  let content: string;
  try {
    const stat = statSync(filePath);
    const cached = cache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      content = cached.content;
    } else {
      content = readFileSync(filePath, "utf-8");
      cache.set(name, { content, mtimeMs: stat.mtimeMs });
    }
  } catch {
    throw new Error(`Prompt template not found: ${name} (${filePath})`);
  }

  if (!vars) return content;
  return content.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}
