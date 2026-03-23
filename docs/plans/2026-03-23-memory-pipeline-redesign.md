# Memory Pipeline Redesign

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the excessive Stop hook (fires after every response) with a lightweight SessionEnd hook + nightly cron that processes transcripts and generates daily logs.

**Architecture:** SessionEnd hook appends one line to a manifest file (fast, within 1.5s timeout). A nightly cron script reads the manifest, LLM-extracts facts from unprocessed transcripts, retains them to Hindsight, and generates a daily log markdown file. The agent's in-conversation `retain` calls remain the primary memory path.

**Tech Stack:** Bash scripts, Claude CLI (Haiku for extraction), Hindsight REST API, jq, crontab

---

## Summary of Changes

| File | Action |
|------|--------|
| `scripts/log-session.sh` | **Create** — SessionEnd hook, appends to manifest |
| `scripts/nightly-memory.sh` | **Create** — Cron job: process transcripts + generate daily log |
| `scripts/auto-retain.sh` | **Delete** — Replaced by above two scripts |
| `scripts/test/auto-retain.bats` | **Delete** — Tests for removed script |
| `scripts/test/log-session.bats` | **Create** — Tests for SessionEnd hook |
| `scripts/test/nightly-memory.bats` | **Create** — Tests for nightly cron |
| `templates/claude/settings.json` | **Modify** — Replace Stop hook with SessionEnd hook |
| `~/.openclaude/agents/test/.claude/settings.json` | **Modify** — Same fix for existing agent |
| `templates/workspace/AGENTS.md` | **Modify** — Update Daily Logs section to reflect new pipeline |
| `CLAUDE.md` | **Modify** — Update project layout to list new scripts |

---

### Task 1: Create `log-session.sh` (SessionEnd hook)

**Files:**
- Create: `scripts/log-session.sh`
- Test: `scripts/test/log-session.bats`

**Step 1: Write the failing tests**

Create `scripts/test/log-session.bats`:

```bash
#!/usr/bin/env bats

# Tests for scripts/log-session.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export AGENT_DIR="$TEST_DIR/agent"
  mkdir -p "$AGENT_DIR/workspace/memory"
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/log-session.sh"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "log-session.sh appends session to manifest" {
  # Simulate SessionEnd hook input via stdin
  echo '{"session_id":"abc123","transcript_path":"/tmp/transcript.jsonl","cwd":"/test"}' \
    | run bash "$SCRIPT" "$AGENT_DIR"
  [ "$status" -eq 0 ]
  # Manifest should exist with one entry
  [ -f "$AGENT_DIR/workspace/memory/sessions.jsonl" ]
  grep -q "abc123" "$AGENT_DIR/workspace/memory/sessions.jsonl"
}

@test "log-session.sh appends multiple sessions" {
  echo '{"session_id":"sess1","transcript_path":"/tmp/t1.jsonl","cwd":"/a"}' \
    | bash "$SCRIPT" "$AGENT_DIR"
  echo '{"session_id":"sess2","transcript_path":"/tmp/t2.jsonl","cwd":"/b"}' \
    | bash "$SCRIPT" "$AGENT_DIR"
  LINE_COUNT=$(wc -l < "$AGENT_DIR/workspace/memory/sessions.jsonl")
  [ "$LINE_COUNT" -eq 2 ]
}

@test "log-session.sh handles missing stdin gracefully" {
  run bash "$SCRIPT" "$AGENT_DIR" < /dev/null
  [ "$status" -eq 0 ]
}

@test "log-session.sh requires AGENT_DIR argument" {
  echo '{}' | run bash "$SCRIPT"
  [ "$status" -ne 0 ]
}
```

**Step 2: Run tests to verify they fail**

Run: `bats scripts/test/log-session.bats`
Expected: FAIL — script doesn't exist yet

**Step 3: Write the implementation**

