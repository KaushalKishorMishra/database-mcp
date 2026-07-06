# Text-to-SQL MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A TypeScript MCP server (stdio) exposing six read-only tools that let a client LLM answer natural-language questions over MySQL/PostgreSQL, with a four-layer defense-in-depth read-only guarantee.

**Architecture:** Transport-agnostic core (`src/core/`) containing a `DatabaseAdapter` seam (Postgres + MySQL adapters), a parse-based `SafetyValidator`, a `ConnectionRegistry` (named + call-time connections), a TTL `SchemaCache`, and a `ResultFormatter`. A thin MCP layer (`src/server.ts` + `src/tools/`) registers the tools; `src/index.ts` wires the stdio transport.

**Tech Stack:** Node 20+, TypeScript (ESM), `@modelcontextprotocol/sdk`, `zod`, `node-sql-parser`, `pg`, `mysql2`, `vitest`, `testcontainers` (integration).

**Spec:** `docs/superpowers/specs/2026-07-06-text-to-sql-mcp-design.md`

## Global Constraints

- All tools are read-only. Allowed statement types ONLY: `SELECT`, `WITH…SELECT`, `EXPLAIN <select>`, `SHOW`, `DESCRIBE`. Everything else rejected before touching the DB.
- Exactly one SQL statement per call (stacked queries rejected).
- Every `execute` runs inside a read-only transaction (`BEGIN TRANSACTION READ ONLY` / `START TRANSACTION READ ONLY`) with a statement timeout, then rolls back.
- Connection strings/credentials must NEVER appear in any tool output, error message, or log line.
- Errors are structured objects (`{ error: <code>, message, ... }`), never thrown stacks: codes `unknown_connection`, `not_read_only`, `multiple_statements`, `parse_error`, `timeout`, `connection_failed`.
- Defaults (all configurable via env): default LIMIT 100, max LIMIT 1000, statement timeout 15000 ms, schema cache TTL 300 s, preview rows 5.
- Named connections come from env vars prefixed `DBMCP_` (e.g. `DBMCP_PROD_PG=postgres://…`); name = suffix lowercased (`prod_pg`).
- ESM throughout (`"type": "module"`, NodeNext resolution). Import local files with `.js` extensions.
- **Commits: after each task's final step, invoke the `/auto-commit` skill** (user preference) instead of hand-writing `git commit` commands.
- **Use bun, not npm, for all dev commands** (`bun install`, `bun add -d`, `bun run <script>`, `bunx <tool>`). Always `bun run test` — never bare `bun test`, which invokes bun's own runner instead of vitest. Exception: consumer-facing artifacts (client-config `npx` commands, plugin.json, the `prepare` script) stay npm-compatible since end users may not have bun.
- Unit tests must not require Docker/DBs. Integration tests (testcontainers) live in `test/integration/` and run via `bun run test:integration` only.

---

### Task 1: Project scaffold + shared core types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`
- Create: `src/core/adapter.ts` (shared types + `DatabaseAdapter` interface)
- Test: `test/unit/adapter.test.ts` (type smoke test — compiles and exports exist)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: every type later tasks import from `src/core/adapter.js`: `DatabaseAdapter`, `Engine`, `ColumnInfo`, `TableInfo`, `TableDetail`, `SchemaSnapshot`, `QueryResult`, `ExecuteOptions`, `ExplainResult`, `ToolError`, `err()`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "database-mcp",
  "version": "0.1.0",
  "description": "Text-to-SQL MCP server: read-only natural-language querying for PostgreSQL and MySQL",
  "type": "module",
  "bin": { "database-mcp": "dist/index.js" },
  "files": ["dist", "README.md"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepare": "tsc -p tsconfig.json",
    "test": "vitest run test/unit",
    "test:integration": "vitest run test/integration --testTimeout 120000",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "mysql2": "^3.11.0",
    "node-sql-parser": "^5.3.0",
    "pg": "^8.13.0",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.0",
    "testcontainers": "^10.13.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "declaration": true,
    "sourceMap": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`
Expected: succeeds, `node_modules/` created (already gitignored).

- [ ] **Step 5: Write `src/core/adapter.ts`**

```ts
export type Engine = "postgres" | "mysql";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  schema: string;
  table: string;
  type: "table" | "view";
  approxRows?: number;
}

