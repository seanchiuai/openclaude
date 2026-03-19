---
description: Check if the dev server is running and fix any blocking errors
---

# Fix Dev Server

1. Check if the dev server is already running by reading `dev.log` or curling `http://localhost:3000/`.
2. If it's running and healthy — stop, you're done.
3. If it's not running, start it with `npm run dev` in the background.
4. If there are errors preventing the site from loading, read the error output and fix them.
5. After fixing, verify the site loads successfully.

$ARGUMENTS
