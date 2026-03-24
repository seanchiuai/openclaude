---
description: Curate MEMORY.md and manage Hindsight long-term memory
---

# Memory

Manage the two-tier memory system: MEMORY.md (curated cheat sheet, 50-line cap)
and Hindsight (semantic long-term memory).

## Commands

Parse the user's request to determine the action:

### "curate" / "clean up memory" / "tidy memory"

1. Read `workspace/MEMORY.md` and count lines
2. Use Hindsight `reflect` to check what's most important right now
3. Identify stale entries (outdated facts, completed projects, old dates)
4. For each stale entry: `retain` it to Hindsight first, then remove from MEMORY.md
5. Report what was removed, what was kept, and current line count

### "what do I know about X" / "recall X"

1. Use Hindsight `recall` with the user's query
2. Also search MEMORY.md for relevant entries
3. Present findings from both sources, labeled by origin

### "remember X" / "retain X"

1. Use Hindsight `retain` to store the fact immediately
2. If the fact is critical enough for every session, also add to MEMORY.md
   (check line count first — if at cap, curate before adding)

### "reflect on X"

1. Use Hindsight `reflect` with the user's question
2. Present the synthesis — patterns, trends, connections across memories

### "memory status"

1. Count lines in MEMORY.md (report vs 50-line cap)
2. Use Hindsight `recall` with a broad query to estimate memory volume
3. Check if `workspace/memory/` has recent daily logs
4. Report: MEMORY.md usage, Hindsight health, latest daily log date
