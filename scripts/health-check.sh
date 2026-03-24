#!/usr/bin/env bash
set -euo pipefail

AGENT_NAME="${1:?Usage: health-check.sh AGENT_NAME HINDSIGHT_PORT}"
HINDSIGHT_PORT="${2:?Usage: health-check.sh AGENT_NAME HINDSIGHT_PORT}"

# Check Hindsight
if ! curl -sf "http://localhost:${HINDSIGHT_PORT}/docs" > /dev/null 2>&1; then
  if ! command -v docker &>/dev/null; then
    echo "Hindsight for ${AGENT_NAME} is down (Docker not installed)" >&2
  elif ! docker info &>/dev/null 2>&1; then
    echo "Hindsight for ${AGENT_NAME} is down (Docker daemon not running)" >&2
  else
    echo "Hindsight for ${AGENT_NAME} was down, restarted" >&2
    docker restart "hindsight-${AGENT_NAME}" >/dev/null 2>&1 || true
  fi
fi

# Check ClaudeClaw PID file
PID_FILE="$HOME/.openclaude/agents/${AGENT_NAME}/.claudeclaw.pid"
if [[ -f "$PID_FILE" ]]; then
  PID=$(cat "$PID_FILE")
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "ClaudeClaw for ${AGENT_NAME} is not running" >&2
  fi
fi
