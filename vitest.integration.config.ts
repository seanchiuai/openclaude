import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 60_000,
    include: ["src/**/*.integration.test.ts"],
    reporters: ["default", "./test/reporters/subsystem-reporter.ts"],
  },
});
