---
description: Sync .claude/commands, .claude/skills, and .claude/agents to all worktrees
---

# Sync Claude Commands, Skills & Agents

Sync `.claude/commands/`, `.claude/skills/`, and `.claude/agents/` from the current working directory to all other worktrees (and the main webapp if running from a worktree).

## Process

Run this bash script to perform the sync:

```bash
set -e

WEBAPP="$HOME/Desktop/webapp"
WORKTREES="$WEBAPP/.worktrees"
SOURCE="$(pwd)"

# Build list of all targets (main webapp + all worktree directories)
TARGETS=()
TARGETS+=("$WEBAPP")

# Active worktrees
for dir in "$WORKTREES"/*/; do
  [ -d "$dir" ] || continue
  TARGETS+=("${dir%/}")
done

# Validate source has the directories we expect
if [ ! -d "$SOURCE/.claude/commands" ] || [ ! -d "$SOURCE/.claude/skills" ]; then
  echo "ERROR: Source is missing .claude/commands or .claude/skills — aborting to avoid wiping targets."
  exit 1
fi

# Resolve source to absolute path for comparison
SOURCE_REAL=$(cd "$SOURCE" && pwd -P)

echo "Source: $SOURCE_REAL"
echo ""

SYNCED=0

for target in "${TARGETS[@]}"; do
  [ -d "$target" ] || continue
  TARGET_REAL=$(cd "$target" && pwd -P)

  # Skip self
  if [ "$SOURCE_REAL" = "$TARGET_REAL" ]; then
    continue
  fi

  # Ensure target has .claude directory
  mkdir -p "$target/.claude"

  # Sync commands, skills, and agents
  # Use --update to only overwrite older files, preserving worktree-specific additions
  rsync -a --exclude='.DS_Store' "$SOURCE/.claude/commands/" "$target/.claude/commands/"
  rsync -a --exclude='.DS_Store' "$SOURCE/.claude/skills/" "$target/.claude/skills/"
  [ -d "$SOURCE/.claude/agents" ] && rsync -a --exclude='.DS_Store' "$SOURCE/.claude/agents/" "$target/.claude/agents/"

  echo "Synced -> $target"
  SYNCED=$((SYNCED + 1))
done

echo ""
echo "Done. Synced to $SYNCED worktrees."
```

Report the results to the user.
