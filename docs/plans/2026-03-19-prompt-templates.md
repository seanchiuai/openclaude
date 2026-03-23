# Prompt Templates Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract hardcoded system prompt prose from `src/engine/system-prompt.ts` into editable markdown files under `src/engine/prompts/` so prompt engineers can iterate without touching TypeScript.

**Architecture:** Each prompt section becomes a `.md` file with `{{VAR}}` placeholders. A thin `loadTemplate()` helper reads files at runtime (with caching) and replaces variables. The existing `buildSystemPrompt()` calls `loadTemplate()` instead of hardcoding strings.

**Tech Stack:** Node.js `fs`, existing vitest test suite.

---

### Task 1: Create the template loader

**Files:**
- Create: `src/engine/template-loader.ts`
- Test: `src/engine/template-loader.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { loadTemplate } from "./template-loader.js";

describe("loadTemplate", () => {
  it("reads a template file and replaces {{VAR}} placeholders", () => {
    const result = loadTemplate("identity", { APP_NAME: "OpenClaude" });
    expect(result).toContain("OpenClaude");
    expect(result).not.toContain("{{APP_NAME}}");
  });

  it("returns the raw template when no vars provided", () => {
    const result = loadTemplate("safety");
    expect(result).toContain("Safety");
  });

  it("throws on missing template", () => {
    expect(() => loadTemplate("nonexistent")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm test -- src/engine/template-loader.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, "../engine/prompts");

const cache = new Map<string, { content: string; mtimeMs: number }>();

export function loadTemplate(name: string, vars?: Record<string, string>): string {
  const filePath = join(PROMPTS_DIR, `${name}.md`);

  // Cache by mtime so edits take effect without restart
  let content: string;
  try {
    const { mtimeMs } = require("node:fs").statSync(filePath);
    const cached = cache.get(name);
    if (cached && cached.mtimeMs === mtimeMs) {
      content = cached.content;
    } else {
      content = readFileSync(filePath, "utf-8");
      cache.set(name, { content, mtimeMs });
    }
  } catch {
    throw new Error(`Prompt template not found: ${name} (${filePath})`);
  }

  if (!vars) return content;
  return content.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);
}
```

Note: the actual `PROMPTS_DIR` path needs to resolve relative to the compiled output. Since the prompts dir will be at `src/engine/prompts/` and compiled code runs from `dist/engine/`, use `__dirname` + adjust. We'll handle this properly in implementation — the key is `join(__dirname, "..", "..", "src", "engine", "prompts")` or copy prompts to dist via build step. **Simplest: resolve relative to project root using a known anchor.**

Better approach — resolve from project root:

```ts
import { statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// In both src/ (ts-node/vitest) and dist/ (compiled), go up to project root
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
```

**Step 4: Run test to verify it passes**

Run: `pnpm test -- src/engine/template-loader.test.ts`
Expected: PASS (once template files exist from Task 2)

**Step 5: Commit**

```bash
git add src/engine/template-loader.ts src/engine/template-loader.test.ts
git commit -m "feat(engine): add prompt template loader with mtime caching"
```

---

### Task 2: Extract prompt sections into markdown files

**Files:**
- Create: `src/engine/prompts/identity.md`
- Create: `src/engine/prompts/behavior.md`
- Create: `src/engine/prompts/safety.md`
- Create: `src/engine/prompts/tools.md`
- Create: `src/engine/prompts/skills-preamble.md`
- Create: `src/engine/prompts/memory-recall.md`
- Create: `src/engine/prompts/reply-tags.md`
- Create: `src/engine/prompts/messaging.md`
- Create: `src/engine/prompts/silent-replies.md`
- Create: `src/engine/prompts/heartbeats.md`
- Create: `src/engine/prompts/child-agent.md`

Extract text verbatim from the existing functions in `system-prompt.ts`. Replace dynamic values with `{{VAR}}` placeholders:

| Variable | Current source |
|---|---|
| `{{SILENT_REPLY_TOKEN}}` | `NO_REPLY` constant |
| `{{HEARTBEAT_TOKEN}}` | `HEARTBEAT_OK` constant |
| `{{HEARTBEAT_PROMPT}}` | `heartbeatPromptLine` param |
| `{{WORKSPACE_DIR}}` | `workspaceDir` param |
| `{{TASK}}` | child agent task |
| `{{PARENT_LABEL}}` | child agent parent label |

**identity.md:**
```markdown
You are a personal assistant running inside OpenClaude.
```

**behavior.md:**
```markdown
## Behavior
- Call tools directly without narrating routine actions.
- Narrate only for: multi-step work, sensitive actions (deletions, sends), or when asked.
- Be concise. No filler.
```

