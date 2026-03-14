/**
 * Test runtime mocks for memory manager tests.
 * Mocks chokidar and sqlite-vec to avoid external dependencies in unit tests.
 * Ported from OpenClaw's test-runtime-mocks.ts.
 */
import { vi } from "vitest";

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("chokidar", () => ({
  default: {
    watch: () => ({
      on: () => ({}),
      close: async () => {},
    }),
  },
  watch: () => ({
    on: () => ({}),
    close: async () => {},
  }),
}));
