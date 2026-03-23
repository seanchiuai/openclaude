#!/usr/bin/env bats

# Tests for scripts/nightly-memory.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export REAL_HOME="$HOME"
  export HOME="$TEST_DIR"
  export PATH="$TEST_DIR/bin:$PATH"
  mkdir -p "$TEST_DIR/bin"
  mkdir -p "$TEST_DIR/agent/workspace/memory"
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/nightly-memory.sh"
}

teardown() {
  export HOME="$REAL_HOME"
  rm -rf "$TEST_DIR"
}

# Helper: create mock claude CLI
create_mock_claude() {
  local response="${1:-User prefers dark mode\nProject uses bash scripts}"
  cat > "$TEST_DIR/bin/claude" << MOCK
#!/bin/bash
echo '[{"type":"result","result":"$response"}]'
MOCK
  chmod +x "$TEST_DIR/bin/claude"
}

# Helper: create mock curl
create_mock_curl() {
  cat > "$TEST_DIR/bin/curl" << 'MOCK'
#!/bin/bash
echo "$@" >> "$HOME/curl.log"
# If it's a GET query for memories, return a mock response
if [[ "$*" == *"query="* ]]; then
  echo '{"memories":[{"content":"User discussed bash scripting"},{"content":"Decided to use bats for testing"}]}'
fi
exit 0
MOCK
  chmod +x "$TEST_DIR/bin/curl"
}

# Helper: create mock jq
create_mock_jq() {
  cat > "$TEST_DIR/bin/jq" << 'MOCK'
#!/bin/bash
if [[ "$*" == *"select"* ]]; then
  cat - | sed 's/.*"result":"//' | sed 's/"}].*//' | sed 's/\\n/\n/g'
elif [[ "$*" == *"-Rs"* ]]; then
  input=$(cat -)
  echo "\"$input\""
elif [[ "$*" == *".transcript_path"* ]]; then
  cat - | sed 's/.*"transcript_path":"//' | sed 's/".*//'
elif [[ "$*" == *".session_id"* ]]; then
  cat - | sed 's/.*"session_id":"//' | sed 's/".*//'
elif [[ "$*" == *".timestamp"* ]]; then
  cat - | sed 's/.*"timestamp":"//' | sed 's/".*//'
elif [[ "$*" == *"-cn"* ]]; then
  # jq -cn: passthrough for building JSON
  cat -
fi
MOCK
  chmod +x "$TEST_DIR/bin/jq"
}

# Helper: write a manifest entry
add_manifest_entry() {
  local session_id="$1"
  local transcript_path="$2"
  local timestamp="${3:-2026-03-23T10:00:00Z}"
  echo "{\"timestamp\":\"$timestamp\",\"session_id\":\"$session_id\",\"transcript_path\":\"$transcript_path\"}" \
    >> "$TEST_DIR/agent/workspace/memory/sessions.jsonl"
}

@test "nightly-memory.sh requires all 3 arguments" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]

  run bash "$SCRIPT" "$TEST_DIR/agent"
  [ "$status" -ne 0 ]

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent
  [ "$status" -ne 0 ]
}

@test "nightly-memory.sh exits cleanly with no manifest file" {
  create_mock_claude
  create_mock_curl
  create_mock_jq
  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]
}

@test "nightly-memory.sh exits cleanly when no unprocessed sessions" {
  create_mock_claude
  create_mock_curl
  create_mock_jq

  # Create manifest with one entry
  add_manifest_entry "sess1" "$TEST_DIR/transcript1.jsonl"

  # Create marker file that is newer than the manifest
  sleep 1
  touch "$TEST_DIR/agent/workspace/memory/.last-nightly"

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]
}

@test "nightly-memory.sh processes transcript and retains facts" {
  create_mock_claude
  create_mock_curl
  create_mock_jq

  # Create a transcript file
  echo '{"type":"message","content":"hello"}' > "$TEST_DIR/transcript1.jsonl"

  # Add manifest entry pointing to the transcript
  add_manifest_entry "sess1" "$TEST_DIR/transcript1.jsonl"

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]

  # Verify curl was called with POST to retain facts
  [ -f "$TEST_DIR/curl.log" ]
  grep -q "POST" "$TEST_DIR/curl.log"
  grep -q "localhost:9999" "$TEST_DIR/curl.log"
  grep -q "testagent" "$TEST_DIR/curl.log"
}

@test "nightly-memory.sh generates daily log" {
  create_mock_claude
  create_mock_curl
  create_mock_jq

  # No manifest needed — phase 2 runs regardless
  # Just ensure no daily log exists yet
  TODAY=$(date '+%Y-%m-%d')

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]

  # Verify daily log was created
  [ -f "$TEST_DIR/agent/workspace/memory/$TODAY.md" ]
}

@test "nightly-memory.sh skips missing transcript files gracefully" {
  create_mock_claude
  create_mock_curl
  create_mock_jq

  # Add manifest entry pointing to a non-existent transcript
  add_manifest_entry "sess1" "$TEST_DIR/nonexistent-transcript.jsonl"

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]

  # Log should mention skipping
  grep -q "not found.*skip" "$TEST_DIR/agent/workspace/memory/nightly.log" || \
    grep -q "skip" "$TEST_DIR/agent/workspace/memory/nightly.log"
}
