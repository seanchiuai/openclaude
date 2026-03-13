---
description: Trace root cause of an issue — flags unknowns, never guesses
---

Think deeply and methodically about the following issue. Sacrifice speed for accuracy. Your job is to find the **root cause** — the underlying reason the bug was possible in the first place, not just the surface-level symptom.

**Issue:** $ARGUMENTS

## Instructions

1. **Gather evidence first** — if no log output or error trace was provided, ask for it before investigating. Rule out environment issues (missing env vars, wrong DB connection, stale cache, misconfigured test setup).
2. **Trace the execution path** — follow the call chain from entry point through every boundary (API calls, DB queries, type coercions). When you find where it breaks, keep asking *why* — the first broken thing you find is usually a symptom, not the cause.
3. **Flag unknowns** — if anything is unclear, ambiguous, or undocumented, call it out explicitly. Do not fill gaps with silent assumptions.
4. **Assess severity** — quick fix, moderate refactor, or architectural change.
5. **Propose fix steps** — minimal, ordered steps to resolve. Note any risks or related paths that need the same treatment.

## Constraints

- Do NOT proceed with changes unless you have high confidence in the root cause.
- If you cannot confidently identify the cause, add targeted logging/debugging output instead and report what to test next.
- Evidence over assumptions. If you must assume something, label it as such.
