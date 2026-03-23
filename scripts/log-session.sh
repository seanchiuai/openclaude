#!/usr/bin/env bash
set -euo pipefail

# SessionEnd hook: append session metadata to manifest file.
# Zero LLM work — just filesystem append for nightly cron to process later.
#
# Usage: log-session.sh <AGENT_DIR>
# Receives JSON on stdin from Claude Code SessionEnd hook:
#   {"session_id":"abc123","transcript_path":"/path/to/transcript.jsonl","cwd":"/working/dir"}
#
# Appends one JSONL line to <AGENT_DIR>/workspace/memory/sessions.jsonl:
#   {"timestamp":"2026-03-23T22:00:00Z","session_id":"abc123","transcript_path":"/path/to/transcript.jsonl"}

AGENT_DIR="${1:?Usage: log-session.sh <AGENT_DIR>}"

# Read stdin (hook input JSON)
INPUT=$(cat) || true

# Graceful exit on empty/missing stdin
if [[ -z "${INPUT:-}" ]]; then
  exit 0
fi

# Parse session_id and transcript_path
if command -v jq &>/dev/null; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT_PATH=""
else
  # grep fallback: extract JSON string values
  SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/"session_id":"//;s/"$//') || SESSION_ID=""
  TRANSCRIPT_PATH=$(echo "$INPUT" | grep -o '"transcript_path":"[^"]*"' | head -1 | sed 's/"transcript_path":"//;s/"$//') || TRANSCRIPT_PATH=""
fi

# Nothing to log if no session_id
if [[ -z "${SESSION_ID:-}" ]]; then
  exit 0
fi

# Ensure memory directory exists
MEMORY_DIR="$AGENT_DIR/workspace/memory"
mkdir -p "$MEMORY_DIR"

# Generate ISO 8601 timestamp
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Build and append JSONL line
if command -v jq &>/dev/null; then
  jq -cn \
    --arg ts "$TIMESTAMP" \
    --arg sid "$SESSION_ID" \
    --arg tp "${TRANSCRIPT_PATH:-}" \
    '{timestamp: $ts, session_id: $sid, transcript_path: $tp}' \
    >> "$MEMORY_DIR/sessions.jsonl"
else
  # Manual JSON construction (values are already simple strings from Claude Code)
  echo "{\"timestamp\":\"$TIMESTAMP\",\"session_id\":\"$SESSION_ID\",\"transcript_path\":\"${TRANSCRIPT_PATH:-}\"}" \
    >> "$MEMORY_DIR/sessions.jsonl"
fi
