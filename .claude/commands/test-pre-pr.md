---
description: Run all pre-PR checks (code tests, API smoke tests, QA checklist) for the current branch
argument-hint: "[branch name, default: current branch]"
---

You are a pre-PR testing agent. Run every step below **sequentially** and produce a single consolidated report at the end.

## Step 1 — Determine scope

Run `git diff main...HEAD --name-only` (or `git diff main...$ARGUMENTS --name-only` if an argument was provided) to find all changed files.

Categorise each changed file into one of these buckets:
- **server-utils** — `server/utils/*.ts`
- **api-routes** — `server/api/**`
- **components** — `components/**` or `pages/**`
- **prompts** — `prompts/**`
- **config** — config/yaml/env files, `nuxt.config.ts`, `package.json`
- **other**

Print the categorised file list so the user can see the scope.

---

## Step 2 — Code-level tests for changed pure modules

For each file in the **server-utils** bucket, check whether it exports **pure functions** (no DB/Prisma, no LLM calls, no H3 request/response, no imports from `ai` or `@ai-sdk/*` or `prisma`). Only test truly pure functions.

For each testable module:

1. **Read the source file** to understand the function signatures, types, and behavior.
2. **Generate test cases** by analyzing the code:
   - Identify edge cases from conditionals and branches
   - Test boundary values (empty input, null, zero, max values)
   - Test the happy path for each exported function
   - Test error/rejection paths
3. **Write a self-contained TypeScript test script** to `/tmp/test-pre-pr-<module>-<timestamp>.ts`:
   - **Copy** the function source and type definitions directly into the file (do NOT import from `~/server/...` or use Nuxt aliases — they won't resolve outside Nuxt)
   - Use a minimal inline assertion helper (no external test framework):
     ```ts
     let passed = 0, failed = 0;
     function assert(condition: boolean, label: string) {
       if (condition) { passed++; console.log(`  ✅ ${label}`); }
       else { failed++; console.error(`  ❌ ${label}`); }
     }
     ```
   - Print a summary line: `MODULE: <n> passed, <n> failed`
   - Exit with code 1 if any test failed

Run each script with `npx tsx /tmp/test-pre-pr-<module>-<timestamp>.ts` and capture stdout/stderr plus exit code.

---

## Step 3 — API smoke test

Check whether a dev server is running:
```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null
```

- **If 200:** If any changed files are under `server/api/`, list those endpoints and try a GET request to each (expect 2xx or 4xx auth errors, not 500). Record each result.
- **If not reachable:** Print `⏭️ Server not running at localhost:3000 — skipping API smoke tests` and move on.

---

## Step 4 — Generate QA checklist

For each changed file, generate manual test items by analyzing what the file does:

- **API route changes** → test the endpoint's core functionality (P0)
- **Component/page changes** → visual check of the changed UI (P0)
- **Server utility changes** → test the feature that uses the utility (P1)
- **Security-related changes** (auth, rate limiting, input sanitization) → verify the security behavior (P1)
- **Prompt changes** → check agent personality and behavior in chat (P1)
- **Asset changes** → verify assets render correctly (P2)
- **Config changes** → verify app starts and runs correctly (P1)

For files not matching any pattern, add a generic "Review changes in `<file>`" item at P2.

Group items by category: **Backend → Frontend → Agent Behaviour → Security**.

---

## Step 5 — Summary report

Print a single consolidated report in this exact format:

```markdown
## Pre-PR Test Results

### Scope
- Branch: `<branch>`
- Changed files: <count>
- Testable modules: <count>

### Code Tests
| Module | Tests | Passed | Failed |
|--------|-------|--------|--------|
| ...    | ...   | ...    | ...    |

### API Smoke Tests
| Endpoint | Status | Result |
|----------|--------|--------|
| ...      | ...    | ...    |
*(or "Skipped — server not running")*

### QA Checklist
**Backend**
- [ ] P0: ...
- [ ] P1: ...

**Frontend**
- [ ] P0: ...

**Agent Behaviour**
- [ ] P1: ...

**Security**
- [ ] P1: ...

### Verdict
✅ Ready for PR — all code tests passed
*(or)*
⚠️ Issues found — <N> test(s) failed, review above
```

Clean up any `/tmp/test-pre-pr-*` files after reporting.
