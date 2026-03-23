#!/usr/bin/env bats

# Tests for scripts/setup.sh

setup() {
  export TEST_HOME=$(mktemp -d)
  export REAL_HOME="$HOME"
  export HOME="$TEST_HOME"
  export OPENCLAUDE_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../.." && pwd)"
  # Mock docker command
  export PATH="$TEST_HOME/bin:$PATH"
  mkdir -p "$TEST_HOME/bin"
  printf '#!/bin/bash\necho "mock docker $*"\n' > "$TEST_HOME/bin/docker"
  chmod +x "$TEST_HOME/bin/docker"
}

teardown() {
  export HOME="$REAL_HOME"
  rm -rf "$TEST_HOME"
}

@test "setup.sh creates agent directory structure" {
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" test-agent
  [ "$status" -eq 0 ]
  [ -f "$TEST_HOME/.openclaude/agents/test-agent/.claude/CLAUDE.md" ]
  [ -f "$TEST_HOME/.openclaude/agents/test-agent/workspace/IDENTITY.md" ]
  [ -d "$TEST_HOME/.openclaude/agents/test-agent/workspace/memory" ]
}

@test "setup.sh rejects duplicate agent name" {
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" test-agent
  [ "$status" -eq 0 ]
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" test-agent
  [ "$status" -ne 0 ]
}

@test "setup.sh substitutes agent name in .mcp.json" {
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" myagent
  [ "$status" -eq 0 ]
  local mcp="$TEST_HOME/.openclaude/agents/myagent/.claude/.mcp.json"
  grep -q "myagent" "$mcp"
  ! grep -q "__AGENT_NAME__" "$mcp"
}

@test "setup.sh substitutes placeholders in settings.json" {
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" myagent
  [ "$status" -eq 0 ]
  local settings="$TEST_HOME/.openclaude/agents/myagent/.claude/settings.json"
  ! grep -q "__" "$settings"
}

@test "setup.sh uses default port 8888 when not specified" {
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" myagent
  [ "$status" -eq 0 ]
  local mcp="$TEST_HOME/.openclaude/agents/myagent/.claude/.mcp.json"
  grep -q "8888" "$mcp"
}
