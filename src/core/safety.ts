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

/** Recursively scan an AST node for any write-ish statement type (catches CTE writes). */
function containsWrite(node: unknown): boolean {
  if (node == null || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (typeof obj.type === "string") {
    const t = obj.type.toLowerCase();
    if (
      ["insert", "update", "delete", "replace", "merge", "create", "drop",
       "alter", "truncate", "grant", "revoke", "call", "set", "use",
       "lock", "unlock"].includes(t)
    ) {
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

export function validateReadOnly(sql: string, engine: Engine): ValidationResult {
  const trimmed = sql.trim();
  if (!trimmed) return fail(err("parse_error", "Empty SQL statement."));

  // EXPLAIN handled as a prefix: validate the inner statement.
  const explainMatch = /^explain\s+(?:analyze\s+)?/i.exec(trimmed);
  if (explainMatch) {
    if (/^explain\s+analyze\s+/i.test(trimmed)) {
      return fail(
        err("not_read_only", "EXPLAIN ANALYZE executes the query; use plain EXPLAIN."),
      );
    }
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

  // Defense: a SELECT whose AST embeds a write (e.g. data-modifying CTE).
  if (containsWrite((stmt as Record<string, unknown>).with) ||
      containsWrite((stmt as Record<string, unknown>).from)) {
    return fail(err("not_read_only", "Query embeds a data-modifying statement."));
  }

  const hasLimit =
    type === "select" && (stmt as Record<string, unknown>).limit != null &&
    // node-sql-parser uses { seperator, value: [] } with empty value when absent
    ((stmt as { limit?: { value?: unknown[] } }).limit?.value?.length ?? 0) > 0;

  const statementType = type === "desc" ? "describe" : (type as "select" | "show" | "describe");
  return { ok: true, statementType, hasLimit };
}

/** Append LIMIT to a SELECT lacking one. Caller has already validated. */
export function ensureLimit(sql: string, limit: number): string {
  const stripped = sql.trim().replace(/;+\s*$/, "");
  if (/\blimit\s+\d+/i.test(stripped)) return stripped;
  return `${stripped} LIMIT ${limit}`;
}
