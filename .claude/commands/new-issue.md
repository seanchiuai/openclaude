---
description: Setup a new worktree for a GitHub issue or feature
argument-hint: <issue-number, URL, or feature description>
---

# New Worktree

## Input

The user provides one of:
- A GitHub issue number or URL (e.g. `342` or `https://github.com/minds-ai-co/webapp/issues/342`)
- A feature description in quotes (e.g. `"add dark mode toggle"`)

Determine the mode from the input:
- **Issue mode**: input is a number or GitHub URL
- **Feature mode**: input is a text description

## Procedure

### 1. Get context

**Issue mode:**
```bash
gh issue view <NUMBER> --repo minds-ai-co/webapp --json number,title,body
```
Extract the issue number, title, and body. Derive a short kebab-case slug from the title (e.g. "Implement Web Plugin" → `web-plugin`).

**Feature mode:**
Derive a short kebab-case slug from the description (e.g. "add dark mode toggle" → `dark-mode-toggle`). There is no issue number — use `none` where a number is needed.

### 2. Check for existing branches and issues

**Always run these checks before asking the user about branch creation:**

```bash
# Search for existing branches matching the topic (use keywords from the slug/title)
git branch -a --list '*<keyword>*'

# Search for existing GitHub issues matching the topic
gh issue list --repo minds-ai-co/webapp --search "<topic keywords>" --json number,title,state --limit 10
```

Present any findings to the user:
- If matching **branches** exist: list them and ask if the user wants to reuse one instead of creating a new branch
- If matching **issues** exist: list them and ask if the user wants to link to an existing issue
- If a matching branch already has a worktree: warn the user and ask how to proceed

### 3. Ask about branch creation

Based on the findings from step 2, ask the user:
- **Create new branch** `<slug>` from `staging` (Recommended) — for new work
- **Use existing branch** `<name>` — if a relevant branch was found in step 2
- **Use existing branch** (other) — if the user wants to specify a different branch

### 3. Create the worktree

```bash
WEBAPP="$HOME/Desktop/webapp"
WORKTREES="$WEBAPP/.worktrees"
```

If creating a new branch:
```bash
git -C "$WEBAPP" worktree add "$WORKTREES/<slug>" -b <slug> staging
```

If using an existing branch:
```bash
git -C "$WEBAPP" worktree add "$WORKTREES/<slug>" <slug>
```

### 4. Copy template files from `$WORKTREES/_template`

Copy the following into the new worktree:

```bash
# Copy .claude directory (commands, skills, settings — exclude junk)
rsync -a --exclude='.DS_Store' "$WORKTREES/_template/.claude/" "$WORKTREES/<slug>/.claude/"

# Copy CLAUDE.md template
cp "$WORKTREES/_template/CLAUDE.md.template" "$WORKTREES/<slug>/CLAUDE.md"

# Copy issue-tasks.md template into .claude/docs/
mkdir -p "$WORKTREES/<slug>/.claude/docs"
cp "$WORKTREES/_template/issue-tasks.md.template" "$WORKTREES/<slug>/.claude/docs/issue-tasks.md"
```

### 5. Populate templates with context

**Do NOT modify CLAUDE.md** — leave it as the raw template. The working session will fill it in.

**issue-context.md** — Create `.claude/docs/issue-context.md` with the issue context:
```markdown
---
issue: <NUMBER or none>
title: <TITLE or feature description>
branch: <slug>
created: <YYYY-MM-DD>
---

## Summary
<1-3 sentence summary from the issue body, or the feature description>

## Issue Body
<Full issue body (issue mode) or feature description (feature mode)>
```

**issue-tasks.md** — Replace frontmatter and extract tasks:
- `task` → issue title or feature description
- `issue` → issue number or `none`
- `branch` → the derived slug
- `created` → today's date
- **Issue mode**: Extract actionable tasks from the issue body into `## Items`
- **Feature mode**: Add default items: understand existing code → implement → test
- If no clear tasks in the issue, use defaults: understand → implement → test

### 6. Choose environment

Ask the user which environment to connect to. **Make a suggestion based on the issue context:**

- **Testing** (`webapp-testing-ghywu.ondigitalocean.app`) — Recommend for: new features, UI work, experimental changes, most development work. This is the safest default.
- **Staging** (`staging.getminds.ai`) — Recommend for: pre-release validation, integration testing, changes that need to be verified against staging data.
- **Production** (`getminds.ai`) — Recommend for: production debugging, hotfixes, data investigations. Warn the user about write risks.

Present your suggestion with reasoning, e.g.:
> "This issue is about adding a new UI component, so I'd recommend **Testing** — it's the safest for development. Would you like to use a different environment?"

### 7. Copy and configure environment files

First, copy the base `.env` from the main webapp (contains all API keys and non-environment-specific vars):

```bash
cp "$WEBAPP/.env" "$WORKTREES/<slug>/.env"
```

**IMPORTANT — Supabase key confirmation:** The `.env` copied from the main branch contains Supabase keys (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) that point to the **main branch's Supabase project**. These will be overridden in the next step by the chosen environment's keys, but the user must confirm they are aware that the main branch Supabase keys were copied. **Ask the user to confirm this fact before continuing.** Do not proceed until they explicitly confirm.

Then apply the environment-specific overrides from the template:

```bash
ENV_OVERRIDE="$WORKTREES/_template/envs/<chosen-env>.env"
if [ -f "$ENV_OVERRIDE" ]; then
  while IFS='=' read -r key value; do
    # Skip empty lines and comments
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    # Escape special characters in value for sed
    escaped_value=$(printf '%s\n' "$value" | sed 's/[&/\]/\\&/g')
    # Replace the var in .env, or append if not present
    if grep -q "^${key}=" "$WORKTREES/<slug>/.env"; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$WORKTREES/<slug>/.env"
    else
      echo "${key}=${value}" >> "$WORKTREES/<slug>/.env"
    fi
  done < "$ENV_OVERRIDE"
fi
```

Environment override files are stored in `$WORKTREES/_template/envs/`:
- `testing.env` — Testing branch (hksockvteivfkaylstbv)
- `staging.env` — Staging branch (tsnajfhzqfuzafsgbgip)
- `production.env` — Production (wrndkbphjywvqrhztsml)

### 8. Install dependencies

```bash
cd "$WORKTREES/<slug>" && npm install
```

### 9. Report completion

Tell the user:
- Worktree path
- Branch name
- Chosen environment (testing/staging/production) and its SITE_URL
- What was populated
- Remind them to `cd` into the worktree and run `claude` to start working
