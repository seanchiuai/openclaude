import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const FAKE_CLAUDE = join(__dirname, "../fixtures/fake-claude.ts");
export const FAKE_CLAUDE_CMD = `npx tsx ${FAKE_CLAUDE}`;

export interface TestEnv {
  dir: string;
  configPath: string;
  config: Record<string, unknown>;
}

export async function createTestEnv(
  overrides: Record<string, unknown> = {},
): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpdir(), "openclaude-test-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });

  const config = {
    gateway: { port: 0, token: "test-token" },
    engine: { maxConcurrent: 2 },
    channels: {},
    memory: { enabled: false },
    cron: { enabled: false },
    ...overrides,
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { dir, configPath, config };
}
