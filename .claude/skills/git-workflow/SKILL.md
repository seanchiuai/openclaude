---
name: git-workflow
description: Git branching strategy and commit conventions for the Minds AI webapp. Use when creating branches, making commits, opening PRs, resolving merge conflicts, or following the staging-to-production workflow. Covers branch naming (feature/, fix/, chore/), commit message format, PR creation targeting staging, and the rule that only Alexander merges staging to main. Do NOT use for deployment procedures (use deployment skill) or CI/CD pipeline details.
---

# Git Workflow — Local Development Rules

Work like a senior dev. No cowboy commits.

## Branch Strategy

- **`staging`** is the integration branch. All work targets staging.
- **`main`** is production. **NEVER merge to main.** Only Alexander merges staging → main.
- Feature branches: `feature/<name>`, `fix/<name>`, `chore/<name>`

## Before Any Work

```bash
git fetch origin
git checkout staging
git pull origin staging
```

Always start from a fresh staging. Never work on a stale branch.

## Making Changes

1. **Create a feature branch** from staging:
   ```bash
   git checkout -b fix/descriptive-name staging
   ```
2. Make your changes, commit with clear messages
3. **Pull before push** — always:
   ```bash
   git fetch origin
   git rebase origin/staging  # or merge, but rebase preferred for clean history
   ```
4. Push and create PR targeting `staging`:
   ```bash
   git push origin fix/descriptive-name
   gh pr create --base staging --title "fix: descriptive title"
   ```

## Commit Hygiene

- **Atomic commits** — one logical change per commit
- **Conventional commits**: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`
- No "WIP" or "tmp" commits on shared branches
- Squash fixup commits before PR

## Never Do

- ❌ Push directly to `main`
- ❌ Force push to `staging` or `main` without explicit permission from Alexander
- ❌ Commit secrets, API keys, or credentials (use `pass show` at runtime)
- ❌ Commit debug/console.log statements
- ❌ Push without pulling first
- ❌ Leave merge conflicts unresolved
- ❌ Create massive PRs — keep them focused and reviewable

## Cherry-Picking

When selectively applying commits:
```bash
git cherry-pick <sha> --no-edit    # clean pick
git cherry-pick <sha> --no-commit  # stage changes without committing (for partial picks)
```

If a cherry-pick has conflicts:
- Resolve manually
- `git add <files> && git cherry-pick --continue`
- Or `git cherry-pick --abort` to bail

## Resolving Conflicts

1. Read the conflict markers carefully
2. Understand both sides before choosing
3. Test after resolution
4. Never blindly accept "ours" or "theirs"

## Before Pushing — Checklist

- [ ] `git fetch origin && git rebase origin/staging` (or target branch)
- [ ] Code compiles / builds without errors
- [ ] No debug logging left in
- [ ] No hardcoded secrets
- [ ] Commit messages are clean
- [ ] PR targets `staging`, not `main`

## Deploy Flow

```
feature branch → PR to staging → staging auto-deploys → verify on staging
                                                        ↓
                              Alexander merges staging → main → production auto-deploys
```

**You NEVER trigger deploys.** Deploys happen automatically via GitHub Actions on push to staging/main. The `deploy-digitalocean.yml` workflow handles spec substitution and `doctl apps update`.

## Preserving History

When resetting branches, always tag the old HEAD first:
```bash
git tag archive/<description>-<date> <old-sha>
git push origin archive/<description>-<date>
```

This ensures we can always access old commits even after force pushes.

## Stale Tracking Refs

After force pushes, local tracking refs may be stale. Use `git ls-remote origin <branch>` to verify actual remote state if `origin/<branch>` seems wrong after a fetch.
