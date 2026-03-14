import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createGatewayApp, startHttpServer } from "../gateway/http.js";
import { createProcessPool } from "../engine/pool.js";
import { createTestContext } from "../../test/helpers/test-context.js";
import { call, sendNotification } from "../../test/helpers/json-rpc.js";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

describe("MCP gateway-tools-server integration", () => {
  const ctx = createTestContext("mcp-gateway");
  let server: Server;
  let gatewayUrl: string;
  let mcpProc: ChildProcess;

  beforeAll(async () => {
    // Start a real gateway HTTP server with cron stubs
    const pool = createProcessPool(1);
    const app = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
      cronService: {
        list: () => [],
        status: () => ({ running: false, jobCount: 0 }),
        add: () => ({ id: "test", name: "test" }),
        remove: () => true,
        run: async () => ({ ok: true }),
      } as never,
    });

    server = startHttpServer(app, 0) as unknown as Server;
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    gatewayUrl = `http://127.0.0.1:${addr.port}`;
    ctx.log(`Gateway listening on ${gatewayUrl}`);
  });

  afterEach(() => {
    if (mcpProc && !mcpProc.killed) {
      mcpProc.kill();
    }
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });

  function spawnMcp(): ChildProcess {
    const proc = spawn("npx", ["tsx", "src/mcp/gateway-tools-server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        GATEWAY_URL: gatewayUrl,
        GATEWAY_TOKEN: "",
        CHILD_MODE: "false",
        OPENCLAUDE_SESSION_ID: "test-session",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("exit", (code) => {
      ctx.log(`MCP process exited with code ${code}`);
      if (stderr) ctx.log(`MCP stderr: ${stderr}`);
    });

    mcpProc = proc;
    return proc;
  }

  async function initializeMcp(proc: ChildProcess) {
    // MCP initialize handshake
    const initRes = await call(proc, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.1.0" },
    }, 1, 10_000);

    expect(initRes.error).toBeUndefined();
    expect(initRes.result).toBeDefined();

    // Send initialized notification (no id = notification, no response expected)
    sendNotification(proc, "notifications/initialized");

    return initRes;
  }

  it("lists expected tools after initialization", async () => {
    ctx.dumpOnFailure();
    const proc = spawnMcp();

    await initializeMcp(proc);

    const listRes = await call(proc, "tools/list", {}, 2, 5000);
    expect(listRes.error).toBeUndefined();

    const result = listRes.result as { tools: Array<{ name: string }> };
    const toolNames = result.tools.map((t) => t.name).sort();

    expect(toolNames).toContain("cron_list");
    expect(toolNames).toContain("cron_status");
    expect(toolNames).toContain("cron_add");
    expect(toolNames).toContain("cron_remove");
    expect(toolNames).toContain("cron_run");
    expect(toolNames).toContain("memory_search");
    expect(toolNames).toContain("memory_get");
    expect(toolNames).toContain("logs_tail");
    expect(toolNames).toContain("send_message");
    expect(toolNames).toContain("sessions_spawn");
    expect(toolNames).toContain("sessions_status");
  });

  it("calls cron_list tool and gets empty list from gateway", async () => {
    ctx.dumpOnFailure();
    const proc = spawnMcp();

    await initializeMcp(proc);

    const toolRes = await call(proc, "tools/call", {
      name: "cron_list",
      arguments: {},
    }, 3, 5000);

    expect(toolRes.error).toBeUndefined();

    const result = toolRes.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0].type).toBe("text");

    // The gateway should return the cron list (empty array from our stub)
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.jobs).toEqual([]);
  });
});
