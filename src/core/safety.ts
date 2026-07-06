import pkg from "node-sql-parser";
import type { Engine, ToolError } from "./adapter.js";
import { err } from "./adapter.js";

const { Parser } = pkg;
const parser = new Parser();

const DIALECT: Record<Engine, string> = {
  postgres: "PostgresQL", // node-sql-parser's dialect id
  mysql: "MySQL",
};

const ALLOWED_TYPES = new Set(["select", "show", "desc", "describe"]);

export type ValidationOk = {
  ok: true;
  statementType: "select" | "show" | "describe" | "explain";
  hasLimit: boolean;
};
export type ValidationFail = { ok: false } & ToolError;
export type ValidationResult = ValidationOk | ValidationFail;

function fail(e: ToolError): ValidationFail {
  return { ok: false, ...e };
}

const WRITE_TYPES = new Set([
  "insert", "update", "delete", "replace", "merge", "create", "drop",
  "alter", "truncate", "grant", "revoke", "call", "set", "use",
  "lock", "unlock",
]);

/**
 * True if this AST node is a non-empty INTO clause. A non-empty INTO turns a
 * SELECT into a write (PG: SELECT INTO creates a table; MySQL: INTO
 * OUTFILE/DUMPFILE writes a server-side file). node-sql-parser represents an
 * absent INTO as { position: null } and a present one as
 * { ..., position: "column" | "from", expr: ... }.
 */
function isWriteInto(obj: Record<string, unknown>, t: string): boolean {
  return t === "into" && (obj as { position?: unknown }).position != null;
}

/** Recursively scan an AST node for any write-ish statement type (catches CTE writes). */
function containsWrite(node: unknown): boolean {
  if (node == null || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === "string") {
    // This check runs inside the generic recursive walk below, so it also
    // catches writes/INTO hidden in subqueries, UNION members (`_next`),
    // and CTEs — not just the top-level statement.
    const t = obj.type.toLowerCase();
    if (WRITE_TYPES.has(t) || isWriteInto(obj, t)) {
      return true;
    }
  }
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      if (v.some(containsWrite)) return true;
    } else if (typeof v === "object" && containsWrite(v)) {
      return true;
    }
  }
  return false;
}

/**
 * True if `trimmed` is an EXPLAIN ANALYZE in either the plain form
 * (`EXPLAIN ANALYZE ...`) or Postgres's parenthesized option-list form
 * (`EXPLAIN (ANALYZE) ...` / `EXPLAIN (ANALYZE, FORMAT JSON) ...`).
 *
 * The parenthesized form isn't parseable by node-sql-parser today, so it
 * would otherwise fail as a parse_error — which still upholds the read-only
 * guarantee, but only by accident. Detecting it explicitly means a future
 * parser upgrade can't silently turn this into an execution bypass.
 * `EXPLAIN (FORMAT JSON) ...` (no ANALYZE) is not matched here and falls
 * through to the normal parse path.
 */
function isExplainAnalyze(trimmed: string): boolean {
  if (/^explain\s+analyze\s+/i.test(trimmed)) return true;
  const parenMatch = /^explain\s*\(([^)]*)\)/i.exec(trimmed);
  return parenMatch != null && /\banalyze\b/i.test(parenMatch[1]);
}

