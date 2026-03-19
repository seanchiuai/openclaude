---
description: Pull latest changes and restore workspace configuration from another computer
---

Pull latest changes and restore workspace configuration from another computer. Execute all steps in order.

## Step 1: Extract Bundle and Read Manifest

Extract the transfer bundle and read the worktree manifest. Run this as a single bash script:

```bash
set -e
WEBAPP="$HOME/Desktop/webapp"
ZIP_PATH="$HOME/Downloads/transfer-bundle.zip"
EXTRACT="/tmp/transfer-bundle-extract"

if [ ! -f "$ZIP_PATH" ]; then
  echo "ERROR: No transfer bundle found at $ZIP_PATH"
  exit 1
fi

rm -rf "$EXTRACT"
unzip -o "$ZIP_PATH" -d "$EXTRACT"

if [ -f "$EXTRACT/worktree-manifest.txt" ]; then
  echo "=== Worktree Manifest ==="
  cat "$EXTRACT/worktree-manifest.txt"
else
  echo "WARN: No worktree-manifest.txt found in bundle."
fi

echo "Extraction complete."
```

## Step 2: Pull Parent Webapp

Pull latest changes in the parent workspace:

```bash
cd $HOME/Desktop/webapp && git fetch --all && git pull
```

Report any merge conflicts or failures.

## Step 3: Identify Worktree Differences

Compare local worktrees against the manifest to find what needs to change. Run this as a single bash script:

```bash
set -e
WEBAPP="$HOME/Desktop/webapp"
WORKTREES="$WEBAPP/.worktrees"
EXTRACT="/tmp/transfer-bundle-extract"
MANIFEST="$EXTRACT/worktree-manifest.txt"

cd "$WEBAPP"
git fetch --all

# Build list of expected worktree names from manifest
declare -A EXPECTED_WORKTREES
if [ -f "$MANIFEST" ]; then
  while IFS='=' read -r name branch; do
    [ -n "$name" ] && EXPECTED_WORKTREES["$name"]="$branch"
  done < "$MANIFEST"
fi

echo "=== Expected worktrees (from manifest) ==="
for name in "${!EXPECTED_WORKTREES[@]}"; do
  echo "  $name -> ${EXPECTED_WORKTREES[$name]}"
done

# Find worktrees to DELETE (local but not in manifest)
echo ""
echo "=== Local worktrees NOT in manifest (candidates for deletion) ==="
TO_DELETE=0
for dir in "$WORKTREES"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  [ "$name" = "_template" ] && continue
  if [ -z "${EXPECTED_WORKTREES[$name]+x}" ]; then
    branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "UNKNOWN")
    echo "  DELETE: $name ($branch)"
    TO_DELETE=$((TO_DELETE + 1))
  fi
done
[ "$TO_DELETE" -eq 0 ] && echo "  (none)"

# Find worktrees to CREATE (in manifest but not local)
echo ""
echo "=== Worktrees to create (in manifest but not local) ==="
TO_CREATE=0
for name in "${!EXPECTED_WORKTREES[@]}"; do
  target="$WORKTREES/$name"
  if [ ! -d "$target" ]; then
    echo "  CREATE: $name -> ${EXPECTED_WORKTREES[$name]}"
    TO_CREATE=$((TO_CREATE + 1))
  fi
done
[ "$TO_CREATE" -eq 0 ] && echo "  (none)"

# Find worktrees to PULL (exist both locally and in manifest)
echo ""
echo "=== Worktrees to pull (already exist) ==="
for name in "${!EXPECTED_WORKTREES[@]}"; do
  target="$WORKTREES/$name"
  if [ -d "$target" ]; then
    echo "  PULL: $name"
  fi
done
```

Present the results to the user as a table. **If there are any worktrees marked for deletion, ask the user for explicit confirmation before deleting them.** Do NOT delete without approval.

## Step 4: Execute Worktree Sync

Only proceed after user confirmation from Step 3 (especially for deletions).

**Delete** approved worktrees:

```bash
git worktree remove --force "$WORKTREES/<name>" 2>/dev/null || rm -rf "$WORKTREES/<name>"
git worktree prune
```

**Create** missing worktrees from remote branches:

```bash
# For each worktree to create:
if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git worktree add "$target" -b "$branch" "origin/$branch" 2>/dev/null \
    || git worktree add "$target" "$branch" 2>/dev/null \
    || echo "ERROR: Could not create worktree $name for branch $branch"
else
  echo "ERROR: Remote branch origin/$branch not found. Skipping $name."
fi
```

**Pull** existing worktrees:

```bash
git -C "$target" pull || echo "WARN: pull failed for $name"
```

**Verify remote tracking** for all worktrees:

```bash
tracking=$(git -C "$target" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)
if [ -z "$tracking" ]; then
  git -C "$target" branch --set-upstream-to="origin/$branch" "$branch" 2>/dev/null \
    || echo "WARN: Could not set upstream for $name"
fi
```

Print the final `git worktree list` output.

Report which worktrees were created, removed, pulled, and any errors.

## Step 5: Restore .env and .claude Files

Restore `.env` and `.claude/` files from the bundle. **Merge** into existing `.claude/` directories — overwrite files with the same name but preserve files that only exist locally.

Run this as a single bash script:

```bash
set -e
WEBAPP="$HOME/Desktop/webapp"
WORKTREES="$WEBAPP/.worktrees"
EXTRACT="/tmp/transfer-bundle-extract"

# Parent webapp
if [ -f "$EXTRACT/webapp/.env" ]; then
  cp -f "$EXTRACT/webapp/.env" "$WEBAPP/.env"
  echo "Restored: webapp/.env"
fi
if [ -d "$EXTRACT/webapp/.claude" ]; then
  mkdir -p "$WEBAPP/.claude"
  rsync -a "$EXTRACT/webapp/.claude/" "$WEBAPP/.claude/"
  echo "Merged: webapp/.claude/"
fi

# Worktrees
for dir in "$EXTRACT/worktrees"/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  target="$WORKTREES/$name"
  if [ ! -d "$target" ]; then
    echo "SKIP: $name (worktree does not exist)"
    continue
  fi
  if [ -d "$dir/.claude" ]; then
    mkdir -p "$target/.claude"
    rsync -a "$dir/.claude/" "$target/.claude/"
    echo "Merged: worktrees/$name/.claude/"
  fi
  if [ -f "$dir/.env" ]; then
    cp -f "$dir/.env" "$target/.env"
    echo "Restored: worktrees/$name/.env"
  fi
done

rm -rf "$EXTRACT"
echo "File restoration complete."
```

## Step 6: Clean Up Bundle

Delete the transfer bundle:

```bash
rm -f "$HOME/Downloads/transfer-bundle.zip"
echo "Cleaned up transfer-bundle.zip"
```

## Step 7: Summary

Print a summary table with columns: Worktree | Branch | Remote Tracking | Action (created/removed/pulled/error).
