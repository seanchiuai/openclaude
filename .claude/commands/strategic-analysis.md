---
description: Deep strategic analysis of recent changes - identify systemic issues and architectural improvements like a CTO/CEO
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebSearch
---

# Strategic Architecture Analysis

You are acting as both **CTO** (technical architecture, system design, code quality) and **CEO** (business impact, user trust, engineering velocity, ROI).

## Objective

Analyze recent codebase changes to identify **systemic issues** (not just bugs) and produce a comprehensive improvement report with actionable implementation plans.

## Phase 1: Data Collection

1. **Get recent commits** (default: 24-48 hours, or use $ARGUMENTS if specified):
   ```bash
   git log --since="48 hours ago" --oneline --stat
   git log --since="48 hours ago" --format="%H%n%s%n%b%n---"
   ```

2. **Analyze key diffs** - Focus on files with significant changes:
   ```bash
   git diff <first-commit>..<last-commit> -- <key-files>
   ```

3. **Check for patterns** in error handling, auth, async code, external API calls

4. **Review any incident notes** in memory files or docs/

## Phase 2: Pattern Recognition

Categorize findings into these systemic issue types:

| Category | What to Look For |
|----------|------------------|
| **Authentication** | Multiple auth mechanisms, inconsistent credential handling, env var confusion |
| **Async Execution** | Timeout issues, lost context, callback hell, race conditions |
| **External APIs** | Missing retries, no circuit breakers, assuming synchronous behavior |
| **Error Handling** | Inconsistent formats, swallowed errors, missing context, user-hostile messages |
| **State Management** | Scattered state, no single source of truth, hard to resume/retry |
| **Testing Gaps** | Untested paths, manual-only verification, missing integration tests |

For each issue found, document:
- **Symptom**: What failed or broke
- **Root cause**: Why it happened (architectural, not just code)
- **Business impact**: User trust, engineering time, velocity
- **Pattern**: Is this a one-off or systemic?

## Phase 3: CTO Analysis

For each systemic issue, design solutions considering:

1. **Architecture**
   - What abstraction is missing?
   - What pattern should be applied? (State machine, Circuit breaker, Retry wrapper, etc.)
   - How does this fit with existing codebase?

2. **Implementation**
   - Specific file paths and function signatures
   - Code examples (not pseudocode - real TypeScript)
   - Schema changes if needed
   - Migration path from current state

3. **Trade-offs**
   - Complexity added vs. reliability gained
   - Performance implications
   - Maintenance burden

## Phase 4: CEO Analysis

For each solution, evaluate:

1. **Business Impact**
   - How does this affect user experience?
   - What's the cost of NOT doing this?
   - How does this affect shipping velocity?

2. **Investment vs. ROI**
   - Engineering time required
   - Expected improvement in metrics (success rate, MTTR, etc.)
   - Opportunity cost

3. **Prioritization**
   - What must be done before production?
   - What can wait?
   - What's the right sequence?

## Phase 5: Report Generation

Create a comprehensive report at `docs/strategic-improvements-report.md` with:

### Structure

```markdown
# Strategic Improvements Report: [Project Name]

**Date:** YYYY-MM-DD
**Scope:** [What was analyzed]
**Audience:** Technical leadership, engineering team

## Executive Summary
- Number of systemic issues found
- Key insight (one sentence)
- Top recommendation

## Issue 1: [Category Name]

### Current State (Problem)
- Diagram showing current architecture/flow
- Why this is problematic
- Business impact

### Proposed State (Solution)
- Diagram showing target architecture
- Key design decisions

### Implementation Plan
- Actual code (TypeScript, not pseudocode)
- File paths
- Schema changes
- Migration steps

### Validation Checklist
- How to verify the fix works

[Repeat for each issue]

## Implementation Roadmap
| Phase | Week | Tasks | Deliverables |

## Success Metrics
| Metric | Current | Target | Measurement |

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |

## Conclusion
- Key insight
- Investment required
- ROI justification
- Clear recommendation
```

## Output Requirements

1. **Be specific** - No vague recommendations. Include file paths, function names, code.

2. **Show your work** - Include the data that led to conclusions (commit hashes, error messages, patterns found)

3. **Prioritize ruthlessly** - Not everything needs fixing. Focus on highest impact.

4. **Consider second-order effects** - How do fixes interact? What new problems might they create?

5. **Make it actionable** - Someone should be able to implement from this report without asking clarifying questions.

## Example Insights to Look For

- "We're using 4 different auth mechanisms across 3 environments with no abstraction"
- "Every external API call assumes success - no retries, no circuit breakers"
- "State is scattered across 5 different fields with no state machine"
- "Errors are swallowed in 3 places, making debugging impossible"
- "We're treating a distributed system like a monolith"

## Anti-Patterns to Flag

- Tactical fixes without addressing root cause
- Copy-paste code instead of abstractions
- "It works on my machine" assumptions
- Optimistic coding (assuming APIs always succeed)
- Missing observability (can't debug what you can't see)

---

After completing the analysis, update project memory (`MEMORY.md`) with key architectural insights for future reference.

$ARGUMENTS
