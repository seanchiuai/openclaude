#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   health-check.sh                     # Check all agents
#   health-check.sh AGENT_NAME PORT     # Check a single agent (legacy)

AGENTS_DIR="$HOME/.openclaude/agents"

check_agent() {
  local agent_name="$1"
  local hindsight_port="$2"
  local agent_dir="$AGENTS_DIR/$agent_name"
  local status_parts=()

  # Hindsight
  if curl -sf "http://localhost:${hindsight_port}/docs" > /dev/null 2>&1; then
    status_parts+=("Hindsight: healthy")
  elif ! command -v docker &>/dev/null; then
    status_parts+=("Hindsight: DOWN (Docker not installed)")
  elif ! docker info &>/dev/null 2>&1; then
    status_parts+=("Hindsight: DOWN (Docker daemon not running)")
  else
    status_parts+=("Hindsight: DOWN (restarting...)")
    docker restart "hindsight-${agent_name}" >/dev/null 2>&1 || true
  fi

  # ClaudeClaw
  local pid_file="$agent_dir/.claudeclaw.pid"
  if [[ -f "$pid_file" ]]; then
    local pid
    pid=$(cat "$pid_file")
    if kill -0 "$pid" 2>/dev/null; then
      status_parts+=("ClaudeClaw: running (PID $pid)")
    else
      status_parts+=("ClaudeClaw: DOWN (stale PID $pid)")
    fi
  else
    status_parts+=("ClaudeClaw: not configured")
  fi

  # MEMORY.md line count
  local memory_file="$agent_dir/workspace/MEMORY.md"
  if [[ -f "$memory_file" ]]; then
    local lines
    lines=$(wc -l < "$memory_file" | tr -d ' ')
    status_parts+=("MEMORY.md: ${lines}/50 lines")
  else
    status_parts+=("MEMORY.md: missing")
  fi

  # Print report
  echo "$agent_name (port $hindsight_port)"
  for part in "${status_parts[@]}"; do
    echo "  $part"
  done
}

get_port_from_mcp() {
  local agent_dir="$1"
  local mcp_file="$agent_dir/.claude/.mcp.json"
  if [[ -f "$mcp_file" ]]; then
    # Extract port from URL like http://localhost:8888/mcp/...
    sed -n 's|.*localhost:\([0-9]*\)/.*|\1|p' "$mcp_file" | head -1
  fi
}

# Single-agent mode (legacy)
if [[ $# -ge 2 ]]; then
  check_agent "$1" "$2"
  exit 0
fi

# All-agents mode
if [[ ! -d "$AGENTS_DIR" ]]; then
  echo "No agents directory found at $AGENTS_DIR"
  exit 1
fi

agents_found=false
echo "OpenClaude Agent Status"
echo "━━━━━━━━━━━━━━━━━━━━━━"
for agent_dir in "$AGENTS_DIR"/*/; do
  [[ -d "$agent_dir" ]] || continue
  agent_name=$(basename "$agent_dir")
  port=$(get_port_from_mcp "$agent_dir")
  if [[ -z "$port" ]]; then
    echo "$agent_name"
    echo "  Hindsight: unknown (no .mcp.json)"
    continue
  fi
  agents_found=true
  check_agent "$agent_name" "$port"
done

if [[ "$agents_found" == false ]]; then
  echo "No agents found in $AGENTS_DIR"
fi
