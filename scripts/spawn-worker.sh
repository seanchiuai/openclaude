#!/usr/bin/env bash
set -euo pipefail

# Spawn a claude -p worker from the agent directory.
# Workers run headless with MCP access (Hindsight) and agent identity.
#
# Usage: spawn-worker.sh <AGENT_DIR> <PROMPT> [--model MODEL] [--output FILE] [--background]
#
# Examples:
#   spawn-worker.sh ~/.openclaude/agents/nova "Refactor auth middleware"
#   spawn-worker.sh ~/.openclaude/agents/nova "Add tests" --model haiku --background
#   spawn-worker.sh ~/.openclaude/agents/nova "Research API" --output /tmp/result.txt

AGENT_DIR="${1:?Usage: spawn-worker.sh <AGENT_DIR> <PROMPT> [--model MODEL] [--output FILE] [--background]}"
PROMPT="${2:?Usage: spawn-worker.sh <AGENT_DIR> <PROMPT> [--model MODEL] [--output FILE] [--background]}"
shift 2

MODEL="claude-sonnet-4-6"
OUTPUT=""
BACKGROUND=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    --background) BACKGROUND=true; shift ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
done

# Validate agent directory
if [[ ! -d "$AGENT_DIR/.claude" ]]; then
  echo "Error: No .claude/ directory in $AGENT_DIR" >&2
  exit 1
fi

# Unset env vars that interfere with child claude processes
unset CLAUDECODE ANTHROPIC_API_KEY CLAUDE_API_KEY CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

# Run worker
if [[ "$BACKGROUND" == true ]]; then
  [[ -z "$OUTPUT" ]] && OUTPUT=$(mktemp "/tmp/openclaude-worker-$$.XXXXXXXX.json")
  (cd "$AGENT_DIR" && echo "$PROMPT" | claude -p --dangerously-skip-permissions --model "$MODEL" --output-format json > "$OUTPUT" 2>&1) &
  PID=$!
  disown "$PID" 2>/dev/null || true
  echo "{\"pid\":$PID,\"output\":\"$OUTPUT\"}"
elif [[ -n "$OUTPUT" ]]; then
  cd "$AGENT_DIR"
  echo "$PROMPT" | claude -p --dangerously-skip-permissions --model "$MODEL" --output-format json > "$OUTPUT" 2>&1
else
  cd "$AGENT_DIR"
  echo "$PROMPT" | claude -p --dangerously-skip-permissions --model "$MODEL" --output-format json
fi
