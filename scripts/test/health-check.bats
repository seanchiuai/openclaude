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

# Helper: create agent with .mcp.json so all-agents mode can discover it
create_test_agent() {
  local name="${1:-testagent}"
  local port="${2:-8888}"
  mkdir -p "$TEST_DIR/.openclaude/agents/$name/.claude"
  mkdir -p "$TEST_DIR/.openclaude/agents/$name/workspace"
  cat > "$TEST_DIR/.openclaude/agents/$name/.claude/.mcp.json" << EOF
{
  "mcpServers": {
    "hindsight": {
      "type": "http",
      "url": "http://localhost:${port}/mcp/${name}/"
    }
  }
}
EOF
}

@test "health-check.sh single agent: no-ops when services healthy" {
  create_test_agent testagent 8888
  printf '#!/bin/bash\nexit 0\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"
  printf '#!/bin/bash\necho "SHOULD NOT BE CALLED" >&2; exit 1\n' > "$TEST_DIR/bin/docker"
  chmod +x "$TEST_DIR/bin/docker"

  run bash "$SCRIPT" testagent 8888
  [ "$status" -eq 0 ]
}

@test "health-check.sh single agent: restarts dead Hindsight container" {
  create_test_agent testagent 8888
  printf '#!/bin/bash\nexit 1\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"
  cat > "$TEST_DIR/bin/docker" << 'MOCK'
#!/bin/bash
if [[ "$1" == "info" ]]; then exit 0; fi
echo "$@" >> "$HOME/docker.log"
MOCK
  chmod +x "$TEST_DIR/bin/docker"

  run bash "$SCRIPT" testagent 8888
  [ "$status" -eq 0 ]
  grep -q "restart hindsight-testagent" "$TEST_DIR/docker.log"
}

@test "health-check.sh single agent: warns when ClaudeClaw PID is dead" {
  create_test_agent testagent 8888
  printf '#!/bin/bash\nexit 0\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"
  echo "99999999" > "$TEST_DIR/.openclaude/agents/testagent/.claudeclaw.pid"

  run bash "$SCRIPT" testagent 8888
  [ "$status" -eq 0 ]
  [[ "$output" == *"ClaudeClaw"*"DOWN"* ]]
}

@test "health-check.sh all agents: shows status for all agents" {
  create_test_agent alpha 8888
  create_test_agent beta 8889
  echo "some memory" > "$TEST_DIR/.openclaude/agents/alpha/workspace/MEMORY.md"
  printf '#!/bin/bash\nexit 0\n' > "$TEST_DIR/bin/curl"
  chmod +x "$TEST_DIR/bin/curl"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"alpha"* ]]
  [[ "$output" == *"beta"* ]]
  [[ "$output" == *"OpenClaude Agent Status"* ]]
}

@test "health-check.sh all agents: reports no agents when directory empty" {
  mkdir -p "$TEST_DIR/.openclaude/agents"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No agents found"* ]]
}

@test "health-check.sh all agents: handles missing .mcp.json gracefully" {
  mkdir -p "$TEST_DIR/.openclaude/agents/broken/.claude"

  run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"broken"* ]]
  [[ "$output" == *"unknown"* ]]
}