export function validateReadOnly(sql: string, engine: Engine): ValidationResult {
  const trimmed = sql.trim();
  if (!trimmed) return fail(err("parse_error", "Empty SQL statement."));

  if (isExplainAnalyze(trimmed)) {
    return fail(
      err("not_read_only", "EXPLAIN ANALYZE executes the query; use plain EXPLAIN."),
    );
  }

  // EXPLAIN handled as a prefix: validate the inner statement.
  const explainMatch = /^explain\s+(?:analyze\s+)?/i.exec(trimmed);
  if (explainMatch) {
    const inner = validateReadOnly(trimmed.slice(explainMatch[0].length), engine);
    if (!inner.ok) return inner;
    if (inner.statementType !== "select") {
      return fail(err("not_read_only", "EXPLAIN is only allowed on SELECT statements."));
    }
    return { ok: true, statementType: "explain", hasLimit: inner.hasLimit };
  }

  let ast: unknown;
  try {
    ast = parser.astify(trimmed, { database: DIALECT[engine] });
  } catch (e) {
    return fail(err("parse_error", `SQL failed to parse: ${(e as Error).message}`));
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return fail(
      err("multiple_statements", "Exactly one SQL statement is allowed per call."),
    );
  }

  const stmt = statements[0] as { type?: string };
  const type = (stmt.type ?? "").toLowerCase();
  if (!ALLOWED_TYPES.has(type)) {
    return fail(
      err("not_read_only", `Statement type '${type || "unknown"}' is not allowed. Only SELECT, SHOW, DESCRIBE, and EXPLAIN are permitted.`, { statement_type: type }),
    );
  }

  // Defense: a SELECT whose AST embeds a write or an INTO clause (e.g. a
  // data-modifying CTE, `SELECT ... INTO`, `INTO OUTFILE`/`DUMPFILE`, or one
  // hidden inside a subquery / UNION member (`_next`)). Scanning the whole
  // statement — not just `with`/`from` — ensures nested INTO can't hide.
  if (containsWrite(stmt as Record<string, unknown>)) {
    return fail(err("not_read_only", "Query embeds a data-modifying statement or writes data via INTO."));
  }

  const hasLimit =
    type === "select" && (stmt as Record<string, unknown>).limit != null &&
    // node-sql-parser uses { seperator, value: [] } with empty value when absent
    ((stmt as { limit?: { value?: unknown[] } }).limit?.value?.length ?? 0) > 0;

  const statementType = type === "desc" ? "describe" : (type as "select" | "show" | "describe");
  return { ok: true, statementType, hasLimit };
}

/** Consume a `'...'`/`"..."` literal starting at `i` (which points at the opening quote). */
function consumeStringLiteral(sql: string, i: number): { text: string; nextIndex: number } {
  const quote = sql[i];
  let out = quote;
  i++;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === quote && sql[i + 1] === quote) {
      // doubled-quote escape (e.g. '' inside a '...' literal)
      out += "  ";
      i += 2;
      continue;
    }
    if (sql[i] === quote) {
      out += quote;
      i++;
      break;
    }
    out += " ";
    i++;
  }
  return { text: out, nextIndex: i };
}

/** Consume a `-- ...` line comment starting at `i`. Reports if it runs to end-of-string unterminated. */
function consumeLineComment(sql: string, i: number): { nextIndex: number; unterminated: boolean } {
  const n = sql.length;
  i += 2;
  while (i < n && sql[i] !== "\n") i++;
  return { nextIndex: i, unterminated: i >= n };
}

/** Consume a `/* ... *&#47;` block comment starting at `i`. */
function consumeBlockComment(sql: string, i: number): number {
  const n = sql.length;
  i += 2;
  while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
  return i + 2;
}

/**
 * Scans `sql` once, tracking string-literal state so that `--` line
 * comments, `/* ... *&#47;` block comments, and text inside `'...'`/`"..."`
 * literals aren't mistaken for real SQL tokens.
 *
 * Returns:
 * - `masked`: same length structure as the input, but with comment bodies
 *   removed and string-literal contents replaced by spaces — safe to run
 *   keyword regexes against without false positives from literals or
 *   comments (e.g. `SELECT '-- limit 3'` or `SELECT 1 -- limit 3`).
 * - `endsInLineComment`: true if the input ends while still inside an
 *   unterminated `--` comment, meaning anything appended directly after it
 *   (on the same line) would be swallowed by that comment.
 */
function scanSql(sql: string): { masked: string; endsInLineComment: boolean } {
  let out = "";
  let i = 0;
  const n = sql.length;
  let endsInLineComment = false;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];
    if (c === "'" || c === '"') {
      const { text, nextIndex } = consumeStringLiteral(sql, i);
      out += text;
      i = nextIndex;
      continue;
    }
    if (c === "-" && c2 === "-") {
      const { nextIndex, unterminated } = consumeLineComment(sql, i);
      i = nextIndex;
      if (unterminated) endsInLineComment = true;
      continue;
    }
    if (c === "/" && c2 === "*") {
      i = consumeBlockComment(sql, i);
      out += " ";
      continue;
    }
    out += c;
    i++;
  }
  return { masked: out, endsInLineComment };
}

/** Append LIMIT to a SELECT lacking one. Caller has already validated. */
export function ensureLimit(sql: string, limit: number): string {
  const stripped = sql.trim().replace(/;+\s*$/, "");
  const { masked, endsInLineComment } = scanSql(stripped);
  if (/\blimit\s+\d+/i.test(masked)) return stripped;
  // If the SQL ends inside an unterminated line comment, appending directly
  // would comment out the LIMIT we're adding — put it on a new line instead.
  const separator = endsInLineComment ? "\n" : " ";
  return `${stripped}${separator}LIMIT ${limit}`;
}
