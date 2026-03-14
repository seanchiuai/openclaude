/**
 * Claude Code CLI NDJSON event classification.
 *
 * Extracts structured data from raw CLI events with graceful handling
 * of missing or renamed fields.
 */
import type { TokenUsage } from "./types.js";

export type ClassifiedEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "result"; text: string; numTurns: number | undefined; usage: TokenUsage | undefined }
  | { kind: "compaction"; preTokens: number | undefined }
  | { kind: "assistant"; textBlocks: string[]; toolUseNames: string[] }
  | { kind: "unknown" };

export function classifyEvent(event: Record<string, unknown>): ClassifiedEvent {
  if (typeof event.type !== "string") return { kind: "unknown" };

  // Init event: { type: "system", subtype: "init", session_id: "..." }
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    return { kind: "init", sessionId: event.session_id };
  }

  // Compaction: { type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: N } }
  if (event.type === "system" && event.subtype === "compact_boundary") {
    const metadata = event.compact_metadata as Record<string, unknown> | undefined;
    return { kind: "compaction", preTokens: (metadata?.pre_tokens as number) ?? undefined };
  }

  // Result: { type: "result", result: "...", usage: {...}, num_turns: N, total_cost_usd: N }
  if (event.type === "result") {
    const text = typeof event.result === "string" ? event.result : "";
    const numTurns = (event.num_turns as number) ?? undefined;
    const u = event.usage as Record<string, unknown> | undefined;
    const usage = u
      ? {
          inputTokens: (u.input_tokens as number) ?? 0,
          outputTokens: (u.output_tokens as number) ?? 0,
          cacheReadTokens: (u.cache_read_input_tokens as number) ?? 0,
          cacheCreationTokens: (u.cache_creation_input_tokens as number) ?? 0,
          totalCostUsd: (event.total_cost_usd as number) ?? 0,
        }
      : undefined;
    return { kind: "result", text, numTurns, usage };
  }

  // Assistant: { type: "assistant", message: { content: [...] } } or { type: "assistant", content: [...] }
  if (event.type === "assistant") {
    const content =
      (event.content as Array<Record<string, unknown>> | undefined) ??
      ((event.message as Record<string, unknown> | undefined)?.content as Array<Record<string, unknown>> | undefined);
    const textBlocks: string[] = [];
    const toolUseNames: string[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") textBlocks.push(block.text);
        if (block.type === "tool_use" && typeof block.name === "string") toolUseNames.push(block.name);
      }
    }
    return { kind: "assistant", textBlocks, toolUseNames };
  }

  return { kind: "unknown" };
}
