import type { QueryResult } from "./adapter.js";

export interface FormattedResult {
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  markdown_table: string;
}

function cell(v: unknown): string {
  if (v == null) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function toMarkdownTable(columns: string[], rows: unknown[][]): string {
  const header = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map(cell).join(" | ")} |`);
  return [header, sep, ...body].join("\n");
}

export function formatResult(result: QueryResult): FormattedResult {
  return {
    columns: result.columns,
    rows: result.rows,
    row_count: result.rowCount,
    truncated: result.truncated,
    markdown_table: toMarkdownTable(result.columns, result.rows),
  };
}
