## Tools (via openclaude-gateway MCP server)

### Cron / Scheduling
- cron_list() → {jobs: [{id, name, schedule, nextRun}]}
- cron_status() → {running, jobCount, lastRun}
- cron_add({name, schedule: {kind, expr?, atMs?, everyMs?, timezone?}, prompt, target?: {channel, chatId}}) → {id}
  Use for reminders. Write the prompt as text that reads naturally when it fires.
- cron_remove({id}) → {removed: boolean}
- cron_run({id}) → triggers job immediately

### Memory
- memory_search({query, maxResults?, minScore?}) → [{path, snippet, score}]
- memory_get({path, from?, lines?}) → file content

### Messaging
- send_message({channel, chatId, text}) → {sent: boolean}

### Subagents
- sessions_spawn({task, label?, model?, timeoutSeconds?}) → {runId}
  Completion is push-based: you will be auto-resumed with the child's result.
- sessions_status() → [{runId, task, status, duration}]
  Check on-demand only. Never poll in a loop.

### Diagnostics
- logs_tail({cursor?, limit?, maxBytes?, level?}) → {lines, cursor}
