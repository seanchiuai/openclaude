---
name: cli
description: CLI commands for daemon lifecycle - start, stop, status, setup, logs
---

# CLI - Command-Line Interface

User-facing CLI commands for managing the OpenClaude daemon and utilities.

## When to Use This Skill

- Adding new CLI commands
- Modifying daemon lifecycle commands
- Working with the CLI entry point

## Key Files

- `src/cli/index.ts` - CLI commands and argument parsing

## Commands

| Command | Purpose |
|---------|---------|
| `openclaude start` | Install LaunchAgent (macOS) or run foreground |
| `openclaude stop` | Stop daemon |
| `openclaude status` | Show uptime, channels, pool stats |
| `openclaude setup` | Initialize ~/.openclaude structure |
| `openclaude skills list` | List loaded skills |
| `openclaude memory search <query>` | Search memory from CLI |
| `openclaude logs` | Tail gateway.log |
| `openclaude gateway run` | Internal: foreground gateway run |

## Key Patterns

- Dynamic imports for fast startup — lazy-loads subsystems only when needed
- `start` installs a macOS LaunchAgent via `gateway/launchd.ts`
- `gateway run` is the internal command used by the LaunchAgent plist
- `status` queries the HTTP API at port 45557

## OpenClaw Reference

**CLI was adapted from OpenClaw's daemon management.** OpenClaw has a more complex CLI with wizard, install scripts, and multi-platform support.

**Source:** `openclaw-source/src/cli/` and `openclaw-source/src/daemon/`

**Copy-first workflow:**
1. Find the CLI command in `openclaw-source/src/cli/` or `openclaw-source/src/daemon/`
2. Copy the command structure and argument parsing
3. Strip multi-platform (Linux systemd, Docker), wizard, and install-script logic
4. Adapt for macOS-only launchd and simpler daemon lifecycle
5. Rename any "openclaw" references to "openclaude"
