import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const HEADER = `
  ╔═══════════════════════════════════════╗
  ║          OPENCLAUDE SETUP             ║
  ╚═══════════════════════════════════════╝
`;

export function printWizardHeader(): void {
  console.log(HEADER);
}

/**
 * Check if the `claude` CLI binary is installed and reachable.
 * Returns the version string on success, or null if not found.
 */
export async function detectClaudeCli(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 5_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Test Telegram bot token by calling getMe.
 * Returns the bot username on success, or an error string.
 */
export async function testTelegramToken(
  token: string,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const data = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    if (!data.ok || !data.result?.username) {
      return { ok: false, error: "Invalid response from Telegram API" };
    }
    return { ok: true, username: data.result.username };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Test Slack bot token by calling auth.test.
 * Returns the bot name on success, or an error string.
 */
export async function testSlackToken(
  botToken: string,
): Promise<{ ok: true; botName: string } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      signal: AbortSignal.timeout(5_000),
    });
    const data = (await res.json()) as {
      ok: boolean;
      user?: string;
      error?: string;
    };
    if (!data.ok) {
      return { ok: false, error: data.error ?? "auth.test failed" };
    }
    return { ok: true, botName: data.user ?? "slack-bot" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

/**
 * Validate that a string looks like a non-empty token.
 */
export function validateToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Token cannot be empty";
  }
  if (trimmed === "undefined" || trimmed === "null") {
    return 'Cannot be the literal string "undefined" or "null"';
  }
  return undefined;
}