export interface ForeignKey {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableDetail {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
}

/** Compact whole-DB overview powering get_schema (token-efficient). */
export interface SchemaSnapshot {
  engine: Engine;
  tables: Array<{
    schema: string;
    table: string;
    columns: Array<{ name: string; type: string }>;
  }>;
  /** e.g. "orders.customer_id -> customers.id" */
  relationships: string[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface ExecuteOptions {
  /** Hard cap on rows returned (post auto-LIMIT). */
  maxRows: number;
  timeoutMs: number;
}

export interface ExplainResult {
  plan: string;
  warnings: string[];
}

export interface DatabaseAdapter {
  readonly engine: Engine;
  connect(): Promise<void>;
  close(): Promise<void>;
  introspectSchema(): Promise<SchemaSnapshot>;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<TableDetail>;
  explain(sql: string): Promise<ExplainResult>;
  execute(sql: string, opts: ExecuteOptions): Promise<QueryResult>;
}

export type ErrorCode =
  | "unknown_connection"
  | "not_read_only"
  | "multiple_statements"
  | "parse_error"
  | "timeout"
  | "connection_failed";

export interface ToolError {
  error: ErrorCode;
  message: string;
  [key: string]: unknown;
}

export function err(
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): ToolError {
  return { error: code, message, ...extra };
}
```

- [ ] **Step 6: Write the smoke test `test/unit/adapter.test.ts`**

```ts
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
```

- [ ] **Step 7: Verify typecheck + test pass**

Run: `bun run typecheck && bun run test`
Expected: typecheck clean; 1 test passes.

- [ ] **Step 8: Commit via the auto-commit skill**

Invoke `/auto-commit` (analyzes changes, writes conventional commit).

---

### Task 2: SafetyValidator (the crown jewel)

**Files:**
- Create: `src/core/safety.ts`
- Test: `test/unit/safety.test.ts`

**Interfaces:**
- Consumes: `Engine`, `ToolError`, `err` from `src/core/adapter.js`.
- Produces (used by adapters and `run_query`/`explain_query` tools):

```ts
type ValidationOk = { ok: true; statementType: "select" | "show" | "describe" | "explain"; hasLimit: boolean };
type ValidationFail = { ok: false } & ToolError;
validateReadOnly(sql: string, engine: Engine): ValidationOk | ValidationFail;
ensureLimit(sql: string, limit: number): string; // appends LIMIT if select lacks one
```

- [ ] **Step 1: Write the failing test table `test/unit/safety.test.ts`**

```ts
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
  // write hidden in CTE (Postgres data-modifying CTE)
  ["WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d", "not_read_only"],
  // garbage
  ["NOT REAL SQL AT ALL", "parse_error"],
  ["", "parse_error"],
];

const MUST_PASS: string[] = [
  "SELECT * FROM users",
  "SELECT * FROM users;",
  "select id, name from users where created_at > '2026-01-01' limit 5",
  "WITH recent AS (SELECT * FROM orders WHERE created_at > now() - interval '7 days') SELECT count(*) FROM recent",
  "SELECT 'a; b' AS tricky_string_with_semicolon",
  "EXPLAIN SELECT * FROM users",
];

describe("validateReadOnly", () => {
  for (const engine of engines) {
    for (const [sql, code] of MUST_REJECT) {
      it(`[${engine}] rejects (${code}): ${sql.slice(0, 50)}`, () => {
        const r = validateReadOnly(sql, engine);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe(code);
      });
    }
    for (const sql of MUST_PASS) {
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/safety.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/safety.js'`.

- [ ] **Step 3: Implement `src/core/safety.ts`**

```ts
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
```

- [ ] **Step 4: Run tests until green**

Run: `bunx vitest run test/unit/safety.test.ts`
Expected: PASS. If a specific fixture fails because `node-sql-parser` maps it to a different type/error than assumed (e.g. CTE-with-DELETE may throw a parse error rather than yield an AST — Postgres data-modifying CTEs aren't fully supported by the parser), that is acceptable **only if** the query is still rejected: adjust the *expected error code* in the test, never weaken a rejection into an acceptance. Every MUST_REJECT entry must stay rejected.

- [ ] **Step 5: Full suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 6: Commit via the auto-commit skill**

Invoke `/auto-commit`.

---

### Task 3: Config loader + ConnectionRegistry

**Files:**
- Create: `src/config.ts`, `src/core/registry.ts`
- Test: `test/unit/config.test.ts`, `test/unit/registry.test.ts`

**Interfaces:**
- Consumes: `Engine`, `DatabaseAdapter`, `err` from `src/core/adapter.js`.
- Produces:

```ts
// config.ts
interface NamedConnection { name: string; engine: Engine; connectionString: string; description?: string }
interface Settings { defaultLimit: number; maxLimit: number; timeoutMs: number; schemaCacheTtlMs: number; previewRows: number }
loadConfig(env: NodeJS.ProcessEnv): { connections: NamedConnection[]; settings: Settings }
engineFromUrl(url: string): Engine | null

// registry.ts
type AdapterFactory = (engine: Engine, connectionString: string) => DatabaseAdapter;
class ConnectionRegistry {
  constructor(connections: NamedConnection[], factory: AdapterFactory);
  list(): Array<{ name: string; engine: Engine; description?: string }>;   // NO credentials
  resolve(connection: string): { adapter: DatabaseAdapter; engine: Engine } | ToolError; // name or raw URL
  closeAll(): Promise<void>;
}
```

- [ ] **Step 1: Write failing tests**

`test/unit/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig, engineFromUrl } from "../../src/config.js";

describe("engineFromUrl", () => {
  it("detects postgres", () => {
    expect(engineFromUrl("postgres://u:p@h/db")).toBe("postgres");
    expect(engineFromUrl("postgresql://u:p@h/db")).toBe("postgres");
  });
  it("detects mysql", () => {
    expect(engineFromUrl("mysql://u:p@h/db")).toBe("mysql");
  });
  it("returns null for unknown schemes", () => {
    expect(engineFromUrl("mongodb://h/db")).toBeNull();
    expect(engineFromUrl("not a url")).toBeNull();
  });
});

describe("loadConfig", () => {
  it("collects DBMCP_-prefixed env vars as named connections", () => {
    const { connections } = loadConfig({
      DBMCP_PROD_PG: "postgres://u:p@h/db",
      DBMCP_ANALYTICS_MYSQL: "mysql://u:p@h/db",
      PATH: "/usr/bin", // ignored
    });
    expect(connections).toHaveLength(2);
    expect(connections.map((c) => c.name).sort()).toEqual(["analytics_mysql", "prod_pg"]);
    expect(connections.find((c) => c.name === "prod_pg")?.engine).toBe("postgres");
  });

  it("skips vars with unsupported schemes", () => {
    const { connections } = loadConfig({ DBMCP_MONGO: "mongodb://h/db" });
    expect(connections).toHaveLength(0);
  });

  it("reads settings overrides with defaults", () => {
    const { settings } = loadConfig({ DBMCP_DEFAULT_LIMIT: "50" });
    expect(settings.defaultLimit).toBe(50);
    expect(settings.maxLimit).toBe(1000);
    expect(settings.timeoutMs).toBe(15000);
    expect(settings.schemaCacheTtlMs).toBe(300000);
    expect(settings.previewRows).toBe(5);
  });
});
```

`test/unit/registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { ConnectionRegistry } from "../../src/core/registry.js";
import type { DatabaseAdapter, Engine } from "../../src/core/adapter.js";

function fakeAdapter(engine: Engine): DatabaseAdapter {
  return {
    engine,
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    introspectSchema: vi.fn(),
    listTables: vi.fn(),
    describeTable: vi.fn(),
    explain: vi.fn(),
    execute: vi.fn(),
  } as unknown as DatabaseAdapter;
}

const conns = [
  { name: "prod_pg", engine: "postgres" as const, connectionString: "postgres://u:secretpw@h/db" },
];

describe("ConnectionRegistry", () => {
  it("list() exposes names and engines but never credentials", () => {
    const reg = new ConnectionRegistry(conns, (e) => fakeAdapter(e));
    const listed = JSON.stringify(reg.list());
    expect(listed).toContain("prod_pg");
    expect(listed).not.toContain("secretpw");
    expect(listed).not.toContain("postgres://");
  });

  it("resolves a named connection and caches the adapter", () => {
    const factory = vi.fn((e: Engine) => fakeAdapter(e));
    const reg = new ConnectionRegistry(conns, factory);
    const a = reg.resolve("prod_pg");
    const b = reg.resolve("prod_pg");
    expect("adapter" in a && "adapter" in b && a.adapter === b.adapter).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("resolves a raw connection string (escape hatch)", () => {
    const reg = new ConnectionRegistry(conns, (e) => fakeAdapter(e));
    const r = reg.resolve("mysql://u:p@h/db");
    expect("adapter" in r && r.engine === "mysql").toBe(true);
  });

  it("returns unknown_connection with valid names for bad names", () => {
    const reg = new ConnectionRegistry(conns, (e) => fakeAdapter(e));
    const r = reg.resolve("nope");
    expect(r).toMatchObject({ error: "unknown_connection", valid_connections: ["prod_pg"] });
  });

  it("returns unknown_connection for unsupported URL schemes", () => {
    const reg = new ConnectionRegistry(conns, (e) => fakeAdapter(e));
    const r = reg.resolve("mongodb://h/db");
    expect(r).toMatchObject({ error: "unknown_connection" });
    expect(JSON.stringify(r)).not.toContain("mongodb://h/db"); // never echo the string
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run test/unit/config.test.ts test/unit/registry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/config.ts`**

```ts
import { z } from "zod";
import type { Engine } from "./core/adapter.js";

export interface NamedConnection {
  name: string;
  engine: Engine;
  connectionString: string;
  description?: string;
}

const settingsSchema = z.object({
  defaultLimit: z.coerce.number().int().positive().default(100),
  maxLimit: z.coerce.number().int().positive().default(1000),
  timeoutMs: z.coerce.number().int().positive().default(15000),
  schemaCacheTtlMs: z.coerce.number().int().positive().default(300000),
  previewRows: z.coerce.number().int().positive().default(5),
});
export type Settings = z.infer<typeof settingsSchema>;

export function engineFromUrl(url: string): Engine | null {
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres";
  if (/^mysql:\/\//i.test(url)) return "mysql";
  return null;
}

const SETTING_KEYS = new Set([
  "DBMCP_DEFAULT_LIMIT", "DBMCP_MAX_LIMIT", "DBMCP_TIMEOUT_MS",
  "DBMCP_SCHEMA_CACHE_TTL_MS", "DBMCP_PREVIEW_ROWS",
]);

export function loadConfig(env: NodeJS.ProcessEnv): {
  connections: NamedConnection[];
  settings: Settings;
} {
  const connections: NamedConnection[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("DBMCP_") || SETTING_KEYS.has(key) || !value) continue;
    const engine = engineFromUrl(value);
    if (!engine) continue; // unsupported scheme — skip silently
    connections.push({
      name: key.slice("DBMCP_".length).toLowerCase(),
      engine,
      connectionString: value,
    });
  }
  const settings = settingsSchema.parse({
    defaultLimit: env.DBMCP_DEFAULT_LIMIT,
    maxLimit: env.DBMCP_MAX_LIMIT,
    timeoutMs: env.DBMCP_TIMEOUT_MS,
    schemaCacheTtlMs: env.DBMCP_SCHEMA_CACHE_TTL_MS,
    previewRows: env.DBMCP_PREVIEW_ROWS,
  });
  return { connections, settings };
}
```

Note: `zod.coerce` treats `undefined` as absent → defaults apply.

- [ ] **Step 4: Implement `src/core/registry.ts`**

```ts
import type { DatabaseAdapter, Engine, ToolError } from "./adapter.js";
import { err } from "./adapter.js";
import type { NamedConnection } from "../config.js";
import { engineFromUrl } from "../config.js";

export type AdapterFactory = (
  engine: Engine,
  connectionString: string,
) => DatabaseAdapter;

export class ConnectionRegistry {
  private byName = new Map<string, NamedConnection>();
  private adapters = new Map<string, DatabaseAdapter>();

  constructor(
    connections: NamedConnection[],
    private factory: AdapterFactory,
  ) {
    for (const c of connections) this.byName.set(c.name, c);
  }

  list(): Array<{ name: string; engine: Engine; description?: string }> {
    return [...this.byName.values()].map(({ name, engine, description }) => ({
      name,
      engine,
      description,
    }));
  }

  resolve(connection: string): { adapter: DatabaseAdapter; engine: Engine } | ToolError {
    const named = this.byName.get(connection);
    if (named) {
      let adapter = this.adapters.get(connection);
      if (!adapter) {
        adapter = this.factory(named.engine, named.connectionString);
        this.adapters.set(connection, adapter);
      }
      return { adapter, engine: named.engine };
    }
    // Call-time connection-string escape hatch.
    if (connection.includes("://")) {
      const engine = engineFromUrl(connection);
      if (!engine) {
        return err(
          "unknown_connection",
          "Connection string scheme not supported. Supported: postgres://, postgresql://, mysql://.",
        );
      }
      let adapter = this.adapters.get(connection);
      if (!adapter) {
        adapter = this.factory(engine, connection);
        this.adapters.set(connection, adapter);
      }
      return { adapter, engine };
    }
    return err("unknown_connection", `No connection named '${connection}'.`, {
      valid_connections: [...this.byName.keys()],
    });
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.close()));
    this.adapters.clear();
  }
}
```

- [ ] **Step 5: Run tests until green**

Run: `bunx vitest run test/unit/config.test.ts test/unit/registry.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite + typecheck, then commit**

Run: `bun run typecheck && bun run test` → all green.
Invoke `/auto-commit`.

---

### Task 4: ResultFormatter + SchemaCache

**Files:**
- Create: `src/core/formatter.ts`, `src/core/schemaCache.ts`
- Test: `test/unit/formatter.test.ts`, `test/unit/schemaCache.test.ts`

**Interfaces:**
- Consumes: `QueryResult`, `SchemaSnapshot` from `src/core/adapter.js`.
- Produces:

```ts
// formatter.ts
interface FormattedResult { columns: string[]; rows: unknown[][]; row_count: number; truncated: boolean; markdown_table: string }
formatResult(result: QueryResult): FormattedResult
toMarkdownTable(columns: string[], rows: unknown[][]): string

// schemaCache.ts
class SchemaCache {
  constructor(ttlMs: number, now?: () => number);
  get(key: string): SchemaSnapshot | undefined;
  set(key: string, snapshot: SchemaSnapshot): void;
  invalidate(key: string): void;
}
```

- [ ] **Step 1: Write failing tests**

`test/unit/formatter.test.ts`:

```ts
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
```

`test/unit/schemaCache.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SchemaCache } from "../../src/core/schemaCache.js";
import type { SchemaSnapshot } from "../../src/core/adapter.js";

const snap: SchemaSnapshot = { engine: "postgres", tables: [], relationships: [] };

describe("SchemaCache", () => {
  it("returns cached value within TTL and expires after", () => {
    let t = 0;
    const cache = new SchemaCache(1000, () => t);
    cache.set("prod_pg", snap);
    t = 999;
    expect(cache.get("prod_pg")).toBe(snap);
    t = 1001;
    expect(cache.get("prod_pg")).toBeUndefined();
  });
  it("invalidate() removes an entry", () => {
    const cache = new SchemaCache(1000, () => 0);
    cache.set("k", snap);
    cache.invalidate("k");
    expect(cache.get("k")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run test/unit/formatter.test.ts test/unit/schemaCache.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `src/core/formatter.ts`**

```ts
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
```

- [ ] **Step 4: Implement `src/core/schemaCache.ts`**

```ts
import type { SchemaSnapshot } from "./adapter.js";

export class SchemaCache {
  private entries = new Map<string, { snapshot: SchemaSnapshot; expiresAt: number }>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get(key: string): SchemaSnapshot | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() > e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return e.snapshot;
  }

  set(key: string, snapshot: SchemaSnapshot): void {
    this.entries.set(key, { snapshot, expiresAt: this.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
```

- [ ] **Step 5: Run until green, full suite, commit**

Run: `bun run typecheck && bun run test` → all green.
Invoke `/auto-commit`.

---

### Task 5: PostgresAdapter (+ shared adapter contract test)

**Files:**
- Create: `src/core/adapters/postgres.ts`
- Create: `test/integration/adapterContract.ts` (shared suite, reused by Task 6)
- Test: `test/integration/postgres.test.ts` (testcontainers; NOT part of `bun run test`)

**Interfaces:**
- Consumes: `DatabaseAdapter` + all types from `src/core/adapter.js`; `validateReadOnly`, `ensureLimit` from `src/core/safety.js`.
- Produces: `class PostgresAdapter implements DatabaseAdapter` with `constructor(connectionString: string)`. Also `runAdapterContract(name, makeAdapter, writeProbeSql)` from `adapterContract.ts` — Task 6 reuses it verbatim.

**Adapter responsibilities (both engines):** `execute()` must (1) validate via `validateReadOnly` (return-shaped errors, layers 1–2), (2) apply `ensureLimit` with `opts.maxRows` for SELECTs (layer 4), (3) run inside a read-only transaction with a statement timeout, then ROLLBACK (layers 3–4), (4) cap returned rows at `opts.maxRows` and set `truncated`.

- [ ] **Step 1: Implement `src/core/adapters/postgres.ts`** (integration-test-first is impractical per-step here; the contract test in Step 2 is the failing test for both this and Task 6)

```ts
import pg from "pg";
import type {
  DatabaseAdapter, ExecuteOptions, ExplainResult, QueryResult,
  SchemaSnapshot, TableDetail, TableInfo,
} from "../adapter.js";
import { validateReadOnly, ensureLimit } from "../safety.js";

export class PostgresAdapter implements DatabaseAdapter {
  readonly engine = "postgres" as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
  }

  async connect(): Promise<void> {
    const c = await this.pool.connect();
    c.release();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async introspectSchema(): Promise<SchemaSnapshot> {
    const cols = await this.pool.query(`
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position`);
    const fks = await this.pool.query(`
      SELECT tc.table_name AS src_table, kcu.column_name AS src_col,
             ccu.table_name AS ref_table, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'`);

    const byTable = new Map<string, { schema: string; table: string; columns: { name: string; type: string }[] }>();
    for (const r of cols.rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!byTable.has(key)) {
        byTable.set(key, { schema: r.table_schema, table: r.table_name, columns: [] });
      }
      byTable.get(key)!.columns.push({ name: r.column_name, type: r.data_type });
    }
    return {
      engine: this.engine,
      tables: [...byTable.values()],
      relationships: fks.rows.map(
        (r) => `${r.src_table}.${r.src_col} -> ${r.ref_table}.${r.ref_col}`,
      ),
    };
  }

  async listTables(schema = "public"): Promise<TableInfo[]> {
    const res = await this.pool.query(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables WHERE table_schema = $1
       ORDER BY table_name`,
      [schema],
    );
    return res.rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      type: r.table_type === "VIEW" ? "view" : "table",
    }));
  }

  async describeTable(table: string, schema = "public"): Promise<TableDetail> {
    const cols = await this.pool.query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
              ) AS is_pk
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table],
    );
    const fks = await this.pool.query(
      `SELECT kcu.column_name AS src_col, ccu.table_name AS ref_table, ccu.column_name AS ref_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table],
    );
    const idx = await this.pool.query(
      `SELECT indexname AS name, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2`,
      [schema, table],
    );
    return {
      schema,
      table,
      columns: cols.rows.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default,
        isPrimaryKey: r.is_pk,
      })),
      foreignKeys: fks.rows.map((r) => ({
        column: r.src_col, referencesTable: r.ref_table, referencesColumn: r.ref_col,
      })),
      indexes: idx.rows.map((r) => ({
        name: r.name,
        columns: [], // parsing indexdef is not worth it for v1; name + unique flag suffice
        unique: /UNIQUE/i.test(r.indexdef),
      })),
    };
  }

  async explain(sql: string): Promise<ExplainResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v; // tools layer converts ToolError-shaped throws
    const bare = sql.trim().replace(/^explain\s+/i, "");
    const res = await this.pool.query(`EXPLAIN ${bare}`);
    const plan = res.rows.map((r) => r["QUERY PLAN"]).join("\n");
    const warnings: string[] = [];
    if (/Seq Scan/i.test(plan)) warnings.push("Sequential scan detected — consider adding a WHERE clause on an indexed column.");
    if (!v.hasLimit) warnings.push("Query has no LIMIT — a default limit will be applied on execution.");
    return { plan, warnings };
  }

  async execute(sql: string, opts: ExecuteOptions): Promise<QueryResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v;
    const finalSql = v.statementType === "select" ? ensureLimit(sql, opts.maxRows) : sql;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(opts.timeoutMs)}`);
      const res = await client.query({ text: finalSql, rowMode: "array" });
      const rows = (res.rows as unknown[][]).slice(0, opts.maxRows);
      return {
        columns: res.fields.map((f) => f.name),
        rows,
        rowCount: rows.length,
        truncated: (res.rows as unknown[][]).length > opts.maxRows ||
          rows.length === opts.maxRows,
      };
    } finally {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      client.release();
    }
  }
}
```

- [ ] **Step 2: Write the shared contract suite `test/integration/adapterContract.ts`**

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { DatabaseAdapter } from "../../src/core/adapter.js";

/**
 * Shared contract every adapter must pass. Caller seeds this schema first:
 *   customers(id PK, name)         — 3 rows
 *   orders(id PK, customer_id FK -> customers.id, amount) — 5 rows
 */
export function runAdapterContract(
  name: string,
  makeAdapter: () => Promise<{ adapter: DatabaseAdapter; teardown: () => Promise<void> }>,
) {
  describe(`${name} adapter contract`, () => {
    let adapter: DatabaseAdapter;
    let teardown: () => Promise<void>;

    beforeAll(async () => {
      ({ adapter, teardown } = await makeAdapter());
      await adapter.connect();
    }, 120_000);

    afterAll(async () => {
      await adapter.close();
      await teardown();
    });

    it("introspectSchema returns tables and the FK relationship", async () => {
      const snap = await adapter.introspectSchema();
      const names = snap.tables.map((t) => t.table).sort();
      expect(names).toContain("customers");
      expect(names).toContain("orders");
      expect(snap.relationships.join()).toContain("orders.customer_id -> customers.id");
    });

    it("listTables + describeTable expose columns and PK", async () => {
      const tables = await adapter.listTables();
      expect(tables.map((t) => t.table)).toContain("customers");
      const d = await adapter.describeTable("customers");
      const id = d.columns.find((c) => c.name === "id");
      expect(id?.isPrimaryKey).toBe(true);
    });

    it("executes a SELECT and returns rows", async () => {
      const r = await adapter.execute("SELECT name FROM customers ORDER BY id", {
        maxRows: 100, timeoutMs: 15000,
      });
      expect(r.columns).toEqual(["name"]);
      expect(r.rowCount).toBe(3);
    });

    it("rejects an UPDATE at the validator layer (thrown ToolError shape)", async () => {
      await expect(
        adapter.execute("UPDATE customers SET name = 'x'", { maxRows: 100, timeoutMs: 15000 }),
      ).rejects.toMatchObject({ error: "not_read_only" });
    });

    // NOTE: the engine-level read-only backstop (layer 3) cannot be probed
    // portably from here — each engine test file has its own
    // "engine-level backstop" test that bypasses the validator deliberately.

    it("applies auto-LIMIT and flags truncation", async () => {
      const r = await adapter.execute("SELECT * FROM orders", { maxRows: 2, timeoutMs: 15000 });
      expect(r.rows.length).toBe(2);
      expect(r.truncated).toBe(true);
    });

    it("explain returns a plan without executing", async () => {
      const e = await adapter.explain("SELECT * FROM orders");
      expect(e.plan.length).toBeGreaterThan(0);
    });
  });
}
```

- [ ] **Step 3: Write `test/integration/postgres.test.ts`**

```ts
import { it, expect } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { PostgresAdapter } from "../../src/core/adapters/postgres.js";
import { runAdapterContract } from "./adapterContract.js";

const SEED = `
  CREATE TABLE customers (id serial PRIMARY KEY, name text NOT NULL);
  CREATE TABLE orders (
    id serial PRIMARY KEY,
    customer_id int REFERENCES customers(id),
    amount numeric NOT NULL
  );
  INSERT INTO customers (name) VALUES ('Ada'), ('Linus'), ('Grace');
  INSERT INTO orders (customer_id, amount) VALUES (1,10),(1,20),(2,30),(3,40),(3,50);
`;

async function makePg() {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  const url = container.getConnectionUri();
  const adapter = new PostgresAdapter(url);
  const seed = new PostgresAdapter(url); // seed through a raw pool
  // @ts-expect-error access internal pool for seeding only
  await seed.pool.query(SEED);
  await seed.close();
  return { adapter, teardown: async () => { await container.stop(); }, url };
}

runAdapterContract("postgres", async () => {
  const { adapter, teardown } = await makePg();
  return { adapter, teardown };
});

it("engine-level backstop: INSERT inside READ ONLY tx fails", async () => {
  const { adapter, teardown } = await makePg();
  await adapter.connect();
  // Bypass the validator deliberately to prove layer 3 stands alone.
  // @ts-expect-error reaching into internals for the security test
  const client = await adapter.pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await expect(
      client.query("INSERT INTO customers (name) VALUES ('evil')"),
    ).rejects.toThrow(/read-only/i);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await adapter.close();
    await teardown();
  }
}, 120_000);
```

Note: add `@testcontainers/postgresql` and (Task 6) `@testcontainers/mysql` to devDependencies: `bun add -d @testcontainers/postgresql @testcontainers/mysql`.

- [ ] **Step 4: Run integration tests (requires Docker)**

Run: `bun run test:integration -- postgres`
Expected: PASS. If Docker isn't available, note it and rely on CI/user to run; unit suite must still pass.

- [ ] **Step 5: Typecheck + unit suite, then commit**

Run: `bun run typecheck && bun run test` → green.
Invoke `/auto-commit`.

---

### Task 6: MysqlAdapter

**Files:**
- Create: `src/core/adapters/mysql.ts`
- Test: `test/integration/mysql.test.ts` (reuses `runAdapterContract`)

**Interfaces:**
- Consumes: `runAdapterContract` from `test/integration/adapterContract.js`; `validateReadOnly`, `ensureLimit` from safety; types from adapter.
- Produces: `class MysqlAdapter implements DatabaseAdapter`, `constructor(connectionString: string)`.

- [ ] **Step 1: Implement `src/core/adapters/mysql.ts`**

```ts
import mysql from "mysql2/promise";
import type {
  DatabaseAdapter, ExecuteOptions, ExplainResult, QueryResult,
  SchemaSnapshot, TableDetail, TableInfo,
} from "../adapter.js";
import { validateReadOnly, ensureLimit } from "../safety.js";

export class MysqlAdapter implements DatabaseAdapter {
  readonly engine = "mysql" as const;
  private pool: mysql.Pool;

