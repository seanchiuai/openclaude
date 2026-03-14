import { describe, it, expect, beforeEach } from "vitest";
import { createRouter } from "./router.js";
import { createProcessPool } from "../engine/pool.js";
import type { InboundMessage } from "../channels/types.js";
import type { ProcessPool } from "../engine/pool.js";
import { createTestContext } from "../../test/helpers/test-context.js";

function makeMessage(text: string): InboundMessage {
  return {
    channel: "test",
    chatId: "integration-test-chat",
    userId: "test-user",
    text,
    source: "user",
  };
}

describe("router integration", () => {
  let pool: ProcessPool;
  const ctx = createTestContext("router");

  beforeEach(() => {
    pool = createProcessPool(2);
    ctx.dumpOnFailure();
  });

  describe("gateway commands respond without spawning claude", () => {
    it("/help returns help text and pool stays idle", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/help"));

      expect(response).toContain("OpenClaude Commands:");
      expect(response).toContain("/help");
      expect(response).toContain("/status");
      expect(pool.stats().running).toBe(0);
      ctx.log("/help response", response);
    });

    it("/status returns status with zero running", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/status"));

      expect(response).toContain("OpenClaude Status");
      expect(response).toContain("Running: 0/2");
      expect(response).toContain("Queued: 0");
      expect(pool.stats().running).toBe(0);
      ctx.log("/status response", response);
    });

    it("/list returns no active sessions", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/list"));

      expect(response).toBe("No active sessions.");
      expect(pool.stats().running).toBe(0);
    });

    it("/memory reports unavailable when no memoryManager", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/memory"));

      expect(response).toBe("Memory system is not available.");
      expect(pool.stats().running).toBe(0);
    });

    it("/cron reports unavailable when no cronService", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/cron"));

      expect(response).toBe("Cron system is not available.");
      expect(pool.stats().running).toBe(0);
    });

    it("/skills returns skills info", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/skills"));

      expect(response).toContain("skills");
      expect(pool.stats().running).toBe(0);
    });

    it("/reset with no prior session", async () => {
      const router = createRouter({ pool });
      const response = await router(makeMessage("/reset"));

      expect(response).toBe("No active session for this chat.");
      expect(pool.stats().running).toBe(0);
    });
  });

  describe("gateway commands return string responses", () => {
    it("all gateway commands return typeof string", async () => {
      const router = createRouter({ pool });

      const commands = ["/help", "/status", "/list", "/memory", "/cron", "/skills", "/reset"];
      for (const cmd of commands) {
        const response = await router(makeMessage(cmd));
        expect(typeof response).toBe("string");
        expect(response.length).toBeGreaterThan(0);
      }
    });
  });
});
