import { describe, it, expect } from "vitest";
import { loadTemplate } from "./template-loader.js";

describe("loadTemplate", () => {
  it("reads a template file and replaces {{VAR}} placeholders", () => {
    const result = loadTemplate("identity");
    expect(result).toContain("OpenClaude");
    expect(result).not.toContain("{{");
  });

  it("returns the raw template when no vars provided", () => {
    const result = loadTemplate("safety");
    expect(result).toContain("Safety");
  });

  it("replaces multiple vars", () => {
    const result = loadTemplate("silent-replies", { SILENT_REPLY_TOKEN: "NO_REPLY" });
    expect(result).toContain("NO_REPLY");
    expect(result).not.toContain("{{SILENT_REPLY_TOKEN}}");
  });

  it("throws on missing template", () => {
    expect(() => loadTemplate("nonexistent")).toThrow("Prompt template not found");
  });
});
