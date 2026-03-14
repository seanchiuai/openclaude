import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProcessPool } from "./pool.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAKE_CLAUDE_CMD } from "../../test/helpers/config.js";
import { createTestContext } from "../../test/helpers/test-context.js";

describe("pool integration", () => {
  let sessionDir: string;
  const ctx = createTestContext("pool");

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "openclaude-pool-test-"));
    ctx.dumpOnFailure();
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("enforces concurrency limit with real subprocesses", async () => {
    const pool = createProcessPool(2);
    const events: string[] = [];

    const tasks = Array.from({ length: 4 }, (_, i) =>
      pool.submit(
        {
          sessionId: `pool-test-${i}`,
          prompt: `Task ${i}`,
          workingDirectory: sessionDir,
        },
        (event) => {
          if (event.type === "queued") {
            events.push(`queued-${i}`);
            ctx.log(`task ${i} queued at position ${event.position}`);
          }
        },
        { claudeBinary: FAKE_CLAUDE_CMD },
      ),
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(r.text).toBe("Hello from fake claude");
    }
    expect(events.filter((e) => e.startsWith("queued-")).length).toBe(2);

    await pool.drain();
  }, 30_000);

  it("drain waits for in-flight tasks then rejects new submissions", async () => {
    const pool = createProcessPool(1);

    const inflight = pool.submit(
      {
        sessionId: "drain-test",
        prompt: "slow task",
        workingDirectory: sessionDir,
      },
      undefined,
      {
        claudeBinary: FAKE_CLAUDE_CMD,
        env: { FAKE_CLAUDE_DELAY_MS: "200" },
      },
    ).catch(() => {
      // Expected: drain kills in-flight processes which rejects their promises
    });

    await pool.drain();
    await inflight;
    expect(pool.stats().running).toBe(0);

    // After drain, new submissions should be rejected
    await expect(
      pool.submit(
        { sessionId: "post-drain", prompt: "reject me", workingDirectory: sessionDir },
        undefined,
        { claudeBinary: FAKE_CLAUDE_CMD },
      ),
    ).rejects.toThrow("draining");
  }, 15_000);
});
