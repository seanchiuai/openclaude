#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="${1:?Usage: export-agent.sh AGENT_NAME [OUTPUT_PATH]}"
AGENT_DIR="$HOME/.openclaude/agents/${AGENT_NAME}"
DATE=$(date +%Y-%m-%d)
OUTPUT_PATH="${2:-./${AGENT_NAME}-export-${DATE}.tar.gz}"

# Validate agent directory
if [[ ! -d "$AGENT_DIR" ]]; then
  echo "Error: Agent directory not found: ${AGENT_DIR}" >&2
  exit 1
fi

# Create temp directory with cleanup trap
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Copy agent directory
mkdir -p "${TMPDIR}/agents"
cp -a "$AGENT_DIR" "${TMPDIR}/agents/${AGENT_NAME}"

# Attempt to dump Hindsight data from Docker
CONTAINER="hindsight-${AGENT_NAME}"
if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  if docker cp "${CONTAINER}:/app/data/" "${TMPDIR}/hindsight-data/" 2>/dev/null; then
    echo "Included Hindsight data in export" >&2
  else
    echo "Warning: Could not copy Hindsight data, continuing without it" >&2
  fi
else
  echo "Warning: Hindsight container ${CONTAINER} not found, exporting without DB" >&2
fi

# Create tarball
tar -czf "$OUTPUT_PATH" -C "$TMPDIR" .

SIZE=$(du -h "$OUTPUT_PATH" | cut -f1)

cat <<EOF
Exported ${AGENT_NAME} to ${OUTPUT_PATH}
Size: ${SIZE}

NOT included (configure manually after import):
- Telegram bot token
- API keys
- ClaudeClaw configuration
EOF
