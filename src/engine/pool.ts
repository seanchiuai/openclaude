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
  OnStreamEvent,
  PoolStats,
  SpawnOptions,
} from "./types.js";

interface QueuedTask {
  task: AgentTask;
  resolve: (result: ClaudeResult) => void;
  reject: (error: Error) => void;
  onEvent?: OnStreamEvent;
  spawnOptions?: SpawnOptions;
}

export function createProcessPool(maxConcurrent = 4) {
  const running = new Map<string, ClaudeSession>();
  const queue: QueuedTask[] = [];
  const completions = new Map<string, { promise: Promise<void>; resolve: () => void }>();
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
    const { task, resolve, reject, onEvent, spawnOptions } = queued;

    try {
      const { session, promise } = spawnClaude(task, onEvent, spawnOptions);
      running.set(session.id, session);

      let resolveCompletion: () => void;
      const completionPromise = new Promise<void>((r) => { resolveCompletion = r; });
      completions.set(session.id, { promise: completionPromise, resolve: resolveCompletion! });

      promise
        .then((result) => {
          running.delete(session.id);
          completions.get(session.id)?.resolve();
          completions.delete(session.id);
          resolve(result);
          tryDequeue();
        })
        .catch((err) => {
          running.delete(session.id);
          completions.get(session.id)?.resolve();
          completions.delete(session.id);
          reject(err instanceof Error ? err : new Error(String(err)));
          tryDequeue();
        });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      tryDequeue();
    }
  }

  function submit(task: AgentTask, onEvent?: OnStreamEvent, spawnOptions?: SpawnOptions): Promise<ClaudeResult> {
    if (draining) {
      return Promise.reject(new Error("Pool is draining, cannot accept tasks"));
    }

    return new Promise<ClaudeResult>((resolve, reject) => {
      const queued: QueuedTask = { task, resolve, reject, onEvent, spawnOptions };

      if (running.size < maxConcurrent) {
        executeTask(queued);
      } else {
        onEvent?.({ type: "queued", position: queue.length + 1 });
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

    // Also remove any queued tasks for this session
    dequeueBySessionId(sessionId);

    tryDequeue();
    return true;
  }

  /** Remove all queued tasks matching a session ID. Returns count removed. */
  function dequeueBySessionId(sessionId: string): number {
    let removed = 0;
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].task.sessionId === sessionId) {
        const [entry] = queue.splice(i, 1);
        entry.reject(new Error("Session stopped"));
        removed++;
      }
    }
    return removed;
  }

  function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        const alive = pids.filter((pid) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        if (alive.length === 0 || Date.now() >= deadline) {
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  async function drain(): Promise<void> {
    draining = true;

    // Reject all queued tasks
    for (const queued of queue.splice(0)) {
      queued.reject(new Error("Pool draining"));
    }

    // Kill all running sessions and collect PIDs
    const pidsToWait: number[] = [];
    for (const [id, session] of running) {
      killProcessGroup(session.pid);
      if (session.pid !== undefined) {
        pidsToWait.push(session.pid);
      }
      session.status = "killed";
      session.completedAt = Date.now();
      running.delete(id);
    }

    // Wait for processes to actually exit (up to 2s)
    if (pidsToWait.length > 0) {
      await waitForProcessesExit(pidsToWait, 2000);
    }
  }

  function getCompletion(sessionId: string): Promise<void> | undefined {
    return completions.get(sessionId)?.promise;
  }

  return {
    submit,
    getSession,
    listSessions,
    killSession,
    drain,
    stats,
    getCompletion,
  };
}

export type ProcessPool = ReturnType<typeof createProcessPool>;
