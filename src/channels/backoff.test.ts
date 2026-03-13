import { describe, it, expect } from "vitest";
import { computeBackoff } from "./backoff.js";

describe("computeBackoff", () => {
  it("returns initialMs for attempt 1", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0 },
      1,
    );
    expect(result).toBe(1000);
  });

  it("doubles for attempt 2 with factor 2", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0 },
      2,
    );
    expect(result).toBe(2000);
  });

  it("caps at maxMs", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 5000, factor: 2, jitter: 0 },
      20,
    );
    expect(result).toBe(5000);
  });

  it("adds jitter", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.5 },
      1,
    );
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(1500);
  });
});
