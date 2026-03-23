#!/usr/bin/env bash
set -euo pipefail

TARBALL_PATH="${1:?Usage: import-agent.sh TARBALL_PATH}"

# Validate tarball exists
if [[ ! -f "$TARBALL_PATH" ]]; then
  echo "Error: Tarball not found: ${TARBALL_PATH}" >&2
  exit 1
fi

# Create temp directory with cleanup trap
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Extract to temp directory for inspection
tar -xzf "$TARBALL_PATH" -C "$TMPDIR"

# Find agent name from directory structure
AGENT_NAME=$(ls "${TMPDIR}/agents/" 2>/dev/null | head -1)
if [[ -z "$AGENT_NAME" ]]; then
  echo "Error: Could not determine agent name from tarball contents" >&2
  exit 1
fi

AGENT_DIR="$HOME/.openclaude/agents/${AGENT_NAME}"

# Check if agent already exists
if [[ -d "$AGENT_DIR" ]]; then
  echo "Error: Agent already exists at ${AGENT_DIR}. Remove it first or choose a different name." >&2
  exit 1
fi

# Install agent directory
mkdir -p "$HOME/.openclaude/agents"
cp -a "${TMPDIR}/agents/${AGENT_NAME}" "$AGENT_DIR"

# Restore Hindsight data if present
CONTAINER="hindsight-${AGENT_NAME}"
if [[ -d "${TMPDIR}/hindsight-data" ]]; then
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    if docker cp "${TMPDIR}/hindsight-data/" "${CONTAINER}:/app/data/" 2>/dev/null; then
      echo "Restored Hindsight data to ${CONTAINER}" >&2
    else
      echo "Warning: Could not restore Hindsight data to container" >&2
    fi
  else
    echo "Hindsight container not running. Restore data manually from the tarball's hindsight-data/ directory." >&2
  fi
fi

cat <<EOF
Imported ${AGENT_NAME} to ~/.openclaude/agents/${AGENT_NAME}

Next steps:
1. Start Hindsight: docker run -d --name hindsight-${AGENT_NAME} ...
2. Configure ClaudeClaw with your Telegram bot token
3. Test: cd ~/.openclaude/agents/${AGENT_NAME} && claude
EOF