Create `scripts/log-session.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# SessionEnd hook: append session metadata to manifest for nightly processing.
# Receives JSON on stdin from Claude Code with session_id, transcript_path, cwd.
#
# Usage: log-session.sh <AGENT_DIR>

AGENT_DIR="${1:?Usage: log-session.sh <AGENT_DIR>}"
MANIFEST="$AGENT_DIR/workspace/memory/sessions.jsonl"

mkdir -p "$(dirname "$MANIFEST")"

# Read hook input from stdin
INPUT=$(cat 2>/dev/null) || INPUT=""

if [[ -z "$INPUT" ]]; then
  exit 0
fi

# Extract fields — use jq if available, else grep
if command -v jq &>/dev/null; then
  SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
  TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT=""
else
  SESSION_ID=$(echo "$INPUT" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//') || SESSION_ID=""
  TRANSCRIPT=$(echo "$INPUT" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//') || TRANSCRIPT=""
fi

# Skip if no session ID
if [[ -z "$SESSION_ID" ]]; then
  exit 0
fi

# Append to manifest
TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
echo "{\"timestamp\":\"$TIMESTAMP\",\"session_id\":\"$SESSION_ID\",\"transcript_path\":\"$TRANSCRIPT\"}" >> "$MANIFEST"
```

**Step 4: Run tests to verify they pass**

Run: `bats scripts/test/log-session.bats`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add scripts/log-session.sh scripts/test/log-session.bats
git commit -m "feat: add log-session.sh SessionEnd hook for manifest tracking"
```

---

### Task 2: Create `nightly-memory.sh` (cron job)

**Files:**
- Create: `scripts/nightly-memory.sh`
- Test: `scripts/test/nightly-memory.bats`

**Step 1: Write the failing tests**

Create `scripts/test/nightly-memory.bats`:

```bash
#!/usr/bin/env bats

# Tests for scripts/nightly-memory.sh

setup() {
  export TEST_DIR=$(mktemp -d)
  export AGENT_DIR="$TEST_DIR/agent"
  export MEMORY_DIR="$AGENT_DIR/workspace/memory"
  mkdir -p "$MEMORY_DIR"
  mkdir -p "$TEST_DIR/bin"
  export PATH="$TEST_DIR/bin:$PATH"
  export SCRIPT="$(cd "$(dirname "$BATS_TEST_FILENAME")/.." && pwd)/nightly-memory.sh"
}

teardown() {
  rm -rf "$TEST_DIR"
}

@test "nightly-memory.sh exits cleanly with empty manifest" {
  # No manifest file at all
  run bash "$SCRIPT" "$AGENT_DIR" testagent 9999
  [ "$status" -eq 0 ]
}

@test "nightly-memory.sh exits cleanly with no unprocessed sessions" {
  # Manifest exists but all sessions already processed (marker file exists)
  echo '{"timestamp":"2026-03-23T10:00:00Z","session_id":"done1","transcript_path":"/tmp/t.jsonl"}' \
    > "$MEMORY_DIR/sessions.jsonl"
  touch "$MEMORY_DIR/.last-nightly"
  # Make marker newer than manifest
  sleep 1
  touch "$MEMORY_DIR/.last-nightly"
  run bash "$SCRIPT" "$AGENT_DIR" testagent 9999
  [ "$status" -eq 0 ]
}

@test "nightly-memory.sh processes transcript and retains facts" {
  # Create manifest with one session
  TRANSCRIPT="$TEST_DIR/transcript.jsonl"
  echo '{"type":"user","message":{"role":"user","content":"hello"}}' > "$TRANSCRIPT"
  echo "{\"timestamp\":\"2026-03-23T10:00:00Z\",\"session_id\":\"sess1\",\"transcript_path\":\"$TRANSCRIPT\"}" \
    > "$MEMORY_DIR/sessions.jsonl"

  # Mock claude CLI
  cat > "$TEST_DIR/bin/claude" << 'MOCK'
#!/bin/bash
echo '[{"type":"result","result":"User said hello"}]'
MOCK
  chmod +x "$TEST_DIR/bin/claude"

  # Mock curl (Hindsight)
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
elif [[ "$*" == *"-r"* ]]; then
  cat - | sed 's/.*"result":"//' | sed 's/"}].*//'
else
  cat -
fi
MOCK
  chmod +x "$TEST_DIR/bin/jq"

  run bash "$SCRIPT" "$AGENT_DIR" testagent 9999
  [ "$status" -eq 0 ]
  # Verify Hindsight was called
  grep -q "POST" "$TEST_DIR/curl.log"
}

