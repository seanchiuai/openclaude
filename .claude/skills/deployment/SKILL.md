---
name: deployment
description: DigitalOcean App Platform deployment architecture and procedures for the Minds AI webapp. Use when asked about "deployment", "how to deploy", "staging vs production", "DO app platform", "Dockerfile", "environment variables", "build process", or "deploy pipeline". Covers staging/production environments, Docker multi-stage build, GitHub Actions workflow, and env var management. Do NOT use to actually trigger deploys (deployments are manual-only by Alexander). Do NOT modify DO env vars directly (use GitHub Environments workflow).
---

# Deployment — DigitalOcean App Platform

## Architecture

Single template, two environments, one workflow.

| Environment | App ID | Branch | URL |
|---|---|---|---|
| **Staging** | `bcfd06df-81cc-4cd9-8429-1ae065cf2799` | `staging` | staging.getminds.ai |
| **Production** | `e0c8ac73-bc1c-434b-9e19-0dab708cb777` | `main` | getminds.ai |

## Files

| File | Purpose |
|---|---|
| `digitalocean-app.template.yaml` | App spec template with `__PLACEHOLDERS__` |
| `.github/workflows/deploy-digitalocean.yml` | Deploys on push (infra changes only) |
| `deploy/substitute-envs.sh` | Replaces placeholders with env values |

## How Deployment Works

### Code changes (auto-deploy)
Every push to `staging` or `main` triggers DO's built-in auto-deploy (`deploy_on_push: true`). No workflow needed.

### Infrastructure changes (workflow)
When `digitalocean-app.template.yaml`, `cron.Dockerfile`, or `python-cron.Dockerfile` change:
1. Workflow detects branch → determines environment
2. Replaces structural placeholders (app name, branch, domains, valkey)
3. Injects env var values from GitHub Secrets
4. Pushes spec to DO via `doctl apps update`
5. Triggers deployment via `doctl apps create-deployment`

### Manual deploy
Actions → Deploy to DigitalOcean → Run workflow → Select environment

## App Components

| Component | Type | Purpose |
|---|---|---|
| `web` | Service | Nuxt 3 SSR app (port 3000) |
| `processor` | Worker | Background job processor (BullMQ) |
| 6 cron jobs | Jobs | digest, cleanup-stuck-jobs, cleanup-unused-numbers, watch-knowledge-items, demo-analytics, renew-calendar-webhooks |

## Environment Variables

Uses **GitHub Environments** (`staging` and `production`). Same secret names, different values per environment.

```
Settings → Environments → staging → Secrets → SUPABASE_URL = "https://staging..."
Settings → Environments → production → Secrets → SUPABASE_URL = "https://prod..."
```

### Adding a new env var
1. Add to `digitalocean-app.template.yaml`:
   ```yaml
   - key: VAR_NAME
     value: __VAR_NAME__
     scope: RUN_AND_BUILD_TIME
   ```
2. Add `VAR_NAME` to the `VARS` array in `deploy/substitute-envs.sh`
3. Add to workflow's "Substitute env vars" step:
   ```yaml
   VAR_NAME: ${{ secrets.VAR_NAME }}
   ```
4. Add the secret to both GitHub Environments (staging + production)

### NUXT_ prefix conventions (Nuxt 3)
- `NUXT_PUBLIC_*` → auto-mapped to `runtimeConfig.public.*` (client-visible)
- `NUXT_*` → auto-mapped to `runtimeConfig.*` (server-only)
- Regular vars → accessed via `process.env.VAR_NAME`

## ⛔ CRITICAL: NEVER modify DO env vars directly

**DO NOT use `doctl apps update` to add/change/remove env vars.**
This bypasses the GitHub Environments pipeline and injects encrypted secrets directly into the DO app spec, causing:
- Deploy failures (spec conflicts, container crashes on rollback)
- Duplicate/orphaned env vars that can't be managed
- Loss of the single-source-of-truth (GitHub Environments)

**The ONLY way to manage env vars:**
1. Add/update the secret in GitHub Environments (staging + production)
2. If it's a new var: add placeholder to template + substitute script + workflow
3. Trigger the workflow (push to branch or `workflow_dispatch`)

**If you need to check current env vars:** read the GitHub Environment secrets, NOT the DO app spec.

## Common Issues

### YAML parse errors
- `run_command` with special chars must be double-quoted
- `cron` expressions with `*` must be quoted: `'*/15 * * * *'`

### Spec changes not reflected
Always use the GitHub workflow to update specs. Manual `doctl apps update` is only for emergencies and will be overwritten on next workflow run.

## Monitoring

```bash
# List recent deployments
doctl apps list-deployments <APP_ID> --format ID,Phase,Progress,Created

# View logs
doctl apps logs <APP_ID> --type run --component web
doctl apps logs <APP_ID> --type build --component web
```

## Git Rules
- Never push directly to `main` — go through `staging` first
- Spec changes follow same rule: staging → verify → merge to main
