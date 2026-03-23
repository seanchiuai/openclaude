# Phase 3: Slack, Skills, Tools, MCP — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add Slack channel, skills system, agent tools (memory, send, file), MCP config passthrough, and wire everything into the gateway.

**Architecture:** Tests already exist for Tasks 1-5 as contract tests with inline mock implementations. Each implementation module must match the contract exactly — the tests define the spec. Tasks 6-8 add MCP passthrough, gateway wiring, and CLI improvements.

**Tech Stack:** @slack/bolt v4.6, Node.js fs, Zod, vitest

---

## Task 1: Slack Channel — Bot Adapter

**Files:**
- Create: `src/channels/slack/bot.ts`
- Test: `src/channels/slack/bot.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test file mocks `@slack/bolt` and then mocks `./bot.js` with an inline implementation. The real `bot.ts` must export `createSlackChannel` matching the mock's behavior exactly.

**Step 1: Implement `src/channels/slack/bot.ts`**

```typescript
import { App } from "@slack/bolt";
import type { ChannelAdapter, SendResult } from "../types.js";

export interface SlackChannelConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  mode?: "socket" | "http";
  allowFrom?: string[];
}

interface InboundMessage {
  channel: string;
  chatId: string;
  userId: string;
  username?: string;
  text: string;
  source: "user" | "cron" | "system";
  threadId?: string;
  raw?: unknown;
}

type MessageHandler = (msg: InboundMessage) => void;

export function createSlackChannel(
  config: SlackChannelConfig,
  onMessage: MessageHandler,
) {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: config.mode !== "http",
  });

  app.event("message", async ({ event }: { event: Record<string, unknown> }) => {
    const userId = event.user as string;
    if (config.allowFrom && config.allowFrom.length > 0) {
      if (!config.allowFrom.includes(userId)) return;
    }
    onMessage({
      channel: "slack",
      chatId: event.channel as string,
      userId,
      username: (event.username as string) ?? undefined,
      text: event.text as string,
      source: "user",
      threadId: (event.thread_ts as string) ?? undefined,
      raw: event,
    });
  });

  app.event("app_mention", async ({ event }: { event: Record<string, unknown> }) => {
    const userId = event.user as string;
    if (config.allowFrom && config.allowFrom.length > 0) {
      if (!config.allowFrom.includes(userId)) return;
    }
    onMessage({
      channel: "slack",
      chatId: event.channel as string,
      userId,
      username: (event.username as string) ?? undefined,
      text: event.text as string,
      source: "user",
      threadId: (event.thread_ts as string) ?? undefined,
      raw: event,
    });
  });

  return {
    id: "slack" as const,
    start: () => app.start(),
    stop: () => app.stop(),
    sendText: async (chatId: string, text: string): Promise<SendResult> => {
      const result = await (app as any).client.chat.postMessage({
        channel: chatId,
        text,
      });
      return { messageId: result.ts, success: true };
    },
  };
}
```

**Step 2: Run tests**

Run: `pnpm vitest run src/channels/slack/bot.test.ts`
Expected: 7 tests PASS

**Step 3: Commit**

```bash
git add src/channels/slack/bot.ts
git commit -m "feat(slack): add Slack channel bot adapter"
```

---

## Task 2: Slack Channel — Send Utilities

**Files:**
- Create: `src/channels/slack/send.ts`
- Create: `src/channels/slack/index.ts`
- Test: `src/channels/slack/send.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test mocks `./send.js` with inline implementation. Match the contract: `sendSlackText`, `sendSlackMedia`, `splitSlackTextChunks`.

**Step 1: Implement `src/channels/slack/send.ts`**

```typescript
import type { SendResult } from "../types.js";

const SLACK_MESSAGE_LIMIT = 4000;

export function splitSlackTextChunks(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, limit));
    remaining = remaining.slice(limit);
  }
  return chunks;
}

interface SlackWebClient {
  chat: { postMessage: (params: Record<string, unknown>) => Promise<{ ts: string }> };
  files: { uploadV2: (params: Record<string, unknown>) => Promise<{ file?: { id: string } }> };
}

interface MediaAttachment {
  type: string;
  url?: string;
  buffer?: Buffer;
  filename?: string;
}

export async function sendSlackText(
  client: SlackWebClient,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<SendResult> {
  const chunks = splitSlackTextChunks(text);
  let lastTs = "";

  for (const chunk of chunks) {
    const params: Record<string, unknown> = { channel, text: chunk };
    if (threadTs) {
      params.thread_ts = threadTs;
    }
    const result = await client.chat.postMessage(params);
    lastTs = result.ts;
  }

  return { messageId: lastTs, success: true };
}

export async function sendSlackMedia(
  client: SlackWebClient,
  channel: string,
  media: MediaAttachment,
  caption?: string,
): Promise<SendResult> {
  const result = await client.files.uploadV2({
    channel_id: channel,
    file: media.buffer ?? media.url,
    filename: media.filename ?? "file",
    initial_comment: caption,
  });
  return { messageId: result.file?.id ?? "file-uploaded", success: true };
}
```

