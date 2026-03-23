#!/usr/bin/env bats

# Tests for scripts/check-memory-size.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/check-memory-size.sh"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "check-memory-size.sh allows edits under 50 lines" {
  local memfile="$TEST_DIR/MEMORY.md"
  # Create a file with 30 lines
  for i in $(seq 1 30); do echo "line $i"; done > "$memfile"
  run bash -c "echo '{\"file_path\": \"$memfile\", \"content\": \"test\"}' | bash $SCRIPT"
  [ "$status" -eq 0 ]
}

@test "check-memory-size.sh blocks edits over 50 lines" {
  local memfile="$TEST_DIR/MEMORY.md"
  # Create a file with 55 lines
  for i in $(seq 1 55); do echo "line $i"; done > "$memfile"
  run bash -c "echo '{\"file_path\": \"$memfile\", \"content\": \"test\"}' | bash $SCRIPT"
  [ "$status" -eq 1 ]
}

@test "check-memory-size.sh ignores non-MEMORY.md files" {
  run bash -c "echo '{\"file_path\": \"$TEST_DIR/README.md\", \"content\": \"test\"}' | bash $SCRIPT"
  [ "$status" -eq 0 ]
}

@test "check-memory-size.sh handles missing file gracefully" {
  run bash -c "echo '{\"file_path\": \"$TEST_DIR/nonexistent/MEMORY.md\", \"content\": \"test\"}' | bash $SCRIPT"
  [ "$status" -eq 0 ]
}
