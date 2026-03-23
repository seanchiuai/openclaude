#!/usr/bin/env bash
set -euo pipefail

# Stop hook: extract key facts from the most recent Claude Code session
# transcript and retain them in Hindsight semantic memory.
#
# Usage: auto-retain.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>

AGENT_DIR="${1:?Usage: auto-retain.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"
AGENT_NAME="${2:?Usage: auto-retain.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"
HINDSIGHT_PORT="${3:?Usage: auto-retain.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"

TIMESTAMP_FILE="/tmp/.openclaude-last-retain-$AGENT_NAME"
LOG_DIR="$AGENT_DIR/workspace/memory"
LOG_FILE="$LOG_DIR/retain.log"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Find the most recent session transcript
if [[ -f "$TIMESTAMP_FILE" ]]; then
  TRANSCRIPT=$(find ~/.claude/projects/ -name "*.jsonl" -newer "$TIMESTAMP_FILE" 2>/dev/null | head -1)
else
  TRANSCRIPT=$(find ~/.claude/projects/ -name "*.jsonl" 2>/dev/null | sort -t/ -k1 | tail -1)
fi

if [[ -z "${TRANSCRIPT:-}" || ! -f "${TRANSCRIPT:-}" ]]; then
  log "No new transcript found, skipping."
  exit 0
fi

# Check that claude CLI is available
if ! command -v claude &>/dev/null; then
  log "WARNING: claude CLI not found, skipping retention."
  exit 0
fi

# Extract tail of transcript to avoid huge inputs
CONTENT=$(tail -c 50000 "$TRANSCRIPT")

EXTRACTION_PROMPT="Extract key facts, decisions, preferences, and outcomes from this conversation transcript. Return one fact per line, no numbering, no bullets. Only include facts worth remembering long-term. Skip trivial or procedural details.

<transcript>
$CONTENT
</transcript>"

# Unset env vars that interfere with spawning a child claude process
unset CLAUDECODE ANTHROPIC_API_KEY CLAUDE_API_KEY CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

# Spawn Haiku to extract facts
FACTS=$(echo "$EXTRACTION_PROMPT" | claude -p --model claude-haiku-4-5-20251001 --output-format json 2>/dev/null) || {
  log "WARNING: claude extraction failed, skipping retention."
  exit 0
}

# Parse the result from the JSON output (array of events, last "result" type has the text)
if command -v jq &>/dev/null; then
  FACT_TEXT=$(echo "$FACTS" | jq -r 'if type == "array" then [.[] | select(.type == "result")] | last | .result // empty else . end' 2>/dev/null) || FACT_TEXT="$FACTS"
else
  # Fallback: try to use the raw output
  FACT_TEXT="$FACTS"
fi

if [[ -z "${FACT_TEXT:-}" ]]; then
  log "No facts extracted from transcript."
  touch "$TIMESTAMP_FILE"
  exit 0
fi

# Check if Hindsight is reachable
if ! curl -sf "http://localhost:$HINDSIGHT_PORT/docs" &>/dev/null; then
  log "WARNING: Hindsight not reachable at port $HINDSIGHT_PORT, skipping retention."
  exit 0
fi

# Retain each fact in Hindsight
RETAINED=0
FAILED=0
while IFS= read -r FACT; do
  # Skip empty lines
  [[ -z "${FACT// /}" ]] && continue

  # JSON-escape the fact
  if command -v jq &>/dev/null; then
    ESCAPED=$(echo "$FACT" | jq -Rs '.' 2>/dev/null | sed 's/^"//;s/"$//') || ESCAPED=$(echo "$FACT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
  else
    ESCAPED=$(echo "$FACT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
  fi

  if curl -sf -X POST "http://localhost:$HINDSIGHT_PORT/v1/default/banks/$AGENT_NAME/memories" \
    -H "Content-Type: application/json" \
    -d "{\"items\": [{\"content\": \"$ESCAPED\"}]}" &>/dev/null; then
    RETAINED=$((RETAINED + 1))
  else
    FAILED=$((FAILED + 1))
  fi
done <<< "$FACT_TEXT"

touch "$TIMESTAMP_FILE"
log "Retained $RETAINED facts ($FAILED failed) from $TRANSCRIPT"
