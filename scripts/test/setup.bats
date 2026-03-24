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
  # Skip interactive prompts in tests
  export HINDSIGHT_LLM_PROVIDER="skip"
  export OPENCLAUDE_TIMEZONE="UTC"
  export OPENCLAUDE_SKIP_CRON="1"
  # Mock crontab command
  printf '#!/bin/bash\necho "mock crontab $*"\n' > "$TEST_HOME/bin/crontab"
  chmod +x "$TEST_HOME/bin/crontab"
  # Mock curl command (for Hindsight health check)
  printf '#!/bin/bash\nexit 0\n' > "$TEST_HOME/bin/curl"
  chmod +x "$TEST_HOME/bin/curl"
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

@test "setup.sh removes stale container before starting" {
  # Mock docker that reports a stopped container, then succeeds on rm and run
  cat > "$TEST_HOME/bin/docker" << 'SCRIPT'
#!/bin/bash
case "$1" in
  ps)    echo "hindsight-preflight-agent" ;;
  inspect) echo "exited" ;;
  rm)    echo "removed" ;;
  image) exit 0 ;;  # image inspect — image exists
  pull)  echo "pulled" ;;
  run)   echo "container-id-123" ;;
  info)  echo "mock docker info" ;;
  logs)  echo "mock logs" ;;
  *)     echo "mock docker $*" ;;
esac
SCRIPT
  chmod +x "$TEST_HOME/bin/docker"
  export HINDSIGHT_LLM_PROVIDER="gemini"
  export HINDSIGHT_LLM_API_KEY="test-key"
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" preflight-agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"removing stale container"* ]]
}

@test "setup.sh pulls image when not available locally" {
  # Mock docker where image inspect fails (not pulled) but pull succeeds
  cat > "$TEST_HOME/bin/docker" << 'SCRIPT'
#!/bin/bash
case "$1" in
  ps)    echo "" ;;  # no existing container
  image) exit 1 ;;   # image not found locally
  pull)  echo "Pulling from ghcr.io/vectorize-io/hindsight" ;;
  run)   echo "container-id-123" ;;
  info)  echo "mock docker info" ;;
  logs)  echo "mock logs" ;;
  *)     echo "mock docker $*" ;;
esac
SCRIPT
  chmod +x "$TEST_HOME/bin/docker"
  export HINDSIGHT_LLM_PROVIDER="gemini"
  export HINDSIGHT_LLM_API_KEY="test-key"
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" pull-agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Pulling Hindsight image"* ]]
}

@test "setup.sh detects port conflict and skips Hindsight" {
  # Mock lsof to simulate port conflict
  cat > "$TEST_HOME/bin/lsof" << 'SCRIPT'
#!/bin/bash
if [[ "$*" == *":8888"* ]]; then
  echo "node 12345"
  exit 0
fi
exit 1
SCRIPT
  chmod +x "$TEST_HOME/bin/lsof"
  # Mock ps for the blocking process name
  cat > "$TEST_HOME/bin/ps" << 'SCRIPT'
#!/bin/bash
echo "node"
SCRIPT
  chmod +x "$TEST_HOME/bin/ps"
  # Docker: no existing container
  cat > "$TEST_HOME/bin/docker" << 'SCRIPT'
#!/bin/bash
case "$1" in
  ps)   echo "" ;;
  info) echo "mock" ;;
  *)    echo "mock docker $*" ;;
esac
SCRIPT
  chmod +x "$TEST_HOME/bin/docker"
  export HINDSIGHT_LLM_PROVIDER="gemini"
  export HINDSIGHT_LLM_API_KEY="test-key"
  run bash "$OPENCLAUDE_DIR/scripts/setup.sh" port-agent
  [ "$status" -eq 0 ]
  [[ "$output" == *"Port 8888 is already in use"* ]]
  [[ "$output" == *"Skipping Hindsight"* ]]
}