**Step 2: Create barrel export `src/channels/slack/index.ts`**

```typescript
export { createSlackChannel } from "./bot.js";
export type { SlackChannelConfig } from "./bot.js";
export { sendSlackText, sendSlackMedia, splitSlackTextChunks } from "./send.js";
```

**Step 3: Run tests**

Run: `pnpm vitest run src/channels/slack/`
Expected: ALL Slack tests PASS (bot + send)

**Step 4: Run full test suite**

Run: `pnpm test`
Expected: All 333+ tests PASS

**Step 5: Commit**

```bash
git add src/channels/slack/send.ts src/channels/slack/index.ts
git commit -m "feat(slack): add send utilities and barrel export"
```

---

## Task 3: Skills Loader

**Files:**
- Create: `src/skills/loader.ts`
- Test: `src/skills/loader.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test mocks `./loader.js`. The real module must export `loadSkills(skillsDir: string): Promise<SkillEntry[]>`. It discovers `SKILL.md` files recursively, parses YAML frontmatter, extracts name/description/triggers/body.

**Step 1: Implement `src/skills/loader.ts`**

```typescript
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface SkillEntry {
  name: string;
  description: string;
  triggers?: string[];
  body: string;
  path: string;
}

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
    for (const line of lines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value: unknown = line.slice(colonIdx + 1).trim();
      // Handle array values like [github, gh]
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s: string) => s.trim());
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
    });
  }

  return skills;
}
```

**Step 2: Run tests**

Run: `pnpm vitest run src/skills/loader.test.ts`
Expected: 6 tests PASS

**Step 3: Commit**

```bash
git add src/skills/loader.ts
git commit -m "feat(skills): add skill loader with YAML frontmatter parsing"
```

---

## Task 4: Skills Commands

**Files:**
- Create: `src/skills/commands.ts`
- Create: `src/skills/index.ts`
- Test: `src/skills/commands.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test mocks `./commands.js`. Must export `matchSkillCommand(text, skills)` and `listSkills(skills)`.

**Step 1: Implement `src/skills/commands.ts`**

```typescript
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
  return skills
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");
}
```

**Step 2: Create barrel `src/skills/index.ts`**

```typescript
export { loadSkills } from "./loader.js";
export type { SkillEntry } from "./loader.js";
export { matchSkillCommand, listSkills } from "./commands.js";
```

**Step 3: Run tests**

Run: `pnpm vitest run src/skills/`
Expected: All skills tests PASS

**Step 4: Commit**

```bash
git add src/skills/commands.ts src/skills/index.ts
git commit -m "feat(skills): add skill command matching and listing"
```

---

## Task 5: Memory Tools

**Files:**
- Create: `src/tools/memory-tools.ts`
- Test: `src/tools/memory-tools.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test defines `createMemoryTools(manager)` returning `{ memory_search, memory_get }`. The test creates a mock manager inline and calls the tools. NOTE: The test file uses its OWN inline mock of `createMemoryTools` — it does NOT import from the real module. The test is a contract test that validates the interface shape. The real implementation must match this contract.

**Step 1: Implement `src/tools/memory-tools.ts`**

```typescript
import type { MemoryManager } from "../memory/index.js";
import type { MemorySearchResult } from "../memory/types.js";

export interface MemorySearchParams {
  query: string;
  maxResults?: number;
  minScore?: number;
}

export interface MemoryGetParams {
  path: string;
  from?: number;
  lines?: number;
}

export interface MemoryTools {
  memory_search(params: MemorySearchParams): Promise<MemorySearchResult[]>;
  memory_get(params: MemoryGetParams): Promise<{ text: string }>;
}

export function createMemoryTools(manager: Pick<MemoryManager, "search" | "readFile">): MemoryTools {
  return {
    async memory_search(params: MemorySearchParams): Promise<MemorySearchResult[]> {
      if (!params.query || params.query.trim() === "") {
        return [];
      }

      const maxResults = params.maxResults ?? 10;
      const minScore = params.minScore ?? 0;

      const results = await manager.search(params.query, { maxResults, minScore });

      return results
        .filter((r) => r.score >= minScore)
        .slice(0, maxResults);
    },

    async memory_get(params: MemoryGetParams): Promise<{ text: string }> {
      const result = await manager.readFile(params.path, params.from, params.lines);
      return { text: result.text };
    },
  };
}
```

**Step 2: Run tests**

Run: `pnpm vitest run src/tools/memory-tools.test.ts`
Expected: All tests PASS

**Step 3: Commit**

```bash
git add src/tools/memory-tools.ts
git commit -m "feat(tools): add memory search and get tools"
```

---

## Task 6: Send Tool

**Files:**
- Create: `src/tools/send-tool.ts`
- Test: `src/tools/send-tool.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test mocks `./send-tool.js`. Must export `createSendTool(channels)` returning `{ execute(params) }`.

