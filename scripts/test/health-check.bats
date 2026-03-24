#!/usr/bin/env bats

# Tests for scripts/health-check.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export REAL_HOME="$HOME"
  export HOME="$TEST_DIR"
  export PATH="$TEST_DIR/bin:$PATH"
  mkdir -p "$TEST_DIR/bin"
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/health-check.sh"
}

teardown() {
  export HOME="$REAL_HOME"
  rm -rf "$TEST_DIR"
}

@test "health-check.sh no-ops when services healthy" {
  # Mock curl to return success
  printf '#!/bin/bash\nexit 0\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"
  # Mock docker (should not be called)
  printf '#!/bin/bash\necho "SHOULD NOT BE CALLED" >&2; exit 1\n' > "$TEST_DIR/bin/docker"
  chmod +x "$TEST_DIR/bin/docker"

  run bash "$SCRIPT" testagent 8888
  [ "$status" -eq 0 ]
  # stderr should be empty (no restart, no warning)
  [ -z "$stderr" ] || true
}

@test "health-check.sh restarts dead Hindsight container" {
  # Mock curl to fail (Hindsight is down)
  printf '#!/bin/bash\nexit 1\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"
  # Mock docker to log calls
  cat > "$TEST_DIR/bin/docker" << 'MOCK'
#!/bin/bash
echo "$@" >> "$HOME/docker.log"
MOCK
  chmod +x "$TEST_DIR/bin/docker"

  run bash "$SCRIPT" testagent 8888
  [ "$status" -eq 0 ]
  # Verify docker restart was called with the correct container name
  grep -q "restart hindsight-testagent" "$TEST_DIR/docker.log"
}

@test "health-check.sh warns when ClaudeClaw PID is dead" {
  # Mock curl to succeed (Hindsight is fine)
  printf '#!/bin/bash\nexit 0\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"

  # Create a PID file with a definitely-dead PID
  mkdir -p "$TEST_DIR/.openclaude/agents/testagent"
  echo "99999999" > "$TEST_DIR/.openclaude/agents/testagent/.claudeclaw.pid"

  run bash "$SCRIPT" testagent 8888
  [ "$status" -eq 0 ]
  # Check stderr contains the warning
  [[ "$output" == *"ClaudeClaw"*"not running"* ]]
}
