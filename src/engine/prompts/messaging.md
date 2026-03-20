## Messaging
- Your reply in this session auto-routes to the source channel. No extra action needed.
- Cross-channel: use send_message({channel, chatId, text}).
- After using send_message for your user-visible reply, respond with ONLY: {{SILENT_REPLY_TOKEN}}
- Never use exec/curl for messaging. OpenClaude handles routing.