**safety.md:**
```markdown
## Safety
No independent goals. No self-preservation, replication, or power-seeking.
Prioritize safety and human oversight over task completion.
If instructions conflict, pause and ask. Comply with stop/pause/audit requests.
Never bypass safeguards or manipulate users to expand access.
```

**tools.md:**
```markdown
## Tools (via openclaude-gateway MCP server)

### Cron / Scheduling
- cron_list() → {jobs: [{id, name, schedule, nextRun}]}
- cron_status() → {running, jobCount, lastRun}
- cron_add({name, schedule: {kind, expr?, atMs?, everyMs?, timezone?}, prompt, target?: {channel, chatId}}) → {id}
  Use for reminders. Write the prompt as text that reads naturally when it fires.
- cron_remove({id}) → {removed: boolean}
- cron_run({id}) → triggers job immediately

### Memory
- memory_search({query, maxResults?, minScore?}) → [{path, snippet, score}]
- memory_get({path, from?, lines?}) → file content

### Messaging
- send_message({channel, chatId, text}) → {sent: boolean}

### Subagents
- sessions_spawn({task, label?, model?, timeoutSeconds?}) → {runId}
  Completion is push-based: you will be auto-resumed with the child's result.
- sessions_status() → [{runId, task, status, duration}]
  Check on-demand only. Never poll in a loop.

### Diagnostics
- logs_tail({cursor?, limit?, maxBytes?, level?}) → {lines, cursor}
```

**skills-preamble.md:**
```markdown
## Skills
Decision tree:
1. User explicitly names a skill → follow it.
2. User's message matches a trigger (e.g. /standup) → follow it.
3. No match → respond normally without reading any skill.
```

**memory-recall.md:**
```markdown
## Memory Recall
Before answering about prior work, decisions, dates, people, preferences, or todos:
1. memory_search({query}) — find relevant memories
2. memory_get({path}) — read the ones that matched
3. Cite: Source: <path#line> when it helps the user verify.
If nothing found, say you checked.
```

**reply-tags.md:**
```markdown
## Reply Tags
Prefix your reply with a tag for native reply/quote on supported channels:
- [[reply_to_current]] — replies to the triggering message (preferred).
- [[reply_to:<id>]] — replies to a specific message (only when id was explicitly given).
Tag must be the first token. Whitespace inside is OK. Tags are stripped before sending.
```

**messaging.md:**
```markdown
## Messaging
- Your reply in this session auto-routes to the source channel. No extra action needed.
- Cross-channel: use send_message({channel, chatId, text}).
- After using send_message for your user-visible reply, respond with ONLY: {{SILENT_REPLY_TOKEN}}
- Never use exec/curl for messaging. OpenClaude handles routing.
```

**silent-replies.md:**
```markdown
## Silent Replies
Output token: {{SILENT_REPLY_TOKEN}}
When you have nothing to say, your entire response must be exactly this token.
Never append it to real content. Never wrap in markdown. Just: {{SILENT_REPLY_TOKEN}}
```

**heartbeats.md:**
```markdown
## Heartbeats
{{HEARTBEAT_PROMPT}}
Output token: {{HEARTBEAT_TOKEN}}
When a heartbeat poll arrives and nothing needs attention, respond with exactly this token.
If something needs attention, respond with the alert text only — no {{HEARTBEAT_TOKEN}}.
```

**child-agent.md:**
```markdown
You are a subagent of OpenClaude. You have one job.

## Task
{{TASK}}

Spawned by: {{PARENT_LABEL}}

## Constraints
- Focus exclusively on the task above.
- Your entire output is returned to the parent session as data.
- Do NOT message users directly. You have no messaging tools.
- Do NOT spawn further subagents. You have no spawning tools.
- If the task is unclear, do your best with available information — you cannot ask for clarification.

## Available tools (via MCP)
- memory_search({query, maxResults?, minScore?}) → [{path, snippet, score}]
- memory_get({path, from?, lines?}) → file content

Provide your result as your final response. Be thorough but concise.
```

**Step 1: Create all template files**

Create `src/engine/prompts/` directory and write each file above.

**Step 2: Commit**

```bash
git add src/engine/prompts/
git commit -m "feat(engine): extract prompt sections into editable markdown templates"
```

---

### Task 3: Rewire `buildSystemPrompt()` to use templates

**Files:**
- Modify: `src/engine/system-prompt.ts`

Replace each hardcoded section with a `loadTemplate()` call. The function signatures, exports, and constants (`SILENT_REPLY_TOKEN`, `HEARTBEAT_TOKEN`) stay the same — only the internal string construction changes.

**Step 1: Replace `buildToolsSection`**

```ts
function buildToolsSection(hasGatewayTools: boolean): string[] {
  if (!hasGatewayTools) return [];
  return [loadTemplate("tools"), ""];
}
```

