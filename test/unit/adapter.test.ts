import { describe, it, expect } from "vitest";
import { err } from "../../src/core/adapter.js";

describe("core types", () => {
  it("err() builds a structured ToolError", () => {
    const e = err("unknown_connection", "no such connection", {
      valid: ["prod_pg"],
    });
    expect(e).toEqual({
      error: "unknown_connection",
      message: "no such connection",
      valid: ["prod_pg"],
    });
  });
});
