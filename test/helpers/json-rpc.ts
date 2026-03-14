/**
 * JSON-RPC helper for MCP stdio communication.
 *
 * The @modelcontextprotocol/sdk (v1.x) uses newline-delimited JSON over stdio.
 * Each message is a JSON object followed by '\n'.
 */
import type { ChildProcess } from "node:child_process";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Send a JSON-RPC request as newline-delimited JSON over stdin.
 */
export function sendRequest(proc: ChildProcess, request: JsonRpcRequest): void {
  proc.stdin!.write(JSON.stringify(request) + "\n");
}

/**
 * Send a JSON-RPC notification (no id, no response expected).
 */
export function sendNotification(
  proc: ChildProcess,
  method: string,
  params?: Record<string, unknown>,
): void {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params) msg.params = params;
  proc.stdin!.write(JSON.stringify(msg) + "\n");
}

/**
 * Read a single JSON-RPC response from stdout.
 * Skips notification messages (no id) and returns the first response with an id.
 * Returns the parsed response or throws on timeout.
 */
export function readResponse(
  proc: ChildProcess,
  timeoutMs = 5000,
): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    let buffer = "";
    let timer: ReturnType<typeof setTimeout> | undefined;

    function cleanup() {
      if (timer) clearTimeout(timer);
      proc.stdout!.removeListener("data", onData);
    }

    function tryParse() {
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1) return;

        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;

        try {
          const parsed = JSON.parse(line);
          // Skip notifications (no id field) — only resolve on responses
          if ("id" in parsed) {
            cleanup();
            resolve(parsed as JsonRpcResponse);
            return;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    function onData(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      tryParse();
    }

    proc.stdout!.on("data", onData);

    timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `JSON-RPC response timed out after ${timeoutMs}ms (buffer: ${buffer.slice(0, 200)})`,
        ),
      );
    }, timeoutMs);
  });
}

/**
 * Send a JSON-RPC request and wait for the response.
 */
export async function call(
  proc: ChildProcess,
  method: string,
  params: Record<string, unknown> = {},
  id = 1,
  timeoutMs = 5000,
): Promise<JsonRpcResponse> {
  const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const responsePromise = readResponse(proc, timeoutMs);
  sendRequest(proc, request);
  return responsePromise;
}
