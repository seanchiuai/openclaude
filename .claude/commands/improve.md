---
description: Analyze a domain of the codebase and produce an actionable improvement report
---

Analyze the **$ARGUMENTS** domain of this codebase and produce an improvement report.

## Step 0 — Discovery interview

Before doing any analysis, ask the user clarifying questions to understand priorities. Ask about:

- **Core purpose**: What is the single most important job this feature/domain does for users?
- **Target audience**: Who are the primary users and what is their technical level?
- **Pain points**: What are the known frustrations or complaints users have today?
- **Success metric**: How do you measure whether this domain is working well? (e.g. conversion rate, time-to-complete, error rate, retention)
- **Constraints**: Are there business, technical, or timeline constraints that limit what can change?
- **Priorities**: Rank what matters most — reliability, speed, UX polish, developer experience, scalability?

Wait for answers before proceeding. Use the responses to weight your analysis — improvements aligned with the stated priorities should rank higher.

## Steps

1. **Map the domain**: Identify all files, modules, and APIs related to `$ARGUMENTS`. Build a mental model of how they connect.
2. **Identify integrations**: List every third-party library, SDK, API, or service used within this domain (e.g. Stripe, Prisma, NextAuth, WebRTC, S3, etc.).
3. **Research best practices**: For each integration identified, use web search to look up current best practices, recommended patterns, and common pitfalls from the official documentation and community resources. Compare what the codebase does today against what the docs recommend.
4. **Audit against best practices**: Evaluate the current implementation for correctness, performance, security, accessibility, and maintainability. Incorporate findings from the integration research — flag anywhere the codebase deviates from recommended usage.
5. **Identify the target user experience**: Using the discovery answers, define what the ideal workflow looks like for the primary user.
6. **Generate improvements**: Propose concrete, high-impact changes — not cosmetic tweaks. Each improvement should meaningfully advance the user experience or code quality. Prioritize based on the user's stated goals and pain points.

## Output format

Return a structured report with these sections:

### Domain overview
Brief summary of what exists today (architecture, key files, data flow).

### Strengths
What the current implementation does well (2-3 bullets).

### Improvements
A numbered list of proposed changes, each with:
- **What**: One-sentence description
- **Why**: The problem it solves or the UX/DX gain
- **How**: Brief implementation approach (files to change, patterns to adopt)
- **Impact**: Low / Medium / High

Sort by impact descending.

### Quick wins
Any low-effort, high-value changes that could be shipped immediately.

### Risks & trade-offs
Potential downsides or migration concerns for the larger proposals.