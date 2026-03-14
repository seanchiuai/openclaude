import { describe, expect, it } from "vitest";
import { requireNodeSqlite } from "./sqlite.js";

describe("requireNodeSqlite", () => {
  it("returns the node:sqlite module with DatabaseSync defined", () => {
    const sqlite = requireNodeSqlite();
    expect(sqlite).toBeDefined();
    expect(sqlite.DatabaseSync).toBeDefined();
  });
});
