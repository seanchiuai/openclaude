#!/usr/bin/env bash
set -euo pipefail

# Remove an OpenClaude agent.
# Usage: uninstall.sh <agent-name> [--remove-data]

AGENT_NAME="${1:-}"
REMOVE_DATA=false

if [[ -z "$AGENT_NAME" ]]; then
  echo "Usage: uninstall.sh <agent-name> [--remove-data]"
  echo "  --remove-data   Also remove Hindsight container and data"
  exit 1
fi

# Check for --remove-data flag in any position
for arg in "$@"; do
  [[ "$arg" == "--remove-data" ]] && REMOVE_DATA=true
done

AGENT_DIR="$HOME/.openclaude/agents/$AGENT_NAME"

if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Error: Agent '$AGENT_NAME' not found at $AGENT_DIR"
  exit 1
fi

echo "This will remove $AGENT_DIR"
read -p "Continue? [y/N] " confirm
if [[ "$confirm" != [yY] ]]; then
  echo "Aborted."
  exit 0
fi

rm -rf "$AGENT_DIR"

if [[ "$REMOVE_DATA" == true ]]; then
  docker rm -f "hindsight-$AGENT_NAME" 2>/dev/null || true
  rm -rf "$HOME/.hindsight-$AGENT_NAME"
  echo "Removed Hindsight container and data for $AGENT_NAME"
fi

echo "Agent '$AGENT_NAME' uninstalled."
