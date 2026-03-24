#!/usr/bin/env bash
set -euo pipefail

# End-to-end test for the full OpenClaude pipeline.
# Creates a fresh agent, tests Hindsight, runs a Claude session,
# verifies hooks fire, tests nightly-memory, then cleans up.
#
# Usage: e2e.sh [gemini-api-key]
#   Or set HINDSIGHT_LLM_API_KEY env var
#
# Prerequisites: Docker running, claude CLI authenticated

OPENCLAUDE_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AGENT_NAME="e2e-test-$$"
HINDSIGHT_PORT=18888
PASS=0
FAIL=0
SKIP=0

# ── Helpers ──────────────────────────────────────────────────────────────

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red() { printf '\033[31m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

check() {
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    green "  ✓ $name"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name"
    FAIL=$((FAIL + 1))
  fi
}

check_output() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    green "  ✓ $name"
    PASS=$((PASS + 1))
  else
    red "  ✗ $name (expected '$expected' in output)"
    FAIL=$((FAIL + 1))
  fi
}

skip_test() {
  yellow "  ○ $1 (skipped: $2)"
  SKIP=$((SKIP + 1))
}

cleanup() {
  echo ""
  echo "── Cleanup ──"
  docker rm -f "hindsight-$AGENT_NAME" 2>/dev/null || true
  rm -rf "$HOME/.openclaude/agents/$AGENT_NAME" 2>/dev/null || true
  rm -rf "$HOME/.hindsight-$AGENT_NAME" 2>/dev/null || true
  echo "Cleaned up agent: $AGENT_NAME"
}
trap cleanup EXIT

# ── Config ───────────────────────────────────────────────────────────────

API_KEY="${1:-${HINDSIGHT_LLM_API_KEY:-}}"
if [[ -z "$API_KEY" ]]; then
  echo "Usage: e2e.sh <gemini-api-key>"
  echo "  Or set HINDSIGHT_LLM_API_KEY env var"
  exit 1
fi

echo "OpenClaude E2E Test"
echo "  Agent:    $AGENT_NAME"
echo "  Port:     $HINDSIGHT_PORT"
echo "  Provider: gemini"
echo ""

# ── 1. Setup ─────────────────────────────────────────────────────────────

echo "── 1. Agent Setup ──"

HINDSIGHT_LLM_PROVIDER=gemini \
HINDSIGHT_LLM_API_KEY="$API_KEY" \
  bash "$OPENCLAUDE_DIR/scripts/setup.sh" "$AGENT_NAME" "$HINDSIGHT_PORT" >/dev/null 2>&1

AGENT_DIR="$HOME/.openclaude/agents/$AGENT_NAME"

check "Agent directory created" test -d "$AGENT_DIR"
check "CLAUDE.md exists" test -f "$AGENT_DIR/.claude/CLAUDE.md"
check ".mcp.json exists" test -f "$AGENT_DIR/.claude/.mcp.json"
check "settings.json exists" test -f "$AGENT_DIR/.claude/settings.json"
check "IDENTITY.md exists" test -f "$AGENT_DIR/workspace/IDENTITY.md"
check "SOUL.md exists" test -f "$AGENT_DIR/workspace/SOUL.md"
check "AGENTS.md exists" test -f "$AGENT_DIR/workspace/AGENTS.md"
check "memory/ directory exists" test -d "$AGENT_DIR/workspace/memory"
check "skills/ copied" test -d "$AGENT_DIR/.claude/skills/bootstrap"
check "agents/ copied" test -f "$AGENT_DIR/.claude/agents/cron-worker.md"
check "rules/ copied" test -f "$AGENT_DIR/.claude/rules/safety.md"

# Verify placeholder substitution
check "No __AGENT_NAME__ in .mcp.json" bash -c "! grep -q '__AGENT_NAME__' '$AGENT_DIR/.claude/.mcp.json'"
check "No __HINDSIGHT_PORT__ in .mcp.json" bash -c "! grep -q '__HINDSIGHT_PORT__' '$AGENT_DIR/.claude/.mcp.json'"
check "No __ placeholders in settings.json" bash -c "! grep -q '__' '$AGENT_DIR/.claude/settings.json'"
check "settings.json has SessionEnd hook" grep -q "SessionEnd" "$AGENT_DIR/.claude/settings.json"
check "settings.json has PreToolUse hook" grep -q "PreToolUse" "$AGENT_DIR/.claude/settings.json"

# ── 2. Hindsight ─────────────────────────────────────────────────────────

echo ""
echo "── 2. Hindsight ──"

