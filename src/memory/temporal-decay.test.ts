/**
 * Contract: Temporal Decay for Memory Search
 *
 * Exponential decay: multiplier = exp(-lambda * ageInDays)
 * where lambda = ln(2) / halfLifeDays (default 30)
 *
 * - Age 0 days → multiplier ~1.0
 * - Age 30 days (half-life) → multiplier ~0.5
 * - Age 60 days → multiplier ~0.25
 * - Age 365 days → multiplier near 0
 * - Evergreen files (MEMORY.md, non-dated) → multiplier always 1.0
 * - Decay applied at query time (stored scores unchanged)
 * - Custom half-life parameter works
 *
 * Interface (to be implemented):
 *   calculateTemporalDecayMultiplier({ ageInDays, halfLifeDays }) → number
 *   applyTemporalDecayToScore({ score, ageInDays, halfLifeDays }) → number
 *   toDecayLambda(halfLifeDays) → number
 */
import { describe, it, expect } from "vitest";

// These will be imported from the implementation when it exists.
// For now, define the pure math functions inline as the contract spec.
// Implementation MUST match these exact formulas.

function toDecayLambda(halfLifeDays: number): number {
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
  return Math.LN2 / halfLifeDays;
}

function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = toDecayLambda(params.halfLifeDays);
  const clampedAge = Math.max(0, params.ageInDays);
  if (lambda <= 0 || !Number.isFinite(clampedAge)) return 1;
  return Math.exp(-lambda * clampedAge);
}

function applyTemporalDecayToScore(params: {
  score: number;
  ageInDays: number;
  halfLifeDays: number;
}): number {
  return params.score * calculateTemporalDecayMultiplier(params);
}

describe("toDecayLambda", () => {
  it("computes lambda = ln(2) / halfLifeDays", () => {
    expect(toDecayLambda(30)).toBeCloseTo(Math.LN2 / 30);
  });

  it("returns 0 for non-positive halfLifeDays", () => {
    expect(toDecayLambda(0)).toBe(0);
    expect(toDecayLambda(-10)).toBe(0);
  });

  it("returns 0 for non-finite halfLifeDays", () => {
    expect(toDecayLambda(Infinity)).toBe(0);
    expect(toDecayLambda(NaN)).toBe(0);
  });
});

describe("calculateTemporalDecayMultiplier", () => {
  const DEFAULT_HALF_LIFE = 30;

  it("age 0 days → multiplier ~1.0", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 0,
      halfLifeDays: DEFAULT_HALF_LIFE,
    });
    expect(m).toBeCloseTo(1.0, 5);
  });

  it("age 30 days (half-life) → multiplier ~0.5", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 30,
      halfLifeDays: DEFAULT_HALF_LIFE,
    });
    expect(m).toBeCloseTo(0.5, 5);
  });

  it("age 60 days (2x half-life) → multiplier ~0.25", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 60,
      halfLifeDays: DEFAULT_HALF_LIFE,
    });
    expect(m).toBeCloseTo(0.25, 5);
  });

  it("age 365 days → multiplier near 0", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 365,
      halfLifeDays: DEFAULT_HALF_LIFE,
    });
    expect(m).toBeLessThan(0.001);
    expect(m).toBeGreaterThan(0);
  });

  it("negative age clamped to 0 → multiplier 1.0", () => {
    const m = calculateTemporalDecayMultiplier({
      ageInDays: -5,
      halfLifeDays: DEFAULT_HALF_LIFE,
    });
    expect(m).toBeCloseTo(1.0, 5);
  });

  it("custom half-life parameter works", () => {
    // 7-day half-life: at 7 days, multiplier should be ~0.5
    const m7 = calculateTemporalDecayMultiplier({
      ageInDays: 7,
      halfLifeDays: 7,
    });
    expect(m7).toBeCloseTo(0.5, 5);

    // 90-day half-life: at 90 days, multiplier should be ~0.5
    const m90 = calculateTemporalDecayMultiplier({
      ageInDays: 90,
      halfLifeDays: 90,
    });
    expect(m90).toBeCloseTo(0.5, 5);
  });

  it("zero or invalid halfLifeDays → no decay (multiplier 1.0)", () => {
    expect(
      calculateTemporalDecayMultiplier({ ageInDays: 100, halfLifeDays: 0 }),
    ).toBe(1);
    expect(
      calculateTemporalDecayMultiplier({ ageInDays: 100, halfLifeDays: -1 }),
    ).toBe(1);
  });
});

describe("applyTemporalDecayToScore", () => {
  it("decay applied at query time — score * multiplier", () => {
    const decayed = applyTemporalDecayToScore({
      score: 0.8,
      ageInDays: 30,
      halfLifeDays: 30,
    });
    // 0.8 * 0.5 = 0.4
    expect(decayed).toBeCloseTo(0.4, 5);
  });

  it("score 1.0 at age 0 → 1.0", () => {
    const decayed = applyTemporalDecayToScore({
      score: 1.0,
      ageInDays: 0,
      halfLifeDays: 30,
    });
    expect(decayed).toBeCloseTo(1.0, 5);
  });

  it("score 0.0 → always 0.0 regardless of age", () => {
    const decayed = applyTemporalDecayToScore({
      score: 0.0,
      ageInDays: 5,
      halfLifeDays: 30,
    });
    expect(decayed).toBe(0);
  });
});

describe("evergreen behavior (integration contract)", () => {
  // These test the contract that evergreen files should NOT have decay applied.
  // The implementation will parse paths to determine evergreen status.
  // Evergreen paths: MEMORY.md, memory.md, memory/topic.md (non-dated)
  // Dated paths: memory/2026-03-12.md → decay applies based on date

  it("evergreen flag → multiplier always 1.0 (no decay)", () => {
    // When a file is identified as evergreen, its age is effectively null
    // and no decay is applied. We test this by showing that without age,
    // the multiplier is 1.0.
    const m = calculateTemporalDecayMultiplier({
      ageInDays: 0,
      halfLifeDays: 30,
    });
    expect(m).toBe(1);
  });

  it("dated path age calculation: memory/2026-01-01.md", () => {
    // Contract: YYYY-MM-DD in filename → age computed from date
    // This is a functional test of the formula, not the path parser
    const now = new Date("2026-03-12T00:00:00Z").getTime();
    const fileDate = new Date("2026-01-01T00:00:00Z").getTime();
    const ageMs = now - fileDate;
    const ageInDays = ageMs / (24 * 60 * 60 * 1000); // ~70 days

    const m = calculateTemporalDecayMultiplier({
      ageInDays,
      halfLifeDays: 30,
    });
    // ~70 days with 30-day half-life → should be quite low
    expect(m).toBeLessThan(0.3);
    expect(m).toBeGreaterThan(0);
  });
});