**Step 1: Implement `src/tools/send-tool.ts`**

```typescript
import type { ChannelAdapter, SendResult } from "../channels/types.js";

export interface SendParams {
  channel: string;
  chatId: string;
  text: string;
}

export interface SendTool {
  execute(params: SendParams): Promise<SendResult & { error?: string }>;
}

export function createSendTool(channels: Map<string, ChannelAdapter>): SendTool {
  return {
    async execute(params: SendParams) {
      const adapter = channels.get(params.channel);
      if (!adapter) {
        return {
          messageId: "",
          success: false,
          error: `Unknown channel: ${params.channel}`,
        };
      }
      return adapter.sendText(params.chatId, params.text);
    },
  };
}
```

**Step 2: Run tests**

Run: `pnpm vitest run src/tools/send-tool.test.ts`
Expected: All 4 tests PASS

**Step 3: Commit**

```bash
git add src/tools/send-tool.ts
git commit -m "feat(tools): add send tool for proactive messaging"
```

---

## Task 7: File Tools

**Files:**
- Create: `src/tools/file-tools.ts`
- Create: `src/tools/index.ts`
- Test: `src/tools/file-tools.test.ts` (EXISTS — DO NOT MODIFY)

**Context:** The test mocks `./file-tools.js`. Must export `createFileTools(workspaceDir)` returning `{ readFile, writeFile, listDirectory }` with path traversal protection.

**Step 1: Implement `src/tools/file-tools.ts`**

```typescript
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
```

**Step 2: Create barrel `src/tools/index.ts`**

```typescript
export { createMemoryTools } from "./memory-tools.js";
export type { MemoryTools, MemorySearchParams, MemoryGetParams } from "./memory-tools.js";
export { createSendTool } from "./send-tool.js";
export type { SendTool, SendParams } from "./send-tool.js";
export { createFileTools } from "./file-tools.js";
export type { FileTools } from "./file-tools.js";
```

**Step 3: Run all tool tests**

Run: `pnpm vitest run src/tools/`
Expected: All tool tests PASS

**Step 4: Run full test suite**

Run: `pnpm test`
Expected: All 333+ tests still green

**Step 5: Commit**

```bash
git add src/tools/file-tools.ts src/tools/index.ts
git commit -m "feat(tools): add sandboxed file tools with path traversal protection"
```

---

## Task 8: MCP Config Passthrough

**Files:**
- Modify: `src/engine/spawn.ts` — add `mcpConfig` parameter
- Modify: `src/engine/types.ts` — add `mcpConfig` to AgentTask

**Context:** MCP server configs from `~/.openclaude/config.json` are passed to Claude Code subprocess via `--mcp-config <path>`. The config is written as a temp JSON file alongside the prompt.

**Step 1: Add `mcpConfig` to `AgentTask` in `src/engine/types.ts`**

Add to the `AgentTask` interface:
```typescript
mcpConfig?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
```

**Step 2: Update `src/engine/spawn.ts` to pass MCP config**

After writing the prompt file, if `task.mcpConfig` is non-empty, write a `.mcp.json` file and add `--mcp-config` to the CLI args:

```typescript
// After writeFileSync(promptFile, task.prompt, "utf-8");
if (task.mcpConfig && Object.keys(task.mcpConfig).length > 0) {
  const mcpConfigPath = join(projectPath, ".mcp.json");
  const mcpPayload = { mcpServers: task.mcpConfig };
  writeFileSync(mcpConfigPath, JSON.stringify(mcpPayload), "utf-8");
  args.push("--mcp-config", mcpConfigPath);
}
```

**Step 3: Run tests**

Run: `pnpm test`
Expected: All tests still pass (no existing tests break, engine tests still green)

**Step 4: Commit**

```bash
git add src/engine/types.ts src/engine/spawn.ts
git commit -m "feat(engine): add MCP config passthrough to Claude subprocess"
```

---

## Task 9: Wire Phase 3 into Gateway

**Files:**
- Modify: `src/gateway/lifecycle.ts` — add Slack channel boot, skills loading
- Modify: `src/router/commands.ts` — add `/skills` command
- Modify: `src/router/commands.ts` — update `GATEWAY_COMMANDS` set

