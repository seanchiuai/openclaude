#!/usr/bin/env bash
set -euo pipefail

# Create a new OpenClaude agent from templates.
# Usage: setup.sh <agent-name> [hindsight-port]
# Note: sed -i usage is Linux-style. On macOS, use sed -i '' instead.

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

# Substitute placeholders in .mcp.json
sed -i '' "s|__AGENT_NAME__|$AGENT_NAME|g" "$AGENT_DIR/.claude/.mcp.json"
sed -i '' "s|__HINDSIGHT_PORT__|$HINDSIGHT_PORT|g" "$AGENT_DIR/.claude/.mcp.json"

# Substitute placeholders in settings.json
sed -i '' "s|__OPENCLAUDE_DIR__|$OPENCLAUDE_DIR|g" "$AGENT_DIR/.claude/settings.json"
sed -i '' "s|__AGENT_DIR__|$AGENT_DIR|g" "$AGENT_DIR/.claude/settings.json"
sed -i '' "s|__AGENT_NAME__|$AGENT_NAME|g" "$AGENT_DIR/.claude/settings.json"
sed -i '' "s|__HINDSIGHT_PORT__|$HINDSIGHT_PORT|g" "$AGENT_DIR/.claude/settings.json"

# Start Hindsight Docker container
echo "Starting Hindsight container..."
HINDSIGHT_IMAGE="ghcr.io/vectorize-io/hindsight:latest"

# Default to Ollama for entity resolution (fully local, no API keys)
HINDSIGHT_LLM_PROVIDER="${HINDSIGHT_LLM_PROVIDER:-ollama}"
HINDSIGHT_LLM_API_KEY="${HINDSIGHT_LLM_API_KEY:-}"

docker run -d \
  --name "hindsight-$AGENT_NAME" \
  --restart unless-stopped \
  -p "$HINDSIGHT_PORT:8888" \
  -e "HINDSIGHT_API_LLM_PROVIDER=$HINDSIGHT_LLM_PROVIDER" \
  -e "HINDSIGHT_API_LLM_API_KEY=$HINDSIGHT_LLM_API_KEY" \
  -v "$HOME/.hindsight-$AGENT_NAME:/home/hindsight/.pg0" \
  "$HINDSIGHT_IMAGE" 2>/dev/null || {
    echo "Warning: Could not start Hindsight container."
    echo "Start it manually:"
    echo "  docker run -d --name hindsight-$AGENT_NAME -p $HINDSIGHT_PORT:8888 \\"
    echo "    -e HINDSIGHT_API_LLM_PROVIDER=ollama \\"
    echo "    -v ~/.hindsight-$AGENT_NAME:/home/hindsight/.pg0 \\"
    echo "    $HINDSIGHT_IMAGE"
  }

echo ""
echo "Agent '$AGENT_NAME' created at $AGENT_DIR"
echo ""
echo "Next steps:"
echo "  1. Start a session:  cd $AGENT_DIR && claude"
echo "  2. Run /bootstrap to set up your agent's identity"
echo ""
echo "Telegram (choose one):"
echo "  Official:   cd $AGENT_DIR && claude --channels plugin:telegram@claude-plugins-official"
echo "  ClaudeClaw: cd $AGENT_DIR && claude  (then run /claudeclaw:start)"
echo ""
echo "Hindsight: http://localhost:$HINDSIGHT_PORT/docs"