@test "nightly-memory.sh generates daily log" {
  # Create manifest
  TRANSCRIPT="$TEST_DIR/transcript.jsonl"
  echo '{"type":"user","message":{"role":"user","content":"test"}}' > "$TRANSCRIPT"
  echo "{\"timestamp\":\"2026-03-23T10:00:00Z\",\"session_id\":\"sess1\",\"transcript_path\":\"$TRANSCRIPT\"}" \
    > "$MEMORY_DIR/sessions.jsonl"

  # Mock claude CLI — returns facts for extraction, then daily log for generation
  CALL_COUNT="$TEST_DIR/call_count"
  echo "0" > "$CALL_COUNT"
  cat > "$TEST_DIR/bin/claude" << 'MOCK'
#!/bin/bash
COUNT=$(cat "$HOME/call_count")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$HOME/call_count"
if [ "$COUNT" -eq 1 ]; then
  echo '[{"type":"result","result":"User tested the system"}]'
else
  echo '[{"type":"result","result":"# Daily Log\n\n- User tested the system"}]'
fi
MOCK
  chmod +x "$TEST_DIR/bin/claude"

  # Mock curl
  cat > "$TEST_DIR/bin/curl" << 'MOCK'
#!/bin/bash
echo "$@" >> "$HOME/curl.log"
# For reflect calls, return some memories
if [[ "$*" == *"reflect"* ]] || [[ "$*" == *"recall"* ]]; then
  echo '{"memories": [{"content": "User tested the system"}]}'
fi
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
elif [[ "$*" == *"-r"* ]]; then
  cat - | sed 's/.*"result":"//' | sed 's/"}].*//'
else
  cat -
fi
MOCK
  chmod +x "$TEST_DIR/bin/jq"

  run bash "$SCRIPT" "$AGENT_DIR" testagent 9999
  [ "$status" -eq 0 ]
  # Daily log should exist for today
  TODAY=$(date '+%Y-%m-%d')
  [ -f "$MEMORY_DIR/$TODAY.md" ]
}

@test "nightly-memory.sh requires all arguments" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  run bash "$SCRIPT" "$AGENT_DIR"
  [ "$status" -ne 0 ]
  run bash "$SCRIPT" "$AGENT_DIR" testagent
  [ "$status" -ne 0 ]
}

@test "nightly-memory.sh skips missing transcript files" {
  # Manifest points to nonexistent transcript
  echo '{"timestamp":"2026-03-23T10:00:00Z","session_id":"gone","transcript_path":"/nonexistent/path.jsonl"}' \
    > "$MEMORY_DIR/sessions.jsonl"

  run bash "$SCRIPT" "$AGENT_DIR" testagent 9999
  [ "$status" -eq 0 ]
  # Should log the skip
  grep -q "not found" "$MEMORY_DIR/nightly.log" || grep -q "skipping" "$MEMORY_DIR/nightly.log"
}
```

**Step 2: Run tests to verify they fail**

Run: `bats scripts/test/nightly-memory.bats`
Expected: FAIL — script doesn't exist yet

**Step 3: Write the implementation**

Create `scripts/nightly-memory.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Nightly cron: process unprocessed session transcripts, retain facts to
# Hindsight, and generate a daily log markdown file.
#
# Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>

AGENT_DIR="${1:?Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"
AGENT_NAME="${2:?Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"
HINDSIGHT_PORT="${3:?Usage: nightly-memory.sh <AGENT_DIR> <AGENT_NAME> <HINDSIGHT_PORT>}"

