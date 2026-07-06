import { describe, it, expect } from "vitest";
import { formatResult, toMarkdownTable } from "../../src/core/formatter.js";

describe("toMarkdownTable", () => {
  it("renders a well-formed markdown table", () => {
    const md = toMarkdownTable(["id", "name"], [[1, "Ada"], [2, "Linus"]]);
    expect(md).toBe(
      "| id | name |\n| --- | --- |\n| 1 | Ada |\n| 2 | Linus |",
    );
  });
  it("escapes pipes and renders null as empty", () => {
    const md = toMarkdownTable(["v"], [["a|b"], [null]]);
    expect(md).toContain("a\\|b");
    expect(md.split("\n")[3]).toBe("|  |");
  });
});

describe("formatResult", () => {
  it("wraps a QueryResult with snake_case keys and markdown", () => {
    const f = formatResult({
      columns: ["id"], rows: [[1]], rowCount: 1, truncated: false,
    });
    expect(f).toMatchObject({ row_count: 1, truncated: false });
    expect(f.markdown_table).toContain("| id |");
  });
});
