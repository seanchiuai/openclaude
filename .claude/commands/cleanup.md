---
description: Remove AI-generated code slop and inconsistencies
model: opus
---

# Cleanup

Check the diff against main, and remove all AI-generated slop introduced in this branch.

This includes:
- Extra comments that a human wouldn't add or are inconsistent with the rest of the file
- Extra defensive checks or try/catch blocks that are abnormal for that area of the codebase (especially if called by trusted / validated codepaths)
- Casts to `any` to get around type issues
- Any other style that is inconsistent with the file

Also double check your work and what you generated:
- Is it really complete?
- Did you approach it from different angles?

Think deeply and step-by-step about each change before removing or keeping it.

$ARGUMENTS
