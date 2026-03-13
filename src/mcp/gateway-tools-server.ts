#!/usr/bin/env node
/**
 * MCP stdio server that exposes gateway tools to Claude Code subprocesses.
 *
 * Reads GATEWAY_URL from env, exposes tools that POST to the gateway HTTP API.
 * Spawned as a subprocess by Claude Code via --mcp-config.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GATEWAY_URL = process.env.GATEWAY_URL;
if (!GATEWAY_URL) {
  console.error("GATEWAY_URL environment variable is required");
  process.exit(1);
}

type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

async function callGateway(path: string, body: unknown): Promise<McpToolResult> {
  try {
    const res = await fetch(`${GATEWAY_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      return { content: [{ type: "text", text: `Gateway error (${res.status}): ${text}` }], isError: true };
    }
    // Pretty-print the JSON response
    try {
      const json = JSON.parse(text);
      return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
    } catch {
      return { content: [{ type: "text", text }] };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Gateway unreachable: ${message}` }], isError: true };
  }
}

const server = new McpServer({
  name: "openclaude-gateway",
  version: "0.1.0",
});

// --- Cron tools ---

server.tool(
  "cron_list",
  "List all cron jobs",
  {},
  () => callGateway("/api/cron/list", {}),
);

server.tool(
  "cron_status",
  "Get cron service status",
  {},
  () => callGateway("/api/cron/status", {}),
);

server.tool(
  "cron_add",
  "Add a new cron job. Schedule kinds: 'cron' (expr: cron expression, e.g. '0 * * * *'), 'every' (everyMs: interval in ms), 'at' (atMs: unix timestamp in ms)",
  {
    name: z.string().describe("Job name"),
    schedule: z.object({
      kind: z.enum(["cron", "every", "at"]).describe("Schedule type"),
      expr: z.string().optional().describe("Cron expression (for kind='cron')"),
      timezone: z.string().optional().describe("IANA timezone (for kind='cron' or 'at')"),
      atMs: z.number().optional().describe("Unix timestamp in ms (for kind='at')"),
      everyMs: z.number().optional().describe("Interval in ms (for kind='every')"),
    }).describe("Schedule configuration"),
    prompt: z.string().describe("The prompt to run when the job fires"),
    target: z.object({
      channel: z.enum(["telegram", "slack"]).describe("Channel to deliver results to"),
      chatId: z.string().describe("Chat ID to deliver results to"),
    }).optional().describe("Optional delivery target for job results"),
  },
  (params) => callGateway("/api/cron/add", params),
);

server.tool(
  "cron_remove",
  "Remove a cron job by ID",
  { id: z.string().describe("Job ID to remove") },
  (params) => callGateway("/api/cron/remove", params),
);

server.tool(
  "cron_run",
  "Manually trigger a cron job to run immediately",
  { id: z.string().describe("Job ID to run") },
  (params) => callGateway("/api/cron/run", params),
);

// --- Memory tools ---

server.tool(
  "memory_search",
  "Search the memory system for relevant information",
  {
    query: z.string().describe("Search query"),
    maxResults: z.number().optional().describe("Maximum number of results (default: 6)"),
    minScore: z.number().optional().describe("Minimum relevance score (default: 0)"),
  },
  (params) => callGateway("/api/memory/search", params),
);

server.tool(
  "memory_get",
  "Read a memory file by relative path",
  {
    path: z.string().describe("Relative path to the memory file"),
    from: z.number().optional().describe("Start line number (1-indexed)"),
    lines: z.number().optional().describe("Number of lines to read"),
  },
  (params) => callGateway("/api/memory/get", params),
);

// --- Send tool ---

server.tool(
  "send_message",
  "Send a message to a channel (Telegram, Slack, etc.)",
  {
    channel: z.string().describe("Channel name (e.g. 'telegram', 'slack')"),
    chatId: z.string().describe("Chat/conversation ID to send to"),
    text: z.string().describe("Message text to send"),
  },
  (params) => callGateway("/api/send", params),
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
