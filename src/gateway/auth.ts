/**
 * Hono authentication middleware for the gateway HTTP API.
 *
 * Supports "none" (pass-through) and "token" (Bearer token) modes.
 * Token can be set in config or via OPENCLAUDE_GATEWAY_TOKEN env var.
 */
import type { Context, Next } from "hono";
import { safeEqualSecret } from "./secret-equal.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import type { z } from "zod";
import type { GatewayAuthSchema } from "../config/schema.js";

type GatewayAuthConfig = z.infer<typeof GatewayAuthSchema>;

export interface AuthMiddlewareResult {
  middleware: (c: Context, next: Next) => Promise<Response | void>;
  rateLimiter?: AuthRateLimiter;
}

export function createAuthMiddleware(config: GatewayAuthConfig): AuthMiddlewareResult {
  if (config.mode === "none") {
    return {
      middleware: async (_c: Context, next: Next) => {
        await next();
      },
    };
  }

  // mode === "token"
  const token = config.token ?? process.env.OPENCLAUDE_GATEWAY_TOKEN;

  const rateLimiter = createAuthRateLimiter(config.rateLimit);

  const middleware = async (c: Context, next: Next): Promise<Response | void> => {
    if (!token) {
      return c.json({ error: "Auth misconfigured: token mode enabled but no token set" }, 500);
    }

    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      // Missing token — don't penalize rate limiter (matching OpenClaw)
      return c.json({ error: "Authorization header required" }, 401);
    }

    const clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

    // Check rate limit before validating
    const rateCheck = rateLimiter.check(clientIp);
    if (!rateCheck.allowed) {
      return c.json(
        { error: "Too many failed attempts", retryAfterMs: rateCheck.retryAfterMs },
        429,
      );
    }

    const provided = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7)
      : authHeader;

    if (!safeEqualSecret(provided, token)) {
      rateLimiter.recordFailure(clientIp);
      return c.json({ error: "Invalid token" }, 401);
    }

    // Valid token — reset rate limiter for this IP
    rateLimiter.reset(clientIp);
    await next();
  };

  return { middleware, rateLimiter };
}
