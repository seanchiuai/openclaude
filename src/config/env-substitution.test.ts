import { describe, it, expect, afterEach } from "vitest";
import { substituteEnvVars, substituteEnvVarsDeep } from "./env-substitution.js";

afterEach(() => {
  delete process.env.TEST_VAR;
  delete process.env.TEST_VAR2;
});

describe("substituteEnvVars", () => {
  it("replaces $VAR syntax", () => {
    process.env.TEST_VAR = "hello";
    expect(substituteEnvVars("token=$TEST_VAR")).toBe("token=hello");
  });

  it("replaces ${VAR} syntax", () => {
    process.env.TEST_VAR = "world";
    expect(substituteEnvVars("${TEST_VAR}!")).toBe("world!");
  });

  it("replaces multiple variables", () => {
    process.env.TEST_VAR = "a";
    process.env.TEST_VAR2 = "b";
    expect(substituteEnvVars("$TEST_VAR-${TEST_VAR2}")).toBe("a-b");
  });

  it("throws on missing env var", () => {
    expect(() => substituteEnvVars("$NONEXISTENT_VAR_12345")).toThrow(
      "Environment variable NONEXISTENT_VAR_12345 is not set",
    );
  });

  it("returns string unchanged if no $ present", () => {
    expect(substituteEnvVars("no vars here")).toBe("no vars here");
  });
});

describe("substituteEnvVarsDeep", () => {
  it("recurses into objects", () => {
    process.env.TEST_VAR = "deep";
    const result = substituteEnvVarsDeep({ nested: { val: "$TEST_VAR" } });
    expect(result).toEqual({ nested: { val: "deep" } });
  });

  it("recurses into arrays", () => {
    process.env.TEST_VAR = "arr";
    const result = substituteEnvVarsDeep(["$TEST_VAR", "plain"]);
    expect(result).toEqual(["arr", "plain"]);
  });

  it("passes non-string primitives through", () => {
    expect(substituteEnvVarsDeep(42)).toBe(42);
    expect(substituteEnvVarsDeep(true)).toBe(true);
    expect(substituteEnvVarsDeep(null)).toBe(null);
  });
});
