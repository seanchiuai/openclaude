#!/usr/bin/env node
/**
 * OpenClaude CLI entry point.
 * Commands: start, stop, status, setup, onboard
 */
import { parseArgs } from "node:util";

const { positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
});

const command = positionals[0];

switch (command) {
  case "start":
    await start();
    break;
  case "stop":
    await stop();
    break;
  case "status":
    await status();
    break;
  case "setup":
    await setup();
    break;
  case "onboard":
    await onboard();
    break;
  case "skills":
    if (positionals[1] === "list") {
      await skillsList();
    } else {
      printUsage();
    }
    break;
  case "memory":
    if (positionals[1] === "search" && positionals[2]) {
      await memorySearch(positionals.slice(2).join(" "));
    } else {
      printUsage();
    }
    break;
  case "logs":
    await tailLogs();
    break;
  case "gateway":
    if (positionals[1] === "run") {
      await gatewayRun();
    } else {
      printUsage();
    }
    break;
  default:
    printUsage();
}

async function start() {
  const { readPidFile } = await import("../gateway/lifecycle.js");
  const { resolveGatewayService } = await import("../gateway/service.js");

  const existingPid = readPidFile();
  if (existingPid) {
    console.log(`OpenClaude is already running (PID ${existingPid}).`);
    return;
  }

  const service = resolveGatewayService();
  if (service) {
    try {
      if (await service.isLoaded()) {
        console.log(`OpenClaude ${service.label} is already loaded.`);
        return;
      }
      const nodePath = process.execPath;
      const entryPath = new URL(import.meta.url).pathname;
      await service.install(nodePath, entryPath);
      console.log(`OpenClaude started as ${service.label}.`);
    } catch (err) {
      console.error(
        `Failed to install ${service.label}, starting in foreground:`,
        err,
      );
      await gatewayRun();
    }
  } else {
    // Unsupported platform: run in foreground
    await gatewayRun();
  }
}

async function stop() {
  const { resolveGatewayService } = await import("../gateway/service.js");
  const service = resolveGatewayService();

  if (service) {
    await service.stop();
    console.log("OpenClaude stop signal sent.");
    return;
  }

  const { readPidFile } = await import("../gateway/lifecycle.js");
  const pid = readPidFile();
  if (!pid) {
    console.log("OpenClaude is not running.");
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`OpenClaude stopped (PID ${pid}).`);
  } catch {
    console.log("OpenClaude is not running.");
  }
}

async function status() {
  const { readPidFile } = await import("../gateway/lifecycle.js");
  const { resolveGatewayService } = await import("../gateway/service.js");

  // Try service-level PID first, then fall back to PID file
  const service = resolveGatewayService();
  let pid = readPidFile();
  if (!pid && service) {
    pid = await service.readPid();
  }

  if (!pid) {
    console.log("OpenClaude is not running.");
    return;
  }

  console.log(`OpenClaude is running (PID ${pid}).`);

  // Try to fetch status from HTTP endpoint
  try {
    const DEFAULT_PORT = 45557;
    const rawPort = process.env.OPENCLAUDE_GATEWAY_PORT;
    let port = DEFAULT_PORT;
    if (rawPort) {
      const parsed = parseInt(rawPort, 10);
      if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
        console.error(`Invalid OPENCLAUDE_GATEWAY_PORT "${rawPort}", using default ${DEFAULT_PORT}`);
      } else {
        port = parsed;
      }
    }
    const resp = await fetch(`http://127.0.0.1:${port}/api/status`);
    if (resp.ok) {
      const data = await resp.json();
      console.log(
        `Uptime: ${Math.round((data as { uptime: number }).uptime / 1000)}s`,
      );
      console.log(
        `Channels: ${((data as { channels: string[] }).channels ?? []).join(", ") || "none"}`,
      );
      const pool = (data as { pool: { running: number; queued: number; maxConcurrent: number } })
        .pool;
      console.log(
        `Pool: ${pool.running}/${pool.maxConcurrent} running, ${pool.queued} queued`,
      );
    }
  } catch {
    // Gateway HTTP not reachable, that's ok
  }
}

async function onboard() {
  const { createClackPrompter } = await import("../wizard/clack-prompter.js");
  const { runOnboardingWizard } = await import("../wizard/onboarding.js");
  const { WizardCancelledError } = await import("../wizard/prompts.js");

  try {
    const result = await runOnboardingWizard(createClackPrompter());

    // If user chose to start, launch the gateway
    // (The wizard already printed the outro message)
    if (result.channels !== "none") {
      // Gateway start is handled by the start() function
    }
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      process.exit(1);
    }
    throw err;
  }
}

async function setup() {
  const { ensureDirectories, writeDefaultConfig } = await import(
    "../config/loader.js"
  );

  ensureDirectories();
  writeDefaultConfig();
  console.log("OpenClaude initialized.");
  const { paths } = await import("../config/paths.js");
  console.log(`Edit ${paths.config} to configure channels.`);
}

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

async function gatewayRun() {
  const { startGateway } = await import("../gateway/lifecycle.js");
  await startGateway();
  // Keep process alive
  await new Promise(() => {});
}

function printUsage() {
  console.log(`OpenClaude - Autonomous AI assistant powered by Claude Code CLI

Usage: openclaude <command>

Commands:
  start   Start the OpenClaude gateway daemon (LaunchAgent on macOS, systemd on Linux)
  stop    Stop the gateway daemon
  status  Show gateway status
  setup   Initialize config and directories (non-interactive)
  onboard Interactive setup wizard (recommended for first-time setup)
  skills list  List loaded skills
  memory search <query>  Search memory
  logs         Tail gateway logs

Internal:
  gateway run   Run gateway in foreground (used by LaunchAgent/systemd)
`);
}
