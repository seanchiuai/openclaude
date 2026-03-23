---
description: Set reminders and manage personal tasks
---

# Remind

Help the user set reminders and manage their personal task list.

## Capabilities

- **Set a reminder** — Store in Hindsight with `retain` and tag with a future date
- **List reminders** — Use `recall` to find upcoming reminders
- **Complete a reminder** — Mark as done in Hindsight
- **Check overdue** — During heartbeats, recall and surface overdue items

## Storage

Use Hindsight `retain` for all reminders. Include the date/time in the content:
> "Reminder for 2026-03-25: Call dentist to reschedule appointment"

This ensures temporal recall can surface them at the right time.
