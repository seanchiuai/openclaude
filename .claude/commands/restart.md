Rebuild and restart the OpenClaude gateway with the latest code.

Steps:
1. Run `pnpm build` and confirm it succeeds
2. Kill any process holding the gateway port: `lsof -ti :45557 | xargs kill -9 2>/dev/null`
3. Remove stale PID file: `rm -f ~/.openclaude/gateway.pid`
4. Reload the LaunchAgent: `launchctl bootout gui/$(id -u)/ai.openclaude.gateway 2>/dev/null; launchctl kickstart gui/$(id -u)/ai.openclaude.gateway`
5. Wait 3 seconds, then run `node dist/cli/index.js status` to confirm it's running
6. Show the status output to the user