MEMORY_DIR="$AGENT_DIR/workspace/memory"
MANIFEST="$MEMORY_DIR/sessions.jsonl"
MARKER="$MEMORY_DIR/.last-nightly"
LOG_FILE="$MEMORY_DIR/nightly.log"
TODAY=$(date '+%Y-%m-%d')

mkdir -p "$MEMORY_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"; }

# Unset env vars that interfere with spawning a child claude process
unset CLAUDECODE ANTHROPIC_API_KEY CLAUDE_API_KEY CLAUDE_CODE_ENTRYPOINT 2>/dev/null || true

# ── Phase 1: Process unprocessed transcripts ─────────────────────────────

if [[ ! -f "$MANIFEST" ]]; then
  log "No manifest found, skipping transcript processing."
else
  # Get sessions added since last nightly run
  if [[ -f "$MARKER" ]]; then
    NEW_SESSIONS=$(find "$MANIFEST" -newer "$MARKER" 2>/dev/null)
    if [[ -z "$NEW_SESSIONS" ]]; then
      log "No new sessions since last run."
    fi
  fi

  # Read manifest and process each session
  PROCESSED=0
  SKIPPED=0
  while IFS= read -r LINE; do
    [[ -z "$LINE" ]] && continue

    # Extract transcript path
    if command -v jq &>/dev/null; then
      TRANSCRIPT=$(echo "$LINE" | jq -r '.transcript_path // empty' 2>/dev/null) || TRANSCRIPT=""
      SESSION_ID=$(echo "$LINE" | jq -r '.session_id // empty' 2>/dev/null) || SESSION_ID=""
    else
      TRANSCRIPT=$(echo "$LINE" | grep -o '"transcript_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//') || TRANSCRIPT=""
      SESSION_ID=$(echo "$LINE" | grep -o '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"session_id"[[:space:]]*:[[:space:]]*"//' | sed 's/"$//') || SESSION_ID=""
    fi

    # Skip if transcript doesn't exist
    if [[ -z "$TRANSCRIPT" || ! -f "$TRANSCRIPT" ]]; then
      log "Transcript not found, skipping: ${TRANSCRIPT:-empty}"
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    # Check claude CLI
    if ! command -v claude &>/dev/null; then
      log "WARNING: claude CLI not found, skipping extraction."
      break
    fi

    # Extract facts from transcript
    CONTENT=$(tail -c 50000 "$TRANSCRIPT")
    EXTRACTION_PROMPT="Extract key facts, decisions, preferences, and outcomes from this conversation transcript. Return one fact per line, no numbering, no bullets. Only include facts worth remembering long-term. Skip trivial or procedural details.

