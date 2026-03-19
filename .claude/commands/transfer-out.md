---
description: Prepare this workspace for transfer to another computer
---

Prepare this workspace for transfer to another computer. Execute all steps in order.

## Step 1: Check Worktree Remote Tracking

For every worktree (excluding the parent webapp), check if its branch exists on the remote. Run this as a single bash script:

```bash
set -e
WEBAPP="$HOME/Desktop/webapp"
WORKTREES="$WEBAPP/.worktrees"

echo "=== Checking worktree remote tracking ==="

for dir in "$WORKTREES"/*/; do
  [ "$(basename "$dir")" = "_template" ] && continue
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -z "$branch" ]; then
    echo "WARN: $name - could not determine branch"
    continue
  fi

  tracking=$(git -C "$dir" rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true)
  if [ -z "$tracking" ]; then
    echo "NO REMOTE: $name ($branch) — needs to be pushed"
  else
    echo "OK: $name ($branch) -> $tracking"
  fi
done
```

If any worktrees have no remote tracking branch, present the list to the user and ask for confirmation before pushing them. **Do NOT push without user approval.** Once confirmed, push each untracked branch:

```bash
git -C "$dir" push -u origin "$branch"
```

Skip any branches the user declines.

## Step 2: Report Uncommitted Changes

**IMPORTANT: Do NOT commit or push the parent webapp (`$HOME/Desktop/webapp/`). The user manages that manually.**

Before committing anything, scan all worktrees and report what has uncommitted changes. For each worktree in `$WEBAPP/.worktrees/issue-*/`:

1. Run `git -C <dir> status --short` to check for changes
2. Collect results into a summary table with columns: Worktree | Branch | Uncommitted Files (count) | Details (brief list of changed files)
3. Skip worktrees with no changes

Present this table to the user and ask for confirmation before proceeding. Wait for the user to confirm.

## Step 3: Commit and Push Worktrees

Only proceed after user confirmation from Step 2.

For each worktree that had uncommitted changes:

1. `cd` into the directory
2. Run `git diff --stat` to understand the changes
3. Stage files, excluding secrets: `git add -A -- ':!.env' ':!.env.*' ':!credentials*' ':!*.pem' ':!*.key'`
4. Write a descriptive commit message based on the actual changes (not just "transfer: sync all changes") — review the diff and summarize the nature of the work
5. `git push`

**If 3+ worktrees have uncommitted changes**, launch parallel subagents (one per worktree) to handle the diff review, staging, commit message writing, and push concurrently. Each subagent should read the diff for its worktree and produce an appropriate commit message.

## Step 4: Create Transfer Bundle

Create a zip containing `.env`, `.claude/`, and a worktree manifest from all workspaces. Run this as a single bash script:

```bash
set -e
WEBAPP="$HOME/Desktop/webapp"
WORKTREES="$WEBAPP/.worktrees"
BUNDLE="/tmp/transfer-bundle-staging"
ZIP_PATH="$HOME/Downloads/transfer-bundle.zip"

rm -rf "$BUNDLE"
rm -f "$ZIP_PATH"

# Parent webapp
mkdir -p "$BUNDLE/webapp"
cp -L "$WEBAPP/.env" "$BUNDLE/webapp/.env" 2>/dev/null || echo "WARN: no webapp .env"
cp -RL "$WEBAPP/.claude" "$BUNDLE/webapp/.claude" 2>/dev/null || echo "WARN: no webapp .claude"

# Generate worktree manifest: maps directory name -> branch name
echo "=== Generating worktree manifest ==="
MANIFEST="$BUNDLE/worktree-manifest.txt"
> "$MANIFEST"

# Active worktrees (issue-*)
for dir in "$WORKTREES"/*/; do
  [ "$(basename "$dir")" = "_template" ] && continue
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  branch=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "UNKNOWN")
  echo "$name=$branch" >> "$MANIFEST"
  mkdir -p "$BUNDLE/worktrees/$name"
  cp -RL "$dir/.claude" "$BUNDLE/worktrees/$name/.claude" 2>/dev/null || true
  if [ -f "$dir/.env" ] && [ ! -L "$dir/.env" ]; then
    cp "$dir/.env" "$BUNDLE/worktrees/$name/.env"
  fi
done

echo "Manifest contents:"
cat "$MANIFEST"

cd "$BUNDLE" && zip -r "$ZIP_PATH" . && cd -
rm -rf "$BUNDLE"
echo "Bundle created at $ZIP_PATH"
```

Verify the zip was created and report its size. Remind the user to manually transfer `~/Downloads/transfer-bundle.zip` to the other computer (e.g., AirDrop, USB, cloud drive).

## Step 5: Summary

Print a final summary table with columns: Worktree | Branch | Remote Tracking | Status (committed/no changes/error). Remind the user to transfer `~/Downloads/transfer-bundle.zip` to the other computer.
