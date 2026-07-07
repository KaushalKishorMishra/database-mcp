import { describe, it, expect } from "vitest";
import { validateReadOnly, ensureLimit } from "../../src/core/safety.js";

const engines = ["postgres", "mysql"] as const;

const MUST_REJECT: Array<[string, string]> = [
  ["UPDATE users SET name = 'x'", "not_read_only"],
  ["DELETE FROM users", "not_read_only"],
  ["INSERT INTO users (id) VALUES (1)", "not_read_only"],
  ["DROP TABLE users", "not_read_only"],
  ["ALTER TABLE users ADD COLUMN x int", "not_read_only"],
  ["CREATE TABLE evil (id int)", "not_read_only"],
  ["TRUNCATE users", "not_read_only"],
  ["GRANT ALL ON users TO PUBLIC", "not_read_only"],
  // stacked queries
  ["SELECT 1; DROP TABLE users", "multiple_statements"],
  ["SELECT 1;;DELETE FROM users", "multiple_statements"],
  // comment smuggling: comment does not hide the second statement
  ["SELECT 1 -- ok\n; DROP TABLE users", "multiple_statements"],
  // casing tricks
  ["uPdAtE users SET a=1", "not_read_only"],
  // write hidden in CTE (Postgres data-modifying CTE).
  // node-sql-parser does not fully support Postgres data-modifying CTEs
  // (DELETE ... RETURNING inside a WITH clause): it throws during astify
  // rather than producing an AST we can inspect. That still means the
  // query never executes, so rejecting via "parse_error" upholds the
  // security invariant (never yields ok:true) even though the code
  // differs from a straightforward "not_read_only" classification.
  ["WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d", "parse_error"],
  // garbage
  ["NOT REAL SQL AT ALL", "parse_error"],
  ["", "parse_error"],
  // C1: SELECT INTO / INTO OUTFILE / INTO DUMPFILE write server-side state
  ["SELECT * INTO newtab FROM users", "not_read_only"],
  ["SELECT * FROM users INTO OUTFILE '/tmp/x.csv'", "not_read_only"],
  ["SELECT * FROM users INTO DUMPFILE '/tmp/x'", "not_read_only"],
  // I2: parenthesized EXPLAIN (ANALYZE ...) must be rejected without
  // relying on a parse failure.
  ["EXPLAIN (ANALYZE) SELECT 1", "not_read_only"],
  ["EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1", "not_read_only"],
];

// Fixtures valid for every engine.
const MUST_PASS: string[] = [
  "SELECT * FROM users",
  "SELECT * FROM users;",
  "select id, name from users where created_at > '2026-01-01' limit 5",
  "SELECT 'a; b' AS tricky_string_with_semicolon",
  "EXPLAIN SELECT * FROM users",
];

// Fixtures using Postgres-only syntax (e.g. `interval '7 days'` literal,
// which is not valid MySQL grammar — MySQL requires `INTERVAL 7 DAY`).
// Kept engine-scoped rather than forced through both dialects.
const MUST_PASS_BY_ENGINE: Record<(typeof engines)[number], string[]> = {
  postgres: [
    "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days') SELECT count(*) FROM recent",
  ],
  mysql: [
    "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - INTERVAL 7 DAY) SELECT count(*) FROM recent",
  ],
};

describe("validateReadOnly", () => {
  for (const engine of engines) {
    for (const [sql, code] of MUST_REJECT) {
      it(`[${engine}] rejects (${code}): ${sql.slice(0, 50)}`, () => {
        const r = validateReadOnly(sql, engine);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe(code);
      });
    }
    for (const sql of [...MUST_PASS, ...MUST_PASS_BY_ENGINE[engine]]) {
      it(`[${engine}] allows: ${sql.slice(0, 50)}`, () => {
        const r = validateReadOnly(sql, engine);
        expect(r.ok).toBe(true);
      });
    }
  }

  it("EXPLAIN wrapping a write is rejected", () => {
    const r = validateReadOnly("EXPLAIN DELETE FROM users", "postgres");
    expect(r.ok).toBe(false);
  });

  it("reports hasLimit correctly", () => {
    const a = validateReadOnly("SELECT * FROM t LIMIT 10", "postgres");
    const b = validateReadOnly("SELECT * FROM t", "postgres");
    expect(a.ok && a.hasLimit).toBe(true);
    expect(b.ok && b.hasLimit).toBe(false);
  });
});

describe("ensureLimit", () => {
  it("appends LIMIT when missing", () => {
    expect(ensureLimit("SELECT * FROM t", 100)).toBe("SELECT * FROM t LIMIT 100");
  });
  it("strips trailing semicolon before appending", () => {
    expect(ensureLimit("SELECT * FROM t;", 100)).toBe("SELECT * FROM t LIMIT 100");
  });
  it("leaves existing LIMIT alone", () => {
    expect(ensureLimit("SELECT * FROM t LIMIT 5", 100)).toBe("SELECT * FROM t LIMIT 5");
  });

  // I1: a trailing line comment must not hide an already-injected LIMIT,
  // and `limit N` appearing inside a comment must not be mistaken for a
  // real LIMIT clause.
  it("does not mistake `limit N` inside a line comment for a real LIMIT", () => {
    const out = ensureLimit("SELECT * FROM t -- limit 3", 100);
    expect(out).toMatch(/LIMIT 100$/);
  });

  it("appends LIMIT on a new line so a trailing comment can't swallow it", () => {
    const out = ensureLimit("SELECT * FROM t -- hi", 100);
    expect(out).toBe("SELECT * FROM t -- hi\nLIMIT 100");
    expect(out).toMatch(/LIMIT 100$/);
  });

  it("does not mistake `limit N` inside a string literal for a real LIMIT, and preserves the literal", () => {
    const out = ensureLimit("SELECT '-- limit 3' AS s FROM t", 100);
    expect(out).toMatch(/LIMIT 100$/);
    expect(out).toContain("'-- limit 3'");
  });
});