**Step 1: Add `/skills` command to `src/router/commands.ts`**

Add to the handlers object:
```typescript
skills: async () => {
  // Skills info will be injected by gateway on startup
  return "Skills system not available. Use /skills in the CLI.";
},
```

Add `"skills"` to `GATEWAY_COMMANDS` set.

Update `help` to include `/skills`.

**Step 2: Update `src/gateway/lifecycle.ts` to boot Slack**

After the Telegram boot block, add:
```typescript
// Start Slack if configured
if (config.channels.slack?.enabled) {
  const { createSlackChannel } = await import("../channels/slack/index.js");
  const slack = createSlackChannel(config.channels.slack, async (msg) => {
    const response = await router({
      channel: msg.channel,
      chatId: msg.chatId,
      userId: msg.userId,
      username: msg.username,
      text: msg.text,
      source: msg.source as "user" | "cron" | "system",
    });
    if (response && msg.chatId) {
      await slack.sendText(msg.chatId, response);
    }
    return response;
  });
  await slack.start();
  channels.set("slack", slack);
  channelNames.push("slack");
}
```

**Step 3: Run tests**

Run: `pnpm test`
Expected: All tests pass

**Step 4: Run build**

Run: `pnpm build`
Expected: Clean build

**Step 5: Commit**

```bash
git add src/gateway/lifecycle.ts src/router/commands.ts
git commit -m "feat(gateway): wire Slack channel, skills command into gateway"
```

---

## Task 10: CLI Improvements

**Files:**
- Modify: `src/cli/index.ts` — add `skills list`, `memory search`, `logs` commands

**Step 1: Add new CLI commands**

Add cases for `"skills"`, `"memory"`, and `"logs"` to the switch statement:

```typescript
case "skills":
  if (positionals[1] === "list") {
    await skillsList();
  } else {
    console.log("Usage: openclaude skills list");
  }
  break;
case "memory":
  if (positionals[1] === "search" && positionals[2]) {
    await memorySearch(positionals.slice(2).join(" "));
  } else {
    console.log("Usage: openclaude memory search <query>");
  }
  break;
case "logs":
  await tailLogs();
  break;
```

Add the implementing functions:

```typescript
async function skillsList() {
  const { loadSkills } = await import("../skills/index.js");
  const { paths } = await import("../config/paths.js");
  const skills = await loadSkills(paths.skills);
  if (skills.length === 0) {
    console.log("No skills loaded.");
    return;
  }
  for (const s of skills) {
    console.log(`- ${s.name}: ${s.description}`);
  }
}

async function memorySearch(query: string) {
  const { createMemoryManager } = await import("../memory/index.js");
  const { paths } = await import("../config/paths.js");
  const manager = createMemoryManager({ dbPath: paths.memoryDb, workspaceDir: paths.base });
  await manager.sync();
  const results = await manager.search(query);
  if (results.length === 0) {
    console.log("No results found.");
  } else {
    for (const r of results) {
      console.log(`[${r.score.toFixed(2)}] ${r.citation ?? r.path}`);
      console.log(`  ${r.snippet.slice(0, 120)}`);
    }
  }
  manager.close();
}

async function tailLogs() {
  const { paths } = await import("../config/paths.js");
  const { join } = await import("node:path");
  const { createReadStream, existsSync } = await import("node:fs");
  const logFile = join(paths.logs, "gateway.log");
  if (!existsSync(logFile)) {
    console.log("No log file found.");
    return;
  }
  const stream = createReadStream(logFile, { encoding: "utf-8", start: 0 });
  stream.pipe(process.stdout);
}
```

Update `printUsage()` to include the new commands.

**Step 2: Run tests**

Run: `pnpm test`
Expected: All tests pass

**Step 3: Run build**

Run: `pnpm build`
Expected: Clean build

**Step 4: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): add skills list, memory search, and logs commands"
```

---

## Dependencies Between Tasks

```
Task 1 (Slack bot) ─────┐
Task 2 (Slack send) ────┤
                        ├── Task 9 (Wire into gateway) ── Task 10 (CLI)
Task 3 (Skills loader) ─┤
Task 4 (Skills cmds) ───┤
Task 5 (Memory tools) ──┤
Task 6 (Send tool) ─────┤
Task 7 (File tools) ────┤
Task 8 (MCP config) ────┘
```

Tasks 1-8 are independent and can run in parallel. Tasks 9-10 depend on 1-8.

---

## Verification

After ALL tasks complete:

```bash
pnpm test              # All tests pass
pnpm build             # Clean build, no errors
pnpm lint              # Zero lint errors
```
