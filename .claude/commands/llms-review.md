---
description: Send a prompt to multiple LLM CLIs in parallel and compile a unified report
argument-hint: <prompt or topic to review>
---

# LLMs Review

Send a prompt to multiple LLM CLIs in parallel and compile their responses into a unified report.

## Usage

```
/llms-review <prompt or topic to review>
```

If no argument is provided, use the current conversation context to formulate the review prompt.

## Instructions

1. **Detect available LLM CLIs** by running `which gemini`, `which claude`, `which codex` to see what's installed.

2. **Launch all available CLIs in parallel** as background bash commands:

   - **Gemini CLI**: Pipe the prompt via stdin:
     ```bash
     echo "<prompt>" | gemini
     ```

   - **Claude Code CLI** (as a separate instance): Must unset CLAUDECODE env var to avoid nested session block, and use `-p` flag for print mode:
     ```bash
     unset CLAUDECODE && claude --model opus -p "<prompt>"
     ```

   - **Codex CLI**: Use `exec` subcommand from within a git repo. Do not specify a model — let it use its default:
     ```bash
     cd <git-repo> && codex exec --full-auto "<prompt>"
     ```
     If codex fails, skip it and note the failure.

   - **Any other LLM CLI** that is detected (e.g., `aider`, `goose`, `opencode`): Attempt non-interactive mode.

3. **Format the prompt** to include:
   - The user's topic/question
   - "Do a deep dive. Think critically. I want honest, detailed feedback — not cheerleading."
   - Any relevant context from the current conversation

4. **Wait for all responses** (use `run_in_background` for each, then read output files when notified).

5. **Compile a unified report** with:
   - Each LLM's response summarized under its own heading (## Gemini, ## Claude Sonnet, ## Codex, etc.)
   - A **Consensus** table showing where they agree/disagree
   - A **Key Disagreements** section highlighting conflicting recommendations
   - A **Combined Recommendation** synthesizing the best insights from all

6. **Handle failures gracefully**: If an LLM CLI fails, note it in the report and continue with the others. Never block the entire review because one CLI is unavailable.

## Notes

- Gemini is the most reliable for piped input
- Claude Code requires `unset CLAUDECODE` to avoid nested session errors
- Codex requires an OpenAI API key and must run from inside a git repo
- All commands should have a 5-minute timeout
- If only one CLI is available, still produce a report from that single source
