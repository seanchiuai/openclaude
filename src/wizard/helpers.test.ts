import { describe, it, expect } from "vitest";
import { validateToken } from "./helpers.js";

describe("validateToken", () => {
  it("rejects empty string", () => {
    expect(validateToken("")).toBe("Token cannot be empty");
    expect(validateToken("   ")).toBe("Token cannot be empty");
  });

  it("rejects literal undefined/null", () => {
    expect(validateToken("undefined")).toContain("undefined");
    expect(validateToken("null")).toContain("null");
  });

  it("accepts valid tokens", () => {
    expect(validateToken("123456:ABC-DEF")).toBeUndefined();
    expect(validateToken("xoxb-some-token")).toBeUndefined();
  });
});
