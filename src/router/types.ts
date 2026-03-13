/**
 * Router types for fixed dispatch.
 */
import type { InboundMessage } from "../channels/types.js";

export interface ParsedCommand {
  name: string;
  args: string;
}

export type RouteAction =
  | { type: "gateway_command"; command: ParsedCommand }
  | { type: "main_session"; message: InboundMessage }
  | { type: "isolated_session"; prompt: string };

export type CommandHandler = (
  command: ParsedCommand,
  message: InboundMessage,
) => Promise<string>;

export type Router = (message: InboundMessage) => Promise<string>;
