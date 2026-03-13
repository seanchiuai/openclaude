import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
  },
});
