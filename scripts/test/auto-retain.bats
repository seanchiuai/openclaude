#!/usr/bin/env bats

# Tests for scripts/auto-retain.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export REAL_HOME="$HOME"
  export HOME="$TEST_DIR"
  export PATH="$TEST_DIR/bin:$PATH"
  mkdir -p "$TEST_DIR/bin"
  mkdir -p "$TEST_DIR/agent/workspace/memory"
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/auto-retain.sh"
  # Clean up any leftover timestamp file
  rm -f "/tmp/.openclaude-last-retain-testagent"
}

teardown() {
  export HOME="$REAL_HOME"
  rm -f "/tmp/.openclaude-last-retain-testagent"
  rm -rf "$TEST_DIR"
}

@test "auto-retain.sh exits cleanly when no transcript found" {
  # Create the projects dir but with no transcripts
  mkdir -p "$TEST_DIR/.claude/projects"
  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]
}

@test "auto-retain.sh exits cleanly when claude CLI missing" {
  # Create a fake transcript so the script gets past the transcript check
  mkdir -p "$TEST_DIR/.claude/projects/test"
  echo '{"test": true}' > "$TEST_DIR/.claude/projects/test/session.jsonl"
  # Use a restricted PATH without claude
  run env PATH="$TEST_DIR/bin:/usr/bin:/bin" bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]
  # Verify the log mentions claude CLI not found
  grep -q "claude CLI not found" "$TEST_DIR/agent/workspace/memory/retain.log"
}

@test "auto-retain.sh extracts facts from transcript" {
  # Create a fake transcript
  mkdir -p "$TEST_DIR/.claude/projects/test"
  echo '{"test": true}' > "$TEST_DIR/.claude/projects/test/session.jsonl"

  # Mock claude CLI to return fake facts
  cat > "$TEST_DIR/bin/claude" << 'MOCK'
#!/bin/bash
echo '[{"type":"result","result":"User likes dark mode\nProject uses Python 3.12"}]'
MOCK
  chmod +x "$TEST_DIR/bin/claude"

  # Mock curl: first call (health check) succeeds, POST calls succeed
  cat > "$TEST_DIR/bin/curl" << 'MOCK'
#!/bin/bash
echo "$@" >> "$HOME/curl.log"
exit 0
MOCK
  chmod +x "$TEST_DIR/bin/curl"

  # Mock jq
  cat > "$TEST_DIR/bin/jq" << 'MOCK'
#!/bin/bash
# If -r flag and the select pattern, extract result text
if [[ "$*" == *"select"* ]]; then
  # Read stdin, output the result text
  cat - | sed 's/.*"result":"//' | sed 's/"}].*//' | sed 's/\\n/\n/g'
elif [[ "$*" == *"-Rs"* ]]; then
  # JSON-escape stdin
  input=$(cat -)
  echo "\"$input\""
fi
MOCK
  chmod +x "$TEST_DIR/bin/jq"

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 9999
  [ "$status" -eq 0 ]

  # Verify curl was called with POST to retain facts
  grep -q "POST" "$TEST_DIR/curl.log"
}

@test "auto-retain.sh posts to Hindsight API" {
  # Create a fake transcript
  mkdir -p "$TEST_DIR/.claude/projects/test"
  echo '{"test": true}' > "$TEST_DIR/.claude/projects/test/session.jsonl"

  # Mock claude CLI
  cat > "$TEST_DIR/bin/claude" << 'MOCK'
#!/bin/bash
echo '[{"type":"result","result":"Single fact to retain"}]'
MOCK
  chmod +x "$TEST_DIR/bin/claude"

  # Mock curl that logs all calls
  cat > "$TEST_DIR/bin/curl" << 'MOCK'
#!/bin/bash
echo "$@" >> "$HOME/curl.log"
exit 0
MOCK
  chmod +x "$TEST_DIR/bin/curl"

  # Mock jq
  cat > "$TEST_DIR/bin/jq" << 'MOCK'
#!/bin/bash
if [[ "$*" == *"select"* ]]; then
  cat - | sed 's/.*"result":"//' | sed 's/"}].*//' | sed 's/\\n/\n/g'
elif [[ "$*" == *"-Rs"* ]]; then
  input=$(cat -)
  echo "\"$input\""
fi
MOCK
  chmod +x "$TEST_DIR/bin/jq"

  run bash "$SCRIPT" "$TEST_DIR/agent" testagent 7777
  [ "$status" -eq 0 ]

  # Verify the API endpoint includes the correct port and agent name
  grep -q "localhost:7777" "$TEST_DIR/curl.log"
  grep -q "testagent" "$TEST_DIR/curl.log"
}
