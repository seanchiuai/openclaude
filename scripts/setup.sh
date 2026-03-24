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

# ── Choose LLM provider for Hindsight entity resolution ──
HINDSIGHT_IMAGE="ghcr.io/vectorize-io/hindsight:latest"

# Allow env var override (non-interactive)
if [[ -n "${HINDSIGHT_LLM_PROVIDER:-}" ]]; then
  LLM_PROVIDER="$HINDSIGHT_LLM_PROVIDER"
  LLM_API_KEY="${HINDSIGHT_LLM_API_KEY:-}"
  LLM_BASE_URL="${HINDSIGHT_LLM_BASE_URL:-}"
  LLM_MODEL="${HINDSIGHT_LLM_MODEL:-}"
else
  echo ""
  echo "Hindsight needs an LLM for entity resolution."
  echo "Choose a provider:"
  echo ""
  echo "  1) ollama    — Local, no API key (requires ollama serve running)"
  echo "  2) lmstudio  — Local, no API key (requires LM Studio running)"
  echo "  3) groq      — Free tier, fast (needs API key from groq.com)"
  echo "  4) openai    — Paid (needs API key)"
  echo "  5) anthropic — Paid (needs API key)"
  echo "  6) skip      — Start without Hindsight (add later)"
  echo ""
  read -p "Choice [1-6]: " LLM_CHOICE

  LLM_API_KEY=""
  LLM_BASE_URL=""
  LLM_MODEL=""

  case "${LLM_CHOICE:-1}" in
    1)
      LLM_PROVIDER="ollama"
      LLM_BASE_URL="http://host.docker.internal:11434/v1"
      LLM_MODEL="llama3.2"
      ;;
    2)
      LLM_PROVIDER="lmstudio"
      LLM_BASE_URL="http://host.docker.internal:1234/v1"
      ;;
    3)
      LLM_PROVIDER="groq"
      read -p "Groq API key: " LLM_API_KEY
      ;;
    4)
      LLM_PROVIDER="openai"
      read -p "OpenAI API key: " LLM_API_KEY
      ;;
    5)
      LLM_PROVIDER="anthropic"
      read -p "Anthropic API key: " LLM_API_KEY
      ;;
    6)
      LLM_PROVIDER="skip"
      ;;
    *)
      echo "Invalid choice, defaulting to ollama"
      LLM_PROVIDER="ollama"
      LLM_BASE_URL="http://host.docker.internal:11434/v1"
      LLM_MODEL="llama3.2"
      ;;
  esac
fi

# Start Hindsight Docker container
if [[ "$LLM_PROVIDER" == "skip" ]]; then
  echo ""
  echo "Skipping Hindsight. Start it later with:"
  echo "  docker run -d --name hindsight-$AGENT_NAME -p $HINDSIGHT_PORT:8888 \\"
  echo "    --add-host host.docker.internal:host-gateway \\"
  echo "    -e HINDSIGHT_API_LLM_PROVIDER=<provider> \\"
  echo "    -v ~/.hindsight-$AGENT_NAME:/home/hindsight/.pg0 \\"
  echo "    $HINDSIGHT_IMAGE"
else
  echo ""
  echo "Starting Hindsight container (provider: $LLM_PROVIDER)..."

  DOCKER_ENV_ARGS=(
    -e "HINDSIGHT_API_LLM_PROVIDER=$LLM_PROVIDER"
  )
  [[ -n "$LLM_API_KEY" ]] && DOCKER_ENV_ARGS+=(-e "HINDSIGHT_API_LLM_API_KEY=$LLM_API_KEY")
  [[ -n "$LLM_BASE_URL" ]] && DOCKER_ENV_ARGS+=(-e "HINDSIGHT_API_LLM_BASE_URL=$LLM_BASE_URL")
  [[ -n "$LLM_MODEL" ]] && DOCKER_ENV_ARGS+=(-e "HINDSIGHT_API_LLM_MODEL=$LLM_MODEL")

  docker run -d \
    --name "hindsight-$AGENT_NAME" \
    --restart unless-stopped \
    --add-host host.docker.internal:host-gateway \
    -p "$HINDSIGHT_PORT:8888" \
    "${DOCKER_ENV_ARGS[@]}" \
    -v "$HOME/.hindsight-$AGENT_NAME:/home/hindsight/.pg0" \
    "$HINDSIGHT_IMAGE" 2>/dev/null || {
      echo "Warning: Could not start Hindsight container."
      echo "Check: docker logs hindsight-$AGENT_NAME"
    }
fi

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