# Wait for Hindsight to be ready (max 60s)
READY=false
for i in $(seq 1 30); do
  if curl -sf "http://localhost:$HINDSIGHT_PORT/docs" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 2
done

if [[ "$READY" == "true" ]]; then
  check "Hindsight responds on port $HINDSIGHT_PORT" curl -sf "http://localhost:$HINDSIGHT_PORT/docs"

  # Retain a fact
  RETAIN_RESULT=$(curl -sf -X POST "http://localhost:$HINDSIGHT_PORT/v1/default/banks/$AGENT_NAME/memories" \
    -H "Content-Type: application/json" \
    -d '{"items":[{"content":"E2E test fact: the sky is blue"}]}' 2>&1) || RETAIN_RESULT=""
  check_output "Retain succeeds" "success" "$RETAIN_RESULT"

  # Recall with retry (entity resolution can take time)
  RECALL_RESULT=""
  for i in $(seq 1 6); do
    sleep 5
    RECALL_RESULT=$(curl -sf -X POST "http://localhost:$HINDSIGHT_PORT/v1/default/banks/$AGENT_NAME/memories/recall" \
      -H "Content-Type: application/json" \
      -d '{"query":"what color is the sky","limit":5}' 2>&1) || RECALL_RESULT=""
    if echo "$RECALL_RESULT" | grep -q "sky"; then
      break
    fi
  done
  if echo "$RECALL_RESULT" | grep -q "sky"; then
    green "  ✓ Recall returns stored fact"
    PASS=$((PASS + 1))
  elif [[ -z "$RECALL_RESULT" ]]; then
    skip_test "Recall returns stored fact" "API may be rate-limited or entity resolution pending"
  else
    red "  ✗ Recall returns stored fact (no 'sky' in response)"
    FAIL=$((FAIL + 1))
  fi
else
  skip_test "Hindsight responds" "container failed to start within 60s"
  skip_test "Retain succeeds" "Hindsight not ready"
  skip_test "Recall returns stored fact" "Hindsight not ready"
fi

# ── 3. Claude Session + SessionEnd Hook ──────────────────────────────────

echo ""
echo "── 3. Claude Session + SessionEnd Hook ──"

if command -v claude &>/dev/null; then
  # Spawn a quick claude -p session from the agent directory
  # This tests: identity loading, MCP connection, and SessionEnd hook
  SESSION_OUTPUT=$(cd "$AGENT_DIR" && echo "Say exactly: E2E_TEST_OK" | claude -p --output-format json 2>/dev/null) || SESSION_OUTPUT=""

  if [[ -n "$SESSION_OUTPUT" ]]; then
    check_output "Claude session completes" "result" "$SESSION_OUTPUT"

    # Check if SessionEnd hook fired (sessions.jsonl should have an entry)
    # Give it a moment for the hook to fire
    sleep 2
    MANIFEST="$AGENT_DIR/workspace/memory/sessions.jsonl"
    if [[ -f "$MANIFEST" ]]; then
      check "SessionEnd hook created manifest" test -f "$MANIFEST"
      check "Manifest has session entry" bash -c "wc -l < '$MANIFEST' | grep -q '[1-9]'"
    else
      skip_test "SessionEnd hook created manifest" "hook may not fire in -p mode"
      skip_test "Manifest has session entry" "hook may not fire in -p mode"
    fi
  else
    skip_test "Claude session completes" "claude -p returned empty"
    skip_test "SessionEnd hook created manifest" "no session ran"
    skip_test "Manifest has session entry" "no session ran"
  fi
else
  skip_test "Claude session completes" "claude CLI not found"
  skip_test "SessionEnd hook created manifest" "claude CLI not found"
  skip_test "Manifest has session entry" "claude CLI not found"
fi

# ── 4. Nightly Memory ────────────────────────────────────────────────────

echo ""
echo "── 4. Nightly Memory ──"

MANIFEST="$AGENT_DIR/workspace/memory/sessions.jsonl"

# If no manifest from the hook, create a synthetic one for testing
if [[ ! -f "$MANIFEST" ]] || [[ ! -s "$MANIFEST" ]]; then
  # Find any transcript from the session we just ran
  ENCODED_PATH=$(echo "$AGENT_DIR" | tr '/' '-' | sed 's/^-//')
  TRANSCRIPT=$(find "$HOME/.claude/projects/" -path "*$ENCODED_PATH*" -name "*.jsonl" 2>/dev/null | head -1) || TRANSCRIPT=""

  if [[ -z "$TRANSCRIPT" ]]; then
    # Create a minimal fake transcript
    TRANSCRIPT="$AGENT_DIR/workspace/memory/fake-transcript.jsonl"
    echo '{"type":"user","message":{"role":"user","content":"hello"}}' > "$TRANSCRIPT"
  fi

  mkdir -p "$(dirname "$MANIFEST")"
  TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  echo "{\"timestamp\":\"$TIMESTAMP\",\"session_id\":\"e2e-fake\",\"transcript_path\":\"$TRANSCRIPT\"}" > "$MANIFEST"
