import fs from "node:fs/promises";
import path from "node:path";

export interface FileTools {
  readFile(filePath: string): Promise<string>;
  writeFile(filePath: string, content: string): Promise<void>;
  listDirectory(dirPath: string): Promise<string[]>;
}

export function createFileTools(workspaceDir: string): FileTools {
  const root = path.resolve(workspaceDir);

  function safePath(inputPath: string): string {
    const resolved = path.resolve(root, inputPath);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(
        `Path traversal blocked: ${inputPath} resolves outside workspace`,
      );
    }
    return resolved;
  }

  return {
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(safePath(filePath), "utf-8");
    },

    async writeFile(filePath: string, content: string): Promise<void> {
      const full = safePath(filePath);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, "utf-8");
    },

    async listDirectory(dirPath: string): Promise<string[]> {
      return fs.readdir(safePath(dirPath));
    },
  };
}
