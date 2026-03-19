/**
 * Model resolver for OpenClaude.
 *
 * Resolution chain:
 *   task.model → context default → config.agent.model → undefined (CLI decides)
 */
import type { AgentConfig } from "../config/types.js";

export type ModelContext = "user" | "skill" | "cron" | "heartbeat" | "subagent";

const BUILT_IN_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/**
 * Resolve an alias to a full model ID.
 * User aliases take precedence over built-ins.
 * Returns undefined if input is undefined; returns input unchanged if no alias matches.
 */
export function resolveAlias(
  input: string | undefined,
  userAliases?: Record<string, string>,
): string | undefined {
  if (!input) return undefined;
  return userAliases?.[input] ?? BUILT_IN_ALIASES[input] ?? input;
}

/**
 * Resolve the model for a given context using the resolution chain:
 * 1. Explicit task override (e.g. subagent API request)
 * 2. Context-specific default (heartbeatModel, cronModel, subagentModel)
 * 3. Global default (config.agent.model)
 * 4. undefined — let Claude Code CLI decide
 */
export function resolveModelForContext(
  context: ModelContext,
  agentConfig: AgentConfig,
  taskOverride?: string,
): string | undefined {
  const aliases = agentConfig.aliases;

  // 1. Explicit task override always wins
  if (taskOverride) return resolveAlias(taskOverride, aliases);

  // 2. Context-specific default
  const contextDefault: string | undefined = {
    heartbeat: agentConfig.heartbeatModel,
    cron: agentConfig.cronModel,
    subagent: agentConfig.subagentModel,
    user: undefined,
    skill: undefined,
  }[context];
  if (contextDefault) return resolveAlias(contextDefault, aliases);

  // 3. Global default
  if (agentConfig.model) return resolveAlias(agentConfig.model, aliases);

  // 4. undefined = let Claude Code CLI decide
  return undefined;
}
