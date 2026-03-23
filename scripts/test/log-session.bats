#!/usr/bin/env bats

# Tests for scripts/log-session.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/log-session.sh"
  mkdir -p "$TEST_DIR/workspace/memory"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "log-session.sh appends session to manifest from stdin JSON" {
  run bash -c 'echo "{\"session_id\":\"abc123\",\"transcript_path\":\"/tmp/transcript.jsonl\",\"cwd\":\"/work\"}" | bash "$SCRIPT" "$TEST_DIR"'
  [ "$status" -eq 0 ]
  [ -f "$TEST_DIR/workspace/memory/sessions.jsonl" ]
  # Verify the line contains session_id and transcript_path
  line=$(cat "$TEST_DIR/workspace/memory/sessions.jsonl")
  [[ "$line" == *'"session_id":"abc123"'* ]]
  [[ "$line" == *'"transcript_path":"/tmp/transcript.jsonl"'* ]]
  [[ "$line" == *'"timestamp":'* ]]
}

@test "log-session.sh appends multiple sessions" {
  bash -c 'echo "{\"session_id\":\"sess1\",\"transcript_path\":\"/tmp/t1.jsonl\",\"cwd\":\"/work\"}" | bash "$SCRIPT" "$TEST_DIR"'
  bash -c 'echo "{\"session_id\":\"sess2\",\"transcript_path\":\"/tmp/t2.jsonl\",\"cwd\":\"/work\"}" | bash "$SCRIPT" "$TEST_DIR"'
  lines=$(wc -l < "$TEST_DIR/workspace/memory/sessions.jsonl")
  [ "$lines" -eq 2 ]
}

@test "log-session.sh handles missing/empty stdin gracefully" {
  run bash -c 'echo "" | bash "$SCRIPT" "$TEST_DIR"'
  [ "$status" -eq 0 ]
  # No manifest file should be created for empty input
  [ ! -f "$TEST_DIR/workspace/memory/sessions.jsonl" ]
}

@test "log-session.sh requires AGENT_DIR argument" {
  run bash -c 'echo "{\"session_id\":\"abc\",\"transcript_path\":\"/tmp/t.jsonl\"}" | bash "$SCRIPT"'
  [ "$status" -ne 0 ]
}
