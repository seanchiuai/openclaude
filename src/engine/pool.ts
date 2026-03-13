/**
 * Process pool for Claude Code CLI subprocesses.
 *
 * Limits concurrent Claude processes (default 4).
 * FIFO request queue for excess requests.
 */
import { spawnClaude, killProcessGroup } from "./spawn.js";
import type {
  AgentTask,
  ClaudeResult,
  ClaudeSession,
  PoolStats,
} from "./types.js";

interface QueuedTask {
  task: AgentTask;
  resolve: (result: ClaudeResult) => void;
  reject: (error: Error) => void;
}

export function createProcessPool(maxConcurrent = 4) {
  const running = new Map<string, ClaudeSession>();
  const queue: QueuedTask[] = [];
  let draining = false;

  function stats(): PoolStats {
    return {
      running: running.size,
      queued: queue.length,
      maxConcurrent,
    };
  }

  function tryDequeue(): void {
    if (draining) return;
    while (running.size < maxConcurrent && queue.length > 0) {
      const queued = queue.shift()!;
      executeTask(queued);
    }
  }

  function executeTask(queued: QueuedTask): void {
    const { task, resolve, reject } = queued;

    try {
      const { session, promise } = spawnClaude(task);
      running.set(session.id, session);

      promise
        .then((result) => {
          running.delete(session.id);
          resolve(result);
          tryDequeue();
        })
        .catch((err) => {
          running.delete(session.id);
          reject(err instanceof Error ? err : new Error(String(err)));
          tryDequeue();
        });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      tryDequeue();
    }
  }

  function submit(task: AgentTask): Promise<ClaudeResult> {
    if (draining) {
      return Promise.reject(new Error("Pool is draining, cannot accept tasks"));
    }

    return new Promise<ClaudeResult>((resolve, reject) => {
      const queued: QueuedTask = { task, resolve, reject };

      if (running.size < maxConcurrent) {
        executeTask(queued);
      } else {
        queue.push(queued);
      }
    });
  }

  function getSession(sessionId: string): ClaudeSession | undefined {
    return running.get(sessionId);
  }

  function listSessions(): ClaudeSession[] {
    return Array.from(running.values());
  }

  function killSession(sessionId: string): boolean {
    const session = running.get(sessionId);
    if (!session) return false;

    killProcessGroup(session.pid);
    session.status = "killed";
    session.completedAt = Date.now();
    running.delete(sessionId);
    tryDequeue();
    return true;
  }

  async function drain(): Promise<void> {
    draining = true;

    // Reject all queued tasks
    for (const queued of queue.splice(0)) {
      queued.reject(new Error("Pool draining"));
    }

    // Kill all running sessions
    for (const [id, session] of running) {
      killProcessGroup(session.pid);
      session.status = "killed";
      session.completedAt = Date.now();
      running.delete(id);
    }
  }

  return {
    submit,
    getSession,
    listSessions,
    killSession,
    drain,
    stats,
  };
}

export type ProcessPool = ReturnType<typeof createProcessPool>;
