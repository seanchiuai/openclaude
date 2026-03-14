import { rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

export function createCleanupRegistry() {
  const dirs: string[] = [];
  const procs: ChildProcess[] = [];
  const fns: Array<() => Promise<void>> = [];

  return {
    trackDir(dir: string) {
      dirs.push(dir);
    },
    trackProcess(proc: ChildProcess) {
      procs.push(proc);
    },
    onCleanup(fn: () => Promise<void>) {
      fns.push(fn);
    },
    async runAll() {
      for (const fn of fns.reverse()) {
        try {
          await fn();
        } catch {
          /* best effort */
        }
      }
      for (const proc of procs) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      for (const dir of dirs) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}
