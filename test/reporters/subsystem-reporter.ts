import type { Reporter, File, Vitest } from "vitest";

/**
 * Custom reporter that prints a subsystem-tagged summary after integration tests.
 */
export default class SubsystemReporter implements Reporter {
  ctx!: Vitest;

  onInit(ctx: Vitest) {
    this.ctx = ctx;
  }

  onFinished(files?: File[]) {
    if (!files || files.length === 0) return;

    console.log("\n--- Integration Test Summary ---\n");

    for (const file of files) {
      const tasks = this.collectTests(file);
      for (const task of tasks) {
        const status = task.result?.state === "pass" ? "\u2713" : "\u2717";
        const duration = task.result?.duration
          ? `${task.result.duration}ms`
          : "?ms";
        const subsystem = this.extractSubsystem(task);
        console.log(
          `  ${status} [${subsystem}] ${task.name} \u2192 ${duration}`,
        );
      }
    }
    console.log("");
  }

  private collectTests(suite: any): any[] {
    const result: any[] = [];
    for (const task of suite.tasks ?? []) {
      if (task.type === "test") {
        result.push(task);
      } else if (task.tasks) {
        result.push(...this.collectTests(task));
      }
    }
    return result;
  }

  private extractSubsystem(task: any): string {
    const parts: string[] = [];
    let current = task.suite;
    while (current) {
      if (current.name) parts.unshift(current.name);
      current = current.suite;
    }
    const suiteName = parts[0] ?? "unknown";
    const match = suiteName.match(
      /^(engine|gateway|pool|router|mcp|memory|cron|telegram|slack|system|channel)/i,
    );
    return match ? match[1].toLowerCase() : suiteName.slice(0, 20);
  }
}