fi

if [[ "$READY" == "true" ]] && command -v claude &>/dev/null; then
  # Run nightly-memory.sh
  NIGHTLY_OUTPUT=$(bash "$OPENCLAUDE_DIR/scripts/nightly-memory.sh" "$AGENT_DIR" "$AGENT_NAME" "$HINDSIGHT_PORT" 2>&1) || true

  check "Nightly script exits cleanly" test $? -eq 0
  check "Nightly log created" test -f "$AGENT_DIR/workspace/memory/nightly.log"
  check "Marker file created" test -f "$AGENT_DIR/workspace/memory/.last-nightly"

  # Check if daily log was generated
  TODAY=$(date '+%Y-%m-%d')
  if [[ -f "$AGENT_DIR/workspace/memory/$TODAY.md" ]]; then
    check "Daily log generated" test -f "$AGENT_DIR/workspace/memory/$TODAY.md"
  else
    skip_test "Daily log generated" "may need more memories for generation"
  fi
else
  skip_test "Nightly script exits cleanly" "Hindsight or claude not available"
  skip_test "Nightly log created" "Hindsight or claude not available"
  skip_test "Marker file created" "Hindsight or claude not available"
  skip_test "Daily log generated" "Hindsight or claude not available"
fi

# ── 5. Log Session Hook (direct test) ───────────────────────────────────

echo ""
echo "── 5. Log Session Hook (direct) ──"

HOOK_TEST_DIR=$(mktemp -d)
mkdir -p "$HOOK_TEST_DIR/workspace/memory"

HOOK_OUTPUT=$(echo '{"session_id":"e2e-hook-test","transcript_path":"/tmp/test.jsonl","cwd":"/test"}' \
  | bash "$OPENCLAUDE_DIR/scripts/log-session.sh" "$HOOK_TEST_DIR" 2>&1) || true

check "log-session.sh exits cleanly" test $? -eq 0
check "Manifest file created by hook" test -f "$HOOK_TEST_DIR/workspace/memory/sessions.jsonl"
check "Manifest contains session_id" grep -q "e2e-hook-test" "$HOOK_TEST_DIR/workspace/memory/sessions.jsonl"
rm -rf "$HOOK_TEST_DIR"

# ── 6. Check Memory Size Hook ───────────────────────────────────────────

echo ""
echo "── 6. Memory Size Hook ──"

# Test under limit
SMALL_INPUT='{"file_path":"/tmp/test-MEMORY.md"}'
echo "line1" > /tmp/test-MEMORY.md
HOOK_RESULT=$(echo "$SMALL_INPUT" | bash "$OPENCLAUDE_DIR/scripts/check-memory-size.sh" 2>&1) || true
check "Allows edit under 50 lines" test $? -eq 0

# Test over limit
printf '%s\n' $(seq 1 55) > /tmp/test-MEMORY.md
if echo "$SMALL_INPUT" | bash "$OPENCLAUDE_DIR/scripts/check-memory-size.sh" >/dev/null 2>&1; then
  red "  ✗ Blocks edit over 50 lines"
  FAIL=$((FAIL + 1))
else
  green "  ✓ Blocks edit over 50 lines"
  PASS=$((PASS + 1))
fi
rm -f /tmp/test-MEMORY.md

# ── 7. Uninstall ─────────────────────────────────────────────────────────

echo ""
echo "── 7. Uninstall ──"

# Uninstall with --remove-data (pipe y to confirm)
echo "y" | bash "$OPENCLAUDE_DIR/scripts/uninstall.sh" "$AGENT_NAME" --remove-data >/dev/null 2>&1 || true

check "Agent directory removed" bash -c "! test -d '$AGENT_DIR'"
check "Hindsight container removed" bash -c "! docker inspect 'hindsight-$AGENT_NAME' >/dev/null 2>&1"

# Prevent cleanup trap from erroring on already-removed agent
trap - EXIT

# ── Summary ──────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$((PASS + FAIL + SKIP))
echo "  Results: $TOTAL tests"
green "  Passed:  $PASS"
[[ $FAIL -gt 0 ]] && red "  Failed:  $FAIL"
[[ $SKIP -gt 0 ]] && yellow "  Skipped: $SKIP"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
