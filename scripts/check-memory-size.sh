#!/usr/bin/env bash
set -euo pipefail

# PreToolUse hook: enforce MEMORY.md 50-line cap.
# Reads tool input JSON from stdin. Blocks Write/Edit if MEMORY.md
# would exceed the line limit.

MAX_LINES=50

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"file_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//')

# Only check MEMORY.md
if [[ "$FILE_PATH" != *MEMORY.md ]]; then
  exit 0
fi

# Check if file exists and count lines
if [[ -f "$FILE_PATH" ]]; then
  LINE_COUNT=$(wc -l < "$FILE_PATH")
  if (( LINE_COUNT >= MAX_LINES )); then
    echo "BLOCKED: MEMORY.md is at $LINE_COUNT lines (cap: $MAX_LINES). Curate existing content before adding more."
    exit 1
  fi
fi

exit 0