<transcript>
$CONTENT
</transcript>"

    FACTS=$(echo "$EXTRACTION_PROMPT" | claude -p --model claude-haiku-4-5-20251001 --output-format json 2>/dev/null) || {
      log "WARNING: claude extraction failed for session $SESSION_ID"
      SKIPPED=$((SKIPPED + 1))
      continue
    }

    # Parse result
    if command -v jq &>/dev/null; then
      FACT_TEXT=$(echo "$FACTS" | jq -r 'if type == "array" then [.[] | select(.type == "result")] | last | .result // empty else . end' 2>/dev/null) || FACT_TEXT="$FACTS"
    else
      FACT_TEXT="$FACTS"
    fi

    if [[ -z "${FACT_TEXT:-}" ]]; then
      log "No facts extracted from session $SESSION_ID"
      continue
    fi

    # Check Hindsight is reachable
    if ! curl -sf "http://localhost:$HINDSIGHT_PORT/docs" &>/dev/null; then
      log "WARNING: Hindsight not reachable at port $HINDSIGHT_PORT, aborting."
      break
    fi

    # Retain each fact
    RETAINED=0
    while IFS= read -r FACT; do
      [[ -z "${FACT// /}" ]] && continue
      if command -v jq &>/dev/null; then
        ESCAPED=$(echo "$FACT" | jq -Rs '.' 2>/dev/null | sed 's/^"//;s/"$//') || ESCAPED=$(echo "$FACT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
      else
        ESCAPED=$(echo "$FACT" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g')
      fi
      curl -sf -X POST "http://localhost:$HINDSIGHT_PORT/v1/default/banks/$AGENT_NAME/memories" \
        -H "Content-Type: application/json" \
        -d "{\"items\": [{\"content\": \"$ESCAPED\"}]}" &>/dev/null && RETAINED=$((RETAINED + 1))
    done <<< "$FACT_TEXT"

    log "Session $SESSION_ID: retained $RETAINED facts"
    PROCESSED=$((PROCESSED + 1))
  done < "$MANIFEST"

  log "Phase 1 complete: $PROCESSED sessions processed, $SKIPPED skipped."
fi

# ── Phase 2: Generate daily log ──────────────────────────────────────────

DAILY_LOG="$MEMORY_DIR/$TODAY.md"

# Skip if daily log already exists
if [[ -f "$DAILY_LOG" ]]; then
  log "Daily log $TODAY.md already exists, skipping generation."
else
  # Check Hindsight
  if ! curl -sf "http://localhost:$HINDSIGHT_PORT/docs" &>/dev/null; then
    log "WARNING: Hindsight not reachable, skipping daily log generation."
  elif ! command -v claude &>/dev/null; then
    log "WARNING: claude CLI not found, skipping daily log generation."
  else
    # Query Hindsight for today's memories via reflect
    MEMORIES=$(curl -sf "http://localhost:$HINDSIGHT_PORT/v1/default/banks/$AGENT_NAME/memories?query=events+on+$TODAY&limit=50" 2>/dev/null) || MEMORIES=""

    if [[ -n "$MEMORIES" ]]; then
      LOG_PROMPT="Generate a concise daily log in markdown for $TODAY from these memories. Use sections: ## Summary, ## Key Facts, ## Decisions, ## Open Items. Skip empty sections. Be concise — bullet points, not prose.

<memories>
$MEMORIES
</memories>"

      LOG_RESULT=$(echo "$LOG_PROMPT" | claude -p --model claude-haiku-4-5-20251001 --output-format json 2>/dev/null) || LOG_RESULT=""

      if [[ -n "$LOG_RESULT" ]]; then
        if command -v jq &>/dev/null; then
          LOG_TEXT=$(echo "$LOG_RESULT" | jq -r 'if type == "array" then [.[] | select(.type == "result")] | last | .result // empty else . end' 2>/dev/null) || LOG_TEXT=""
        else
          LOG_TEXT="$LOG_RESULT"
        fi

        if [[ -n "$LOG_TEXT" ]]; then
          echo "$LOG_TEXT" > "$DAILY_LOG"
          log "Generated daily log: $TODAY.md"
        else
          log "WARNING: Empty result from daily log generation."
        fi
      fi
    else
      log "No memories found for $TODAY, skipping daily log."
    fi
  fi
fi

# Mark nightly as complete
touch "$MARKER"
log "Nightly run complete."
```

**Step 4: Run tests to verify they pass**

Run: `bats scripts/test/nightly-memory.bats`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add scripts/nightly-memory.sh scripts/test/nightly-memory.bats
git commit -m "feat: add nightly-memory.sh cron for transcript processing and daily logs"
```

---

### Task 3: Update settings.json templates (Stop → SessionEnd)

**Files:**
- Modify: `templates/claude/settings.json`
- Modify: `~/.openclaude/agents/test/.claude/settings.json`

**Step 1: Update the template**

Replace `templates/claude/settings.json` contents with:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "__OPENCLAUDE_DIR__/scripts/log-session.sh __AGENT_DIR__"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "__OPENCLAUDE_DIR__/scripts/check-memory-size.sh $TOOL_INPUT"
          }
        ]
      }
    ]
  }
}
```

**Step 2: Update the existing test agent config**

Replace `~/.openclaude/agents/test/.claude/settings.json` with substituted values:

```json
{
  "hooks": {
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/seanchiu/Desktop/openclaude/scripts/log-session.sh /Users/seanchiu/.openclaude/agents/test"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "/Users/seanchiu/Desktop/openclaude/scripts/check-memory-size.sh $TOOL_INPUT"
          }
        ]
      }
    ]
  }
}
```

**Step 3: Verify settings.json is valid JSON**

Run: `python3 -c "import json; json.load(open('templates/claude/settings.json'))"`
Expected: No output (valid JSON)

**Step 4: Commit**

```bash
git add templates/claude/settings.json
git commit -m "feat: replace Stop hook with SessionEnd hook for lightweight session logging"
```

---

### Task 4: Delete auto-retain.sh and its tests

**Files:**
- Delete: `scripts/auto-retain.sh`
- Delete: `scripts/test/auto-retain.bats`

**Step 1: Remove files**

```bash
git rm scripts/auto-retain.sh scripts/test/auto-retain.bats
```

**Step 2: Commit**

```bash
git commit -m "chore: remove auto-retain.sh Stop hook (replaced by SessionEnd + nightly cron)"
```

---

### Task 5: Update setup.sh to use new hook

**Files:**
- Modify: `scripts/setup.sh`

**Step 1: Check current sed substitutions in setup.sh**

The current setup.sh substitutes `__OPENCLAUDE_DIR__`, `__AGENT_DIR__`, `__AGENT_NAME__`, `__HINDSIGHT_PORT__` in settings.json. The new template only uses `__OPENCLAUDE_DIR__` and `__AGENT_DIR__` (SessionEnd hook is simpler — no agent name or port needed).

No changes needed to setup.sh — the existing sed commands will simply have no matches for `__AGENT_NAME__` and `__HINDSIGHT_PORT__` in settings.json, which is harmless.

**Step 2: Verify setup.sh still works**

Run: `bash -n scripts/setup.sh` (syntax check)
Expected: No output (valid syntax)

**Step 3: No commit needed** — no changes to setup.sh.

---

### Task 6: Update AGENTS.md daily logs section

**Files:**
- Modify: `templates/workspace/AGENTS.md:89-95`

**Step 1: Update the Daily Logs section**

Replace lines 89-95:

```markdown
### Daily Logs (generated — not your problem)

