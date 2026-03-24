#!/usr/bin/env bats

# Tests for scripts/spawn-worker.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/spawn-worker.sh"
  # Create fake agent directory
  mkdir -p "$TEST_DIR/agent/.claude"
  # Mock claude CLI
  mkdir -p "$TEST_DIR/bin"
  cat > "$TEST_DIR/bin/claude" << 'MOCK'
#!/bin/bash
# Read prompt from stdin
PROMPT=$(cat)
echo "[{\"type\":\"result\",\"result\":\"Worker completed: $PROMPT\"}]"
MOCK
  chmod +x "$TEST_DIR/bin/claude"
  export PATH="$TEST_DIR/bin:$PATH"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "spawn-worker.sh requires AGENT_DIR argument" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}

@test "spawn-worker.sh requires PROMPT argument" {
  run bash "$SCRIPT" "$TEST_DIR/agent"
  [ "$status" -ne 0 ]
}

@test "spawn-worker.sh rejects invalid agent directory" {
  run bash "$SCRIPT" "/nonexistent" "test prompt"
  [ "$status" -ne 0 ]
}

@test "spawn-worker.sh runs worker and returns output" {
  run bash "$SCRIPT" "$TEST_DIR/agent" "test task"
  [ "$status" -eq 0 ]
  [[ "$output" == *"result"* ]]
}

@test "spawn-worker.sh writes to output file" {
  OUTPUT_FILE="$TEST_DIR/result.json"
  run bash "$SCRIPT" "$TEST_DIR/agent" "test task" --output "$OUTPUT_FILE"
  [ "$status" -eq 0 ]
  [ -f "$OUTPUT_FILE" ]
  grep -q "result" "$OUTPUT_FILE"
}

@test "spawn-worker.sh runs in background and returns PID" {
  # Background mode needs a real shell with job control — use temp file for output
  RESULT_FILE="$TEST_DIR/bg-result.txt"
  bash "$SCRIPT" "$TEST_DIR/agent" "test task" --background > "$RESULT_FILE" 2>&1
  RESULT=$(cat "$RESULT_FILE")
  [[ "$RESULT" == *"pid"* ]]
  [[ "$RESULT" == *"output"* ]]
  # Wait for background worker to finish
  sleep 1
}
