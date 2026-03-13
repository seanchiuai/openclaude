import { describe, it, expect } from "vitest";
import { safeEqualSecret } from "./secret-equal.js";

describe("safeEqualSecret", () => {
  it("returns true for matching strings", () => {
    expect(safeEqualSecret("my-secret", "my-secret")).toBe(true);
  });

  it("returns false for mismatched strings", () => {
    expect(safeEqualSecret("my-secret", "wrong-secret")).toBe(false);
  });

  it("returns false when provided is undefined", () => {
    expect(safeEqualSecret(undefined, "secret")).toBe(false);
  });

  it("returns false when expected is undefined", () => {
    expect(safeEqualSecret("secret", undefined)).toBe(false);
  });

  it("returns false when provided is null", () => {
    expect(safeEqualSecret(null, "secret")).toBe(false);
  });

  it("returns false when expected is null", () => {
    expect(safeEqualSecret("secret", null)).toBe(false);
  });

  it("returns false when both are undefined", () => {
    expect(safeEqualSecret(undefined, undefined)).toBe(false);
  });

  it("returns false when both are null", () => {
    expect(safeEqualSecret(null, null)).toBe(false);
  });
});