  constructor(connectionString: string) {
    this.pool = mysql.createPool({ uri: connectionString, connectionLimit: 3 });
  }

  async connect(): Promise<void> {
    const c = await this.pool.getConnection();
    c.release();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async introspectSchema(): Promise<SchemaSnapshot> {
    const [cols] = await this.pool.query<mysql.RowDataPacket[]>(`
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
      ORDER BY table_name, ordinal_position`);
    const [fks] = await this.pool.query<mysql.RowDataPacket[]>(`
      SELECT table_name AS src_table, column_name AS src_col,
             referenced_table_name AS ref_table, referenced_column_name AS ref_col
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`);

    const byTable = new Map<string, { schema: string; table: string; columns: { name: string; type: string }[] }>();
    for (const r of cols) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!byTable.has(key)) {
        byTable.set(key, { schema: r.table_schema, table: r.table_name, columns: [] });
      }
      byTable.get(key)!.columns.push({ name: r.column_name, type: r.data_type });
    }
    return {
      engine: this.engine,
      tables: [...byTable.values()],
      relationships: fks.map(
        (r) => `${r.src_table}.${r.src_col} -> ${r.ref_table}.${r.ref_col}`,
      ),
    };
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT table_schema, table_name, table_type, table_rows
       FROM information_schema.tables
       WHERE table_schema = COALESCE(?, DATABASE())
       ORDER BY table_name`,
      [schema ?? null],
    );
    return rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      type: r.table_type === "VIEW" ? "view" : "table",
      approxRows: r.table_rows ?? undefined,
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDetail> {
    const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name, data_type, is_nullable, column_default, column_key
       FROM information_schema.columns
       WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
       ORDER BY ordinal_position`,
      [schema ?? null, table],
    );
    const [fks] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS src_col, referenced_table_name AS ref_table,
              referenced_column_name AS ref_col
       FROM information_schema.key_column_usage
       WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
         AND referenced_table_name IS NOT NULL`,
      [schema ?? null, table],
    );
    const [idx] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols,
              MIN(non_unique) AS non_unique
       FROM information_schema.statistics
       WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
       GROUP BY index_name`,
      [schema ?? null, table],
    );
    return {
      schema: schema ?? "",
      table,
      columns: cols.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default,
        isPrimaryKey: r.column_key === "PRI",
      })),
      foreignKeys: fks.map((r) => ({
        column: r.src_col, referencesTable: r.ref_table, referencesColumn: r.ref_col,
      })),
      indexes: idx.map((r) => ({
        name: r.name,
        columns: String(r.cols ?? "").split(","),
        unique: r.non_unique === 0,
      })),
    };
  }

  async explain(sql: string): Promise<ExplainResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v;
    const bare = sql.trim().replace(/^explain\s+/i, "");
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`EXPLAIN ${bare}`);
    const plan = rows.map((r) => JSON.stringify(r)).join("\n");
    const warnings: string[] = [];
    if (rows.some((r) => r.type === "ALL")) warnings.push("Full table scan detected — consider a WHERE clause on an indexed column.");
    if (!v.hasLimit) warnings.push("Query has no LIMIT — a default limit will be applied on execution.");
    return { plan, warnings };
  }

  async execute(sql: string, opts: ExecuteOptions): Promise<QueryResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v;
    const finalSql = v.statementType === "select" ? ensureLimit(sql, opts.maxRows) : sql;

    const conn = await this.pool.getConnection();
    try {
      await conn.query(`SET SESSION max_execution_time = ${Math.floor(opts.timeoutMs)}`);
      await conn.query("START TRANSACTION READ ONLY");
      const [rows, fields] = await conn.query({ sql: finalSql, rowsAsArray: true });
      const all = rows as unknown[][];
      const capped = all.slice(0, opts.maxRows);
      return {
        columns: (fields ?? []).map((f) => f.name),
        rows: capped,
        rowCount: capped.length,
        truncated: all.length > opts.maxRows || capped.length === opts.maxRows,
      };
    } finally {
      try { await conn.query("ROLLBACK"); } catch { /* ignore */ }
      conn.release();
    }
  }
}
```

- [ ] **Step 2: Write `test/integration/mysql.test.ts`**

```ts
import { it, expect } from "vitest";
import { MySqlContainer } from "@testcontainers/mysql";
import { MysqlAdapter } from "../../src/core/adapters/mysql.js";
import { runAdapterContract } from "./adapterContract.js";