The `memory/YYYY-MM-DD.md` files are generated by a nightly cron job that pulls the day's
memories from Hindsight and writes a structured log. You don't need to create or maintain
these. They exist so your human can review what happened, and so future sessions can
reference specific days.
```

With:

```markdown
### Daily Logs (generated — not your problem)

The `memory/YYYY-MM-DD.md` files are generated by a nightly cron (`nightly-memory.sh`)
that: (1) processes any session transcripts to extract and retain missed facts to
Hindsight, then (2) queries Hindsight for the day's memories and writes a structured log.
You don't need to create or maintain these. They exist so your human can review what
happened, and so future sessions can reference specific days.
```

**Step 2: Commit**

```bash
git add templates/workspace/AGENTS.md
git commit -m "docs: update AGENTS.md daily logs section to reflect nightly cron pipeline"
```

---

### Task 7: Update project CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

**Step 1: Update the Project Layout scripts section**

In the `scripts/` listing, replace:

```
  auto-retain.sh       # Stop hook: extract facts → Hindsight
```

With:

```
  log-session.sh       # SessionEnd hook: append session to manifest
  nightly-memory.sh    # Nightly cron: process transcripts + generate daily log
```

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md project layout for new memory scripts"
```

---

### Task 8: Run all tests

**Step 1: Run full bats test suite**

Run: `bats scripts/test/`
Expected: All tests PASS (log-session, nightly-memory, check-memory-size, health-check, setup)

**Step 2: Verify no references to auto-retain remain**

Run: `grep -r "auto-retain" scripts/ templates/ CLAUDE.md`
Expected: No matches

**Step 3: No commit** — verification only.
