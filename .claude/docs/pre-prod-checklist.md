# Pre-Production Checklist

## Verified

- [x] Telegram bot connects and receives messages
- [x] Claude Code CLI auth (OAuth/Pro subscription)
- [x] Memory injection into system prompt
- [x] Skill triggers (`/standup` etc.)
- [x] Cron list via `/cron` command
- [x] Session continuity (`--session-id` / `--resume`)
- [x] `/reset` clears session
- [x] MCP server path fix in spawn.ts
- [x] 531 unit tests passing (edge cases, config, pool, spawn, router, cron, HTTP API, chunking, skills)

## Outstanding — Manual Telegram Testing

- [ ] **MCP gateway tools via agent** — send "Remind me every hour to check emails", verify Claude calls `cron_add` through MCP
- [ ] **Agent memory search** — ask something that triggers agent to use `memory_search` tool
- [ ] **Agent send_message** — verify agent can send cross-channel messages via MCP tool
- [ ] **Long message chunking** — send prompt that produces >4096 char response, verify Telegram splits correctly
- [ ] **`/stop` command** — start a long-running task, `/stop` it, verify session killed cleanly
- [ ] **Cron execution + delivery** — add a cron job, wait for it to fire, verify message delivered to Telegram
- [ ] **Idle session auto-reset** — hard to test live (4hr timeout), but confirm logic works
- [ ] **Concurrent sessions** — two different Telegram chats running simultaneously
- [ ] **Error recovery** — Claude Code subprocess crash mid-task, verify error message returned to user

## Outstanding — Code Review

- [ ] **Heartbeat config** — is it wired up and functional?
- [ ] **Gateway URL env var** — confirm `GATEWAY_URL` propagates correctly to MCP server in spawned processes
- [ ] **Drain semantics** — graceful shutdown kills no in-flight sessions