const SEED = [
  `CREATE TABLE customers (id int AUTO_INCREMENT PRIMARY KEY, name varchar(100) NOT NULL)`,
  `CREATE TABLE orders (
     id int AUTO_INCREMENT PRIMARY KEY,
     customer_id int, amount decimal(10,2) NOT NULL,
     FOREIGN KEY (customer_id) REFERENCES customers(id))`,
  `INSERT INTO customers (name) VALUES ('Ada'), ('Linus'), ('Grace')`,
  `INSERT INTO orders (customer_id, amount) VALUES (1,10),(1,20),(2,30),(3,40),(3,50)`,
];

async function makeMysql() {
  const container = await new MySqlContainer("mysql:8.4").start();
  const url = container.getConnectionUri();
  const seed = new MysqlAdapter(url);
  for (const stmt of SEED) {
    // @ts-expect-error internal pool access for seeding only
    await seed.pool.query(stmt);
  }
  await seed.close();
  return { adapter: new MysqlAdapter(url), teardown: async () => { await container.stop(); } };
}

runAdapterContract("mysql", makeMysql);

it("engine-level backstop: INSERT inside READ ONLY tx fails", async () => {
  const { adapter, teardown } = await makeMysql();
  await adapter.connect();
  // @ts-expect-error internal pool access for the security test
  const conn = await adapter.pool.getConnection();
  try {
    await conn.query("START TRANSACTION READ ONLY");
    await expect(
      conn.query("INSERT INTO customers (name) VALUES ('evil')"),
    ).rejects.toThrow(/read.?only/i);
  } finally {
    await conn.query("ROLLBACK");
    conn.release();
    await adapter.close();
    await teardown();
  }
}, 120_000);
```

- [ ] **Step 3: Run integration tests (requires Docker)**

Run: `bun run test:integration`
Expected: PASS for both engines (or noted as requiring Docker).

- [ ] **Step 4: Typecheck + unit suite, then commit**

Run: `bun run typecheck && bun run test` → green.
Invoke `/auto-commit`.

---

### Task 7: MCP server + the six tools

**Files:**
- Create: `src/server.ts` (registers all six tools; tools are simple enough to co-locate — split into `src/tools/*` only if this file exceeds ~300 lines)
- Test: `test/unit/server.test.ts` (in-process via `InMemoryTransport` + SDK `Client`, fake adapters — no DB needed)

**Interfaces:**
- Consumes: `ConnectionRegistry`, `SchemaCache`, `formatResult`, `Settings`, adapter types, `err`.
- Produces:

```ts
// server.ts
createServer(deps: {
  registry: ConnectionRegistry;
  cache: SchemaCache;
  settings: Settings;
}): McpServer   // with all 6 tools registered
```

Tool result convention: every tool returns `content: [{ type: "text", text: JSON.stringify(payload) }]`; error payloads are the structured `ToolError` objects (with `isError: true` on the MCP result).

- [ ] **Step 1: Write failing test `test/unit/server.test.ts`**

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { ConnectionRegistry } from "../../src/core/registry.js";
import { SchemaCache } from "../../src/core/schemaCache.js";
import type { DatabaseAdapter, SchemaSnapshot } from "../../src/core/adapter.js";
import { err } from "../../src/core/adapter.js";

const SNAP: SchemaSnapshot = {
  engine: "postgres",
  tables: [{ schema: "public", table: "users", columns: [{ name: "id", type: "integer" }] }],
  relationships: [],
};

function fakeAdapter(): DatabaseAdapter {
  return {
    engine: "postgres",
    connect: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    introspectSchema: vi.fn(async () => SNAP),
    listTables: vi.fn(async () => [{ schema: "public", table: "users", type: "table" as const }]),
    describeTable: vi.fn(async () => ({
      schema: "public", table: "users",
      columns: [{ name: "id", type: "integer", nullable: false, default: null, isPrimaryKey: true }],
      foreignKeys: [], indexes: [],
    })),
    explain: vi.fn(async () => ({ plan: "Seq Scan on users", warnings: [] })),
    execute: vi.fn(async (sql: string) => {
      if (/update/i.test(sql)) throw err("not_read_only", "rejected");
      return { columns: ["id"], rows: [[1]], rowCount: 1, truncated: false };
    }),
  } as unknown as DatabaseAdapter;
}

const SETTINGS = {
  defaultLimit: 100, maxLimit: 1000, timeoutMs: 15000,
  schemaCacheTtlMs: 300000, previewRows: 5,
};

async function connectedClient() {
  const adapter = fakeAdapter();
  const registry = new ConnectionRegistry(
    [{ name: "prod_pg", engine: "postgres", connectionString: "postgres://u:pw@h/db" }],
    () => adapter,
  );
  const server = createServer({ registry, cache: new SchemaCache(300000), settings: SETTINGS });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, adapter };
}

function payload(res: unknown): Record<string, unknown> {
  const r = res as { content: Array<{ type: string; text: string }> };
  return JSON.parse(r.content[0].text);
}

describe("MCP server tools", () => {
  let client: Client;
  let adapter: DatabaseAdapter;

  beforeEach(async () => {
    ({ client, adapter } = await connectedClient());
  });

  it("registers all six tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "describe_table", "explain_query", "get_schema",
      "list_connections", "list_tables", "run_query",
    ]);
  });

  it("list_connections returns names, never credentials", async () => {
    const res = await client.callTool({ name: "list_connections", arguments: {} });
    const text = JSON.stringify(res);
    expect(text).toContain("prod_pg");
    expect(text).not.toContain("pw");
    expect(text).not.toContain("postgres://");
  });

  it("get_schema returns the snapshot and caches it", async () => {
    await client.callTool({ name: "get_schema", arguments: { connection: "prod_pg" } });
    await client.callTool({ name: "get_schema", arguments: { connection: "prod_pg" } });
    expect(adapter.introspectSchema).toHaveBeenCalledTimes(1);
  });

  it("run_query returns formatted rows with markdown", async () => {
    const res = await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "SELECT id FROM users" },
    });
    const p = payload(res);
    expect(p.row_count).toBe(1);
    expect(String(p.markdown_table)).toContain("| id |");
  });

  it("run_query preview uses previewRows as the limit", async () => {
    await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "SELECT id FROM users", preview: true },
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRows: 5 }),
    );
  });

  it("run_query surfaces structured not_read_only errors", async () => {
    const res = await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "UPDATE users SET id = 2" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(payload(res).error).toBe("not_read_only");
  });

  it("unknown connection returns unknown_connection with valid names", async () => {
    const res = await client.callTool({
      name: "run_query",
      arguments: { connection: "nope", sql: "SELECT 1" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const p = payload(res);
    expect(p.error).toBe("unknown_connection");
    expect(p.valid_connections).toEqual(["prod_pg"]);
  });

  it("limit is clamped to maxLimit", async () => {
    await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "SELECT id FROM users", limit: 99999 },
    });
    expect(adapter.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ maxRows: 1000 }),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bunx vitest run test/unit/server.test.ts`
Expected: FAIL — `src/server.js` not found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionRegistry } from "./core/registry.js";
import type { SchemaCache } from "./core/schemaCache.js";
import type { Settings } from "./config.js";
import type { ToolError } from "./core/adapter.js";
import { err } from "./core/adapter.js";
import { formatResult } from "./core/formatter.js";

interface Deps {
  registry: ConnectionRegistry;
  cache: SchemaCache;
  settings: Settings;
}

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(e: ToolError) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(e) }],
  };
}

function isToolError(e: unknown): e is ToolError {
  return typeof e === "object" && e !== null && "error" in e && "message" in e;
}

/** Convert unexpected exceptions into sanitized structured errors. */
function sanitize(e: unknown): ToolError {
  if (isToolError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  // Strip anything that looks like a connection URL from driver errors.
  const cleaned = msg.replace(/\w+:\/\/[^\s"']+/g, "[redacted]");
  if (/timeout|max_execution_time|statement timeout|canceling statement/i.test(cleaned)) {
    return err("timeout", "Query exceeded the statement timeout. Add filters or a smaller LIMIT.");
  }
  return err("connection_failed", `Database error: ${cleaned}`);
}

export function createServer({ registry, cache, settings }: Deps): McpServer {
  const server = new McpServer({ name: "database-mcp", version: "0.1.0" });

  const connectionArg = z
    .string()
    .describe("Named connection from list_connections (preferred) or a raw connection string.");

  function withAdapter<T>(
    connection: string,
    fn: (adapter: import("./core/adapter.js").DatabaseAdapter) => Promise<T>,
  ): Promise<T | ReturnType<typeof toolError>> {
    const resolved = registry.resolve(connection);
    if ("error" in resolved) return Promise.resolve(toolError(resolved));
    return fn(resolved.adapter).catch((e) => toolError(sanitize(e)));
  }

  server.registerTool(
    "list_connections",
    {
      description:
        "List the configured database connections (name, engine, description). Call this first to discover what databases are available. Never returns credentials.",
      inputSchema: {},
    },
    async () => ok(registry.list()),
  );

  server.registerTool(
    "get_schema",
    {
      description:
        "Get a compact overview of an entire database in one call: all tables, their columns, and foreign-key relationships. PREFER THIS as your first call after picking a connection — it is cached and token-efficient. Only use describe_table to zoom into one table when this overview is too large.",
      inputSchema: { connection: connectionArg },
    },
    async ({ connection }) =>
      withAdapter(connection, async (adapter) => {
        const cached = cache.get(connection);
        if (cached) return ok(cached);
        const snap = await adapter.introspectSchema();
        cache.set(connection, snap);
        return ok(snap);
      }),
  );

  server.registerTool(
    "list_tables",
    {
      description: "List tables and views in a database (optionally filtered by schema).",
      inputSchema: { connection: connectionArg, schema: z.string().optional() },
    },
    async ({ connection, schema }) =>
      withAdapter(connection, async (a) => ok(await a.listTables(schema))),
  );

  server.registerTool(
    "describe_table",
    {
      description:
        "Full detail for one table: columns (name, type, nullable, default, primary key), foreign keys, and indexes. Use when get_schema's overview isn't enough.",
      inputSchema: {
        connection: connectionArg,
        table: z.string(),
        schema: z.string().optional(),
      },
    },
    async ({ connection, table, schema }) =>
      withAdapter(connection, async (a) => ok(await a.describeTable(table, schema))),
  );

  server.registerTool(
    "explain_query",
    {
      description:
        "Dry-run a SQL query: returns the query plan (EXPLAIN — nothing is executed) plus warnings (missing LIMIT, sequential scans). Use to verify a query is valid and sane before run_query on anything expensive.",
      inputSchema: { connection: connectionArg, sql: z.string() },
    },
    async ({ connection, sql }) =>
      withAdapter(connection, async (a) => ok(await a.explain(sql))),
  );

  server.registerTool(
    "run_query",
    {
      description:
        "Execute a READ-ONLY SQL query (SELECT/CTE/SHOW/DESCRIBE/EXPLAIN only — writes are rejected at multiple layers). Returns columns, rows, row_count, truncated flag, and a ready-to-display markdown_table. Set preview=true to sanity-check a few rows before a full run. An automatic LIMIT is applied to unbounded SELECTs.",
      inputSchema: {
        connection: connectionArg,
        sql: z.string().describe("A single read-only SQL statement."),
        limit: z.number().int().positive().optional()
          .describe(`Max rows (default ${settings.defaultLimit}, hard cap ${settings.maxLimit}).`),
        preview: z.boolean().optional()
          .describe(`If true, return only ${settings.previewRows} rows as a sanity check.`),
      },
    },
    async ({ connection, sql, limit, preview }) =>
      withAdapter(connection, async (a) => {
        const maxRows = preview
          ? settings.previewRows
          : Math.min(limit ?? settings.defaultLimit, settings.maxLimit);
        const result = await a.execute(sql, { maxRows, timeoutMs: settings.timeoutMs });
        return ok(formatResult(result));
      }),
  );

  return server;
}
```

- [ ] **Step 4: Run until green**

Run: `bunx vitest run test/unit/server.test.ts`
Expected: PASS. (If the installed SDK version's `registerTool` signature differs — e.g. expects `inputSchema` as a zod raw shape vs `z.object()` — check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` and adapt; the raw-shape form above matches SDK ≥1.10.)

- [ ] **Step 5: Full suite + typecheck, then commit**

Run: `bun run typecheck && bun run test` → green.
Invoke `/auto-commit`.

---

### Task 8: Entry point + packaging (npx-from-GitHub ready)

**Files:**
- Create: `src/index.ts`
- Modify: `package.json` (verify `bin`/`prepare`/`files` — added in Task 1)
- Test: manual smoke test via MCP inspector-style JSON-RPC over stdio

**Interfaces:**
- Consumes: `loadConfig`, `ConnectionRegistry`, `SchemaCache`, `createServer`, `PostgresAdapter`, `MysqlAdapter`.
- Produces: the `database-mcp` executable (`dist/index.js`).

- [ ] **Step 1: Implement `src/index.ts`**

```ts
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { ConnectionRegistry } from "./core/registry.js";
import { SchemaCache } from "./core/schemaCache.js";
import { PostgresAdapter } from "./core/adapters/postgres.js";
import { MysqlAdapter } from "./core/adapters/mysql.js";
import { createServer } from "./server.js";
import type { Engine } from "./core/adapter.js";

function makeAdapter(engine: Engine, connectionString: string) {
  return engine === "postgres"
    ? new PostgresAdapter(connectionString)
    : new MysqlAdapter(connectionString);
}

async function main() {
  const { connections, settings } = loadConfig(process.env);
  const registry = new ConnectionRegistry(connections, makeAdapter);
  const cache = new SchemaCache(settings.schemaCacheTtlMs);
  const server = createServer({ registry, cache, settings });

  const shutdown = async () => {
    await registry.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // stdout is the MCP channel — all logging must go to stderr.
  console.error(
    `database-mcp: ${connections.length} connection(s) configured: ${connections.map((c) => c.name).join(", ") || "(none — set DBMCP_<NAME> env vars)"}`,
  );
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("database-mcp fatal:", e instanceof Error ? e.message : e);
  process.exit(1);
});
```

- [ ] **Step 2: Build and smoke-test over stdio**

Run:

```bash
bun run build
DBMCP_TEST_PG="postgres://u:p@localhost/db" node dist/index.js <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
```

Expected: two JSON-RPC responses on stdout; the `tools/list` result names all six tools; the stderr line lists `test_pg`. (No DB connection is made until a tool call, so a fake connection string is fine.)

- [ ] **Step 3: Verify npx-from-git packaging**

Run: `bun pm pack --dry-run`
Expected: tarball contains `dist/` (built by `prepare`), `README.md`, `package.json` — and no `src/`, `test/`, or `docs/`.

- [ ] **Step 4: Full suite + typecheck, then commit**

Run: `bun run typecheck && bun run test` → green.
Invoke `/auto-commit`.

---

### Task 9: Claude Code plugin manifests + README

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.mcp.json`
- Create: `README.md`

**Interfaces:**
- Consumes: the packaged server from Task 8.
- Produces: installable plugin (`/plugin marketplace add <you>/database-mcp`) and full user docs.

- [ ] **Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "database-mcp",
  "description": "Read-only Text-to-SQL over PostgreSQL and MySQL: ask questions in natural language, get answers backed by safe, verified SQL.",
  "version": "0.1.0",
  "author": { "name": "Kaushal Mishra" },
  "mcpServers": {
    "database-mcp": {
      "command": "npx",
      "args": ["-y", "github:REPLACE_GH_USER/database-mcp"]
    }
  }
}
```

(`REPLACE_GH_USER` is filled with the user's GitHub username before first release — ask if not yet provided.)

- [ ] **Step 2: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "database-mcp-marketplace",
  "owner": { "name": "Kaushal Mishra" },
  "plugins": [
    {
      "name": "database-mcp",
      "source": "./",
      "description": "Read-only Text-to-SQL MCP server for PostgreSQL and MySQL."
    }
  ]
}
```

- [ ] **Step 3: Write `.mcp.json`** (project-level config so this repo itself can use the server during development)

```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "node",
      "args": ["dist/index.js"]
    }
  }
}
```

- [ ] **Step 4: Write `README.md`**

Sections (write in full, no placeholders except `REPLACE_GH_USER`):

1. **What it is** — one paragraph: read-only Text-to-SQL MCP server; NL→SQL happens in the client LLM; four-layer read-only guarantee.
2. **Tools** — table of the six tools with one-line descriptions.
3. **Install** — all four paths with exact commands/JSON:
   - npx from GitHub (client config JSON block),
   - `claude mcp add database-mcp -e DBMCP_PROD_PG=… -- npx -y github:REPLACE_GH_USER/database-mcp`,
   - Claude Code plugin (`/plugin marketplace add REPLACE_GH_USER/database-mcp`, `/plugin install database-mcp`),
   - clone + build.
4. **Configuration** — `DBMCP_<NAME>` connection env vars; settings env vars table (`DBMCP_DEFAULT_LIMIT`, `DBMCP_MAX_LIMIT`, `DBMCP_TIMEOUT_MS`, `DBMCP_SCHEMA_CACHE_TTL_MS`, `DBMCP_PREVIEW_ROWS`) with defaults.
5. **Safety model** — the four layers, one short paragraph each, plus the strongly-recommended read-only DB user with copy-paste SQL:
   ```sql
   -- PostgreSQL
   CREATE ROLE mcp_readonly LOGIN PASSWORD '...';
   GRANT CONNECT ON DATABASE mydb TO mcp_readonly;
   GRANT USAGE ON SCHEMA public TO mcp_readonly;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
   ```
   ```sql
   -- MySQL
   CREATE USER 'mcp_readonly'@'%' IDENTIFIED BY '...';
   GRANT SELECT, SHOW VIEW ON mydb.* TO 'mcp_readonly'@'%';
   ```
6. **Example session** — a short transcript: user question → `get_schema` → `run_query` → answer.
7. **Development** — `bun install`, `bun run test`, `bun run test:integration` (needs Docker).

- [ ] **Step 5: Validate plugin JSON + commit**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')); JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8')); console.log('valid')"`
Expected: `valid`.
Invoke `/auto-commit`.

---

### Task 10: End-to-end verification

**Files:** none created — verification only.

- [ ] **Step 1: Full unit suite + typecheck**

Run: `bun run typecheck && bun run test`
Expected: all green.

- [ ] **Step 2: Integration suite (Docker required)**

Run: `bun run test:integration`
Expected: Postgres + MySQL contract suites and both engine-level backstop tests pass. If Docker is unavailable locally, state this explicitly to the user rather than skipping silently.

- [ ] **Step 3: Live smoke test against a real MCP client**

Register locally and exercise it:

```bash
claude mcp add database-mcp-dev -s local -e DBMCP_DEMO_PG="postgres://localhost/demo" -- node "$(pwd)/dist/index.js"
```

Then in a Claude Code session ask: *"Using database-mcp-dev, list the connections and describe what's in demo."* Verify `list_connections` → `get_schema` flow works (or that structured `connection_failed` comes back if the demo DB is down — that's also a correct behavior to observe).

- [ ] **Step 4: Final commit via auto-commit; offer next steps**

Invoke `/auto-commit`. Then offer the user: fill in `REPLACE_GH_USER`, create the GitHub repo, push, and optionally publish to the npm registry (`bun publish`).