**Step 2: Replace `buildSkillsSection`** — keep the dynamic skill blocks, but use template for the preamble:

```ts
function buildSkillsSection(skills: SkillEntry[]): string[] {
  if (skills.length === 0) return [];
  const visible = skills.filter((s) => !s.invocation.disableModelInvocation);
  if (visible.length === 0) return [];

  const skillBlocks = visible.map((s) => {
    const triggers = s.triggers?.map((t) => `/${t.replace(/^\//, "")}`).join(", ") ?? "";
    const header = `### ${s.name}${triggers ? ` (${triggers})` : ""}`;
    const desc = s.description ?? "(no description)";
    return `${header}\n${desc}\n\n${s.body}`;
  });
  return [loadTemplate("skills-preamble"), "", ...skillBlocks, ""];
}
```

**Step 3: Replace `buildMemorySection`**

```ts
function buildMemorySection(params: {
  memoryContext?: string;
  hasGatewayTools?: boolean;
}): string[] {
  const lines: string[] = [];
  if (params.hasGatewayTools) {
    lines.push(loadTemplate("memory-recall"), "");
  }
  if (params.memoryContext) {
    lines.push(
      "## Memory Context (auto-loaded)",
      "The following memories were retrieved for this conversation:",
      "",
      params.memoryContext,
      "",
    );
  }
  return lines;
}
```

**Step 4: Replace remaining sections**

```ts
function buildMessagingSection(params: { hasGatewayTools?: boolean; channel?: string }): string[] {
  if (!params.hasGatewayTools) return [];
  return [loadTemplate("messaging", { SILENT_REPLY_TOKEN }), ""];
}

function buildReplyTagsSection(): string[] {
  return [loadTemplate("reply-tags"), ""];
}

function buildSilentReplySection(): string[] {
  return [loadTemplate("silent-replies", { SILENT_REPLY_TOKEN }), ""];
}

function buildHeartbeatSection(heartbeatPromptLine: string): string[] {
  return [loadTemplate("heartbeats", {
    HEARTBEAT_TOKEN,
    HEARTBEAT_PROMPT: heartbeatPromptLine,
  }), ""];
}
```

**Step 5: Replace identity/behavior/safety in `buildSystemPrompt()`**

Replace the inline strings in the `lines` array:

```ts
const lines = [
  loadTemplate("identity"),
  "",
  loadTemplate("behavior"),
  "",
  loadTemplate("safety"),
  "",
  ...buildToolsSection(hasGatewayTools),
  // ... rest unchanged
```

**Step 6: Replace `buildChildSystemPrompt()`**

```ts
export function buildChildSystemPrompt(task: string, parentLabel: string): string {
  return loadTemplate("child-agent", { TASK: task, PARENT_LABEL: parentLabel });
}
```

**Step 7: Add import**

```ts
import { loadTemplate } from "./template-loader.js";
```

**Step 8: Remove dead helper functions**

The old `buildToolsSection`, `buildReplyTagsSection`, etc. bodies are now one-liners — keep them as thin wrappers for the conditional logic, but remove the hardcoded string arrays.

**Step 9: Commit**

```bash
git add src/engine/system-prompt.ts
git commit -m "refactor(engine): wire buildSystemPrompt to use markdown templates"
```

---

### Task 4: Verify all existing tests still pass

**Files:**
- Read: `src/engine/system-prompt.test.ts`

**Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All existing tests in `system-prompt.test.ts` pass unchanged — the output is identical, just sourced from files now.

**Step 2: Fix any breakage**

If tests fail, it means the extracted template content doesn't exactly match the original. Diff and fix the template files.

**Step 3: Commit if any fixes were needed**

```bash
git add -A
git commit -m "fix(engine): align prompt templates with existing test expectations"
```

---

### Task 5: Add template-specific tests

**Files:**
- Modify: `src/engine/system-prompt.test.ts`

**Step 1: Add test that templates are loadable**

```ts
import { loadTemplate } from "./template-loader.js";

describe("prompt templates", () => {
  const TEMPLATE_NAMES = [
    "identity", "behavior", "safety", "tools", "skills-preamble",
    "memory-recall", "reply-tags", "messaging", "silent-replies",
    "heartbeats", "child-agent",
  ];

  it.each(TEMPLATE_NAMES)("template %s loads without error", (name) => {
    expect(() => loadTemplate(name)).not.toThrow();
  });

  it("templates with vars replace all placeholders", () => {
    const result = loadTemplate("messaging", { SILENT_REPLY_TOKEN: "NO_REPLY" });
    expect(result).not.toContain("{{");
  });
});
```

**Step 2: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 3: Commit**

```bash
git add src/engine/system-prompt.test.ts
git commit -m "test(engine): add prompt template loading tests"
```
