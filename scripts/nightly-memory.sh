#!/usr/bin/env bash
set -euo pipefail

# Nightly cron: process unprocessed session transcripts and generate daily log.
#
# Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>
#
# Phase 1: Read sessions.jsonl manifest, extract facts from new transcripts via Haiku,
#           POST facts to Hindsight.
# Phase 2: Query Hindsight for today's memories, generate markdown daily log.

AGENT_DIR="${1:?Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"
AGENT_NAME="${2:?Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"
HINDSIGHT_PORT="${3:?Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"

MEMORY_DIR="$AGENT_DIR/workspace/memory"
MANIFEST="$MEMORY_DIR/sessions.jsonl"
MARKER="$MEMORY_DIR/.last-nightly"
LOG_FILE="$MEMORY_DIR/nightly.log"
TODAY=$(date '+%Y-%m-%d')
DAILY_LOG="$MEMORY_DIR/$TODAY.md"
HINDSIGHT_BASE="http://localhost:$HINDSIGHT_PORT"

mkdir -p "$MEMORY_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

log "=== Nightly memory run started ==="

# ─── Phase 1: Process unprocessed transcripts ───

if [[ ! -f "$MANIFEST" ]]; then
  log "No manifest file found at $MANIFEST — nothing to process"
else
  # Check if claude CLI is available
  if ! command -v claude &>/dev/null; then
    log "claude CLI not found — skipping transcript processing"
  else
    # Determine which entries to process
    ENTRIES=""
    if [[ -f "$MARKER" ]]; then
      # Get marker mtime as epoch seconds
      if [[ "$(uname)" == "Darwin" ]]; then
        MARKER_MTIME=$(stat -f '%m' "$MARKER")
      else
        MARKER_MTIME=$(stat -c '%Y' "$MARKER")
      fi

      # Filter manifest entries: only those with timestamp after marker mtime
      # Read each line from manifest
      while IFS= read -r line; do
        # Extract timestamp from JSONL line
        if command -v jq &>/dev/null; then
          ENTRY_TS=$(echo "$line" | jq -r '.timestamp // empty' 2>/dev/null) || ENTRY_TS=""
        else
          ENTRY_TS=$(echo "$line" | grep -o '"timestamp":"[^"]*"' | head -1 | sed 's/"timestamp":"//;s/"$//') || ENTRY_TS=""
        fi

        if [[ -z "$ENTRY_TS" ]]; then
          continue
        fi

        # Convert entry timestamp to epoch for comparison
        ENTRY_EPOCH=$(date -jf '%Y-%m-%dT%H:%M:%SZ' "$ENTRY_TS" '+%s' 2>/dev/null) || \
          ENTRY_EPOCH=$(date -d "$ENTRY_TS" '+%s' 2>/dev/null) || \
          ENTRY_EPOCH=0

        if [[ "$ENTRY_EPOCH" -gt "$MARKER_MTIME" ]]; then
          ENTRIES="${ENTRIES}${line}"$'\n'
        fi
      done < "$MANIFEST"
    else
      # No marker — process all entries
      ENTRIES=$(cat "$MANIFEST")
    fi

    # Process each entry
    PROCESSED=0
    SKIPPED=0
    if [[ -n "${ENTRIES:-}" ]]; then
      while IFS= read -r line; do
        [[ -z "$line" ]] && continue

        # Extract transcript_path
        if command -v jq &>/dev/null; then
          TRANSCRIPT=$(echo "$line" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT=""
          SESSION_ID=$(echo "$line" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
        else
          TRANSCRIPT=$(echo "$line" | grep -o '"transcript_path":"[^"]*"' | head -1 | sed 's/"transcript_path":"//;s/"$//') || TRANSCRIPT=""
          SESSION_ID=$(echo "$line" | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/"session_id":"//;s/"$//') || SESSION_ID=""
        fi

        # Skip if transcript doesn't exist
        if [[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]]; then
          log "Transcript not found, skipping: ${TRANSCRIPT:-<empty>} (session: ${SESSION_ID:-unknown})"
          SKIPPED=$((SKIPPED + 1))
          continue
        fi

        log "Processing session $SESSION_ID: $TRANSCRIPT"

        # Read last 50KB of transcript
        CONTENT=$(tail -c 50000 "$TRANSCRIPT" 2>/dev/null) || CONTENT=""
        if [[ -z "$CONTENT" ]]; then
          log "Empty transcript, skipping: $TRANSCRIPT"
          SKIPPED=$((SKIPPED + 1))
          continue
        fi

        # Build extraction prompt
        PROMPT="Extract important facts, decisions, and preferences from this session transcript. Return one fact per line, no bullets or numbering. Only include genuinely useful information worth remembering long-term.

Transcript:
$CONTENT"

        # Spawn Haiku to extract facts (unset env vars first)
        FACTS=$(unset CLAUDECODE ANTHROPIC_API_KEY CLAUDE_API_KEY CLAUDE_CODE_ENTRYPOINT 2>/dev/null; \
          echo "$PROMPT" | claude -p --model claude-haiku-4-5-20251001 --output-format json 2>/dev/null) || FACTS=""

        if [[ -z "$FACTS" ]]; then
          log "Claude returned empty response for session $SESSION_ID"
          continue
        fi

        # Parse result from JSON response
        if command -v jq &>/dev/null; then
          RESULT=$(echo "$FACTS" | jq -r '[.[] | select(.type == "result")] | last | .result // empty' 2>/dev/null) || RESULT=""
        else
          RESULT=$(echo "$FACTS" | sed 's/.*"result":"//' | sed 's/"}].*//' | sed 's/\\n/\n/g') || RESULT=""
        fi

        if [[ -z "$RESULT" ]]; then
          log "No facts extracted for session $SESSION_ID"
          continue
        fi

        # POST each fact to Hindsight
        FACT_COUNT=0
        while IFS= read -r fact; do
          [[ -z "$fact" ]] && continue

          # JSON-escape the fact
          if command -v jq &>/dev/null; then
            ESCAPED=$(echo "$fact" | jq -Rs '.' 2>/dev/null) || ESCAPED="\"$fact\""
          else
            ESCAPED="\"$(echo "$fact" | sed 's/"/\\"/g')\""
          fi

          curl -sf -X POST \
            "$HINDSIGHT_BASE/v1/default/banks/$AGENT_NAME/memories/retain" \
            -H "Content-Type: application/json" \
            -d "{\"items\":[{\"content\":$ESCAPED}]}" \
            >> "$LOG_FILE" 2>&1 || log "Failed to POST fact to Hindsight"

          FACT_COUNT=$((FACT_COUNT + 1))
        done <<< "$RESULT"

        log "Retained $FACT_COUNT facts from session $SESSION_ID"
        PROCESSED=$((PROCESSED + 1))
      done <<< "$ENTRIES"
    fi

    log "Phase 1 complete: processed=$PROCESSED skipped=$SKIPPED"
  fi
fi

# ─── Phase 2: Generate daily log ───

if [[ -f "$DAILY_LOG" ]]; then
  log "Daily log already exists: $DAILY_LOG — skipping"
else
  if ! command -v claude &>/dev/null; then
    log "claude CLI not found — skipping daily log generation"
  else
    # Query Hindsight for today's memories
    MEMORIES=$(curl -sf -X POST "$HINDSIGHT_BASE/v1/default/banks/$AGENT_NAME/memories/recall" \
      -H "Content-Type: application/json" \
      -d "{\"query\":\"events on $TODAY\",\"limit\":50}" 2>/dev/null) || MEMORIES=""

    if [[ -z "$MEMORIES" ]]; then
      log "No memories returned from Hindsight for $TODAY — skipping daily log"
    else
      # Build daily log prompt
      LOG_PROMPT="Given these memories from today ($TODAY), create a concise markdown daily log with these sections:
## Summary
## Key Facts
## Decisions
## Open Items

Only include sections that have content. Be concise and factual.

Memories:
$MEMORIES"

      # Spawn Haiku to generate daily log
      RAW_LOG=$(unset CLAUDECODE ANTHROPIC_API_KEY CLAUDE_API_KEY CLAUDE_CODE_ENTRYPOINT 2>/dev/null; \
        echo "$LOG_PROMPT" | claude -p --model claude-haiku-4-5-20251001 --output-format json 2>/dev/null) || RAW_LOG=""

      if [[ -z "$RAW_LOG" ]]; then
        log "Claude returned empty response for daily log"
      else
        # Parse result
        if command -v jq &>/dev/null; then
          DAILY_CONTENT=$(echo "$RAW_LOG" | jq -r '[.[] | select(.type == "result")] | last | .result // empty' 2>/dev/null) || DAILY_CONTENT=""
        else
          DAILY_CONTENT=$(echo "$RAW_LOG" | sed 's/.*"result":"//' | sed 's/"}].*//' | sed 's/\\n/\n/g') || DAILY_CONTENT=""
        fi

        if [[ -n "$DAILY_CONTENT" ]]; then
          echo "# Daily Log — $TODAY" > "$DAILY_LOG"
          echo "" >> "$DAILY_LOG"
          echo "$DAILY_CONTENT" >> "$DAILY_LOG"
          log "Daily log written to $DAILY_LOG"
        else
          log "Empty result from Claude for daily log"
        fi
      fi
    fi
  fi
fi

# Touch marker file
touch "$MARKER"

log "=== Nightly memory run complete ==="
exit 0
