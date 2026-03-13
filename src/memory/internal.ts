import { createHash } from "node:crypto";
import { readFile, readdir, lstat, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { MemoryChunk, MemoryFileEntry } from "./types.js";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  if (!content) return [];

  const charLimit = chunking.tokens * 4;
  const overlapChars = chunking.overlap * 4;
  const lines = content.split("\n");
  const chunks: MemoryChunk[] = [];

  let charCount = 0;
  let chunkStartLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0); // +1 for newline
    charCount += lineLen;

    if (charCount >= charLimit || i === lines.length - 1) {
      const text = lines.slice(chunkStartLine, i + 1).join("\n");
      chunks.push({
        startLine: chunkStartLine + 1,
        endLine: i + 1,
        text,
        hash: hashText(text),
      });

      if (i < lines.length - 1) {
        // Find overlap start line by walking backwards
        let overlapCount = 0;
        let overlapStartLine = i + 1;
        for (let j = i; j >= chunkStartLine; j--) {
          overlapCount += lines[j].length + 1;
          if (overlapCount >= overlapChars) {
            overlapStartLine = j;
            break;
          }
        }
        chunkStartLine = overlapStartLine;
        // Recount chars from the new start
        charCount = 0;
        for (let j = chunkStartLine; j <= i; j++) {
          charCount += lines[j].length + (j < lines.length - 1 ? 1 : 0);
        }
      }
    }
  }

  return chunks;
}

export async function listMemoryFiles(
  workspaceDir: string,
): Promise<string[]> {
  const seen = new Set<string>();
  const results: string[] = [];

  async function addIfExists(absPath: string): Promise<void> {
    try {
      const s = await lstat(absPath);
      if (s.isSymbolicLink()) return;
      if (!s.isFile()) return;
      const real = await realpath(absPath);
      if (seen.has(real)) return;
      seen.add(real);
      results.push(absPath);
    } catch {
      // file doesn't exist, skip
    }
  }

  // Check root-level memory files
  await addIfExists(join(workspaceDir, "MEMORY.md"));
  await addIfExists(join(workspaceDir, "memory.md"));

  // Walk memory/ subdirectory
  const memoryDir = join(workspaceDir, "memory");
  try {
    await walkDir(memoryDir, seen, results);
  } catch {
    // memory/ dir doesn't exist, skip
  }

  return results;
}

async function walkDir(
  dir: string,
  seen: Set<string>,
  results: string[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkDir(full, seen, results);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      const real = await realpath(full);
      if (seen.has(real)) continue;
      seen.add(real);
      results.push(full);
    }
  }
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry | null> {
  try {
    const [content, s] = await Promise.all([
      readFile(absPath, "utf-8"),
      stat(absPath),
    ]);
    return {
      path: relative(workspaceDir, absPath),
      absPath,
      mtimeMs: s.mtimeMs,
      size: s.size,
      hash: hashText(content),
    };
  } catch {
    return null;
  }
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as number[];
    return [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

export function isMemoryPath(relPath: string): boolean {
  if (relPath === "MEMORY.md" || relPath === "memory.md") return true;
  return relPath.startsWith("memory/") || relPath.startsWith("memory\\");
}
