#!/usr/bin/env bash
set -euo pipefail

# Create a new OpenClaude agent from templates.
# Usage: setup.sh <agent-name> [hindsight-port]
#
# This script only scaffolds the directory structure.
# All interactive setup (Docker, LLM provider, API keys) happens
# inside Claude Code via the /bootstrap skill.

AGENT_NAME="${1:-}"
HINDSIGHT_PORT="${2:-8888}"

if [[ -z "$AGENT_NAME" ]]; then
  echo "Usage: setup.sh <agent-name> [hindsight-port]"
  echo "  agent-name      Name for the new agent (e.g. nova)"
  echo "  hindsight-port  Port for Hindsight MCP server (default: 8888)"
  exit 1
fi

OPENCLAUDE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$HOME/.openclaude/agents/$AGENT_NAME"

if [[ -d "$AGENT_DIR" ]]; then
  echo "Error: Agent '$AGENT_NAME' already exists at $AGENT_DIR"
  exit 1
fi

# Create directory structure
mkdir -p "$AGENT_DIR"/{.claude,workspace/memory}

# Copy templates (glob doesn't match dotfiles, so .mcp.json needs explicit copy)
cp -r "$OPENCLAUDE_DIR/templates/claude/"* "$AGENT_DIR/.claude/"
cp -r "$OPENCLAUDE_DIR/templates/claude/.mcp.json" "$AGENT_DIR/.claude/"
cp -r "$OPENCLAUDE_DIR/templates/workspace/"* "$AGENT_DIR/workspace/"

# Copy ClaudeClaw config (heartbeat, prompts)
if [[ -d "$OPENCLAUDE_DIR/templates/claude/claudeclaw" ]]; then
  cp -r "$OPENCLAUDE_DIR/templates/claude/claudeclaw" "$AGENT_DIR/.claude/claudeclaw"
fi

# Substitute placeholders in .mcp.json
sed -i '' "s|__AGENT_NAME__|$AGENT_NAME|g" "$AGENT_DIR/.claude/.mcp.json"
sed -i '' "s|__HINDSIGHT_PORT__|$HINDSIGHT_PORT|g" "$AGENT_DIR/.claude/.mcp.json"

# Substitute placeholders in settings.json
sed -i '' "s|__OPENCLAUDE_DIR__|$OPENCLAUDE_DIR|g" "$AGENT_DIR/.claude/settings.json"
sed -i '' "s|__AGENT_DIR__|$AGENT_DIR|g" "$AGENT_DIR/.claude/settings.json"
sed -i '' "s|__AGENT_NAME__|$AGENT_NAME|g" "$AGENT_DIR/.claude/settings.json"
sed -i '' "s|__HINDSIGHT_PORT__|$HINDSIGHT_PORT|g" "$AGENT_DIR/.claude/settings.json"

echo ""
echo "Agent '$AGENT_NAME' scaffolded at $AGENT_DIR"
echo ""
echo "Next steps:"
echo "  1. Start a session:  cd $AGENT_DIR && claude"
echo "  2. Run /bootstrap    — sets up Docker, Hindsight, API keys, identity, everything"
echo ""
