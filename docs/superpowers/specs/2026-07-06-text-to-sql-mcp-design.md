# Text-to-SQL MCP Tool — Design Spec

**Date:** 2026-07-06
**Status:** Approved for planning

## Summary

A Model Context Protocol (MCP) server, written in TypeScript, that lets an LLM
answer natural-language questions about SQL databases (MySQL and PostgreSQL) by
generating and running **read-only** SQL, then returning results as both
machine-readable rows and a ready-to-display table. Read-only access is enforced
as a built-in, defense-in-depth guardrail so the model can surface data but never
mutate it.

The natural-language → SQL reasoning happens **client-side**: the server exposes
composable read-only tools, and the LLM in the MCP client (Claude Desktop, Claude
Code, Cursor, etc.) orchestrates them. The server holds no LLM API key.

## Goals

- A real, day-to-day-usable tool (not just a demo), safety-first.
- Connect to multiple databases; select them by name.
- Convert natural-language questions into read-only SQL and return answers in
  natural language (produced by the client LLM) and/or table form (produced by
  the server).
- Enforce a hard "never mutates data" guarantee.
- Be token-efficient so a question typically costs ~2 tool round-trips.
- Be extensible: adding another SQL engine (and, later, NoSQL) is additive, not a
  rewrite.

## Non-Goals (v1)

- No server-side LLM calls / no `ask()` mega-tool (reasoning stays client-side).
- No MongoDB / NoSQL adapter in v1 (the adapter seam leaves the door open).
- No HTTP transport in v1 (core is transport-agnostic so it can be added later).
- No write operations of any kind.

## Key Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Primary goal | Real, safety-first tool | User intent |
| NL→SQL location | Client-side (idiomatic MCP) | No API key, cheaper, model-agnostic |
| Connection config | Hybrid: named connections (default) + call-time connection string (escape hatch) | Safe by default, flexible when needed |
| Read-only guardrail | Full defense-in-depth (4 layers) | Honest "never mutates" guarantee |
| "Verify queries" | Safe-by-default + `explain_query` dry-run + `preview` rows | Covers all senses of "verify" |
| Language/runtime | TypeScript / Node, `@modelcontextprotocol/sdk` | Mature MCP SDK, clean packaging |
| SQL parser | `node-sql-parser` (multi-dialect) | Powers allowlist; scales to new dialects |
| Data access | Raw drivers (`pg`, `mysql2`), no ORM | LLM emits arbitrary SQL over unknown schemas — ORMs fight this |
| Transport | stdio only (v1) | Simplest, local, no network surface |
| Efficiency | `get_schema` compact snapshot + per-connection schema cache | ~2 round-trips per question |

## Architecture

Three concentric layers so the reusable/risky logic never depends on transport.

```
┌─────────────────────────────────────────────┐
│  MCP Client (Claude Desktop / Code / Cursor) │  ← LLM lives here; does NL→SQL
└───────────────────────┬─────────────────────┘
                        │ stdio (JSON-RPC)
┌───────────────────────▼─────────────────────┐
│  Transport layer (thin)   StdioServerTransport│
├──────────────────────────────────────────────┤
│  MCP layer      registers tools, zod-validates│
├──────────────────────────────────────────────┤
│  Core (transport-agnostic, the real logic)   │
│   • ConnectionRegistry (named + call-time)    │
│   • SchemaCache (per-connection, TTL)         │
│   • SafetyValidator (SQL allowlist)           │
│   • DatabaseAdapter interface                 │
│      ├─ PostgresAdapter (pg)                  │
│      └─ MysqlAdapter    (mysql2)              │
│   • ResultFormatter (rows → JSON + md table)  │
└──────────────────────────────────────────────┘
```

The Core knows nothing about MCP or stdio — this is what makes "add HTTP
transport later" and "add a MongoAdapter later" bounded, additive changes, and
what makes the whole thing unit-testable without an MCP client.

### Project structure

```
database-mcp/
├── src/
│   ├── index.ts                 # entry: wires transport → MCP → core
│   ├── server.ts                # builds MCP server, registers tools
│   ├── config.ts                # loads named connections from env, zod-validated
│   ├── core/
│   │   ├── adapter.ts           # DatabaseAdapter interface + shared types
│   │   ├── registry.ts          # ConnectionRegistry (resolve name | conn-string)
│   │   ├── schemaCache.ts       # per-connection TTL cache
│   │   ├── safety.ts            # SafetyValidator (parse + allowlist)
│   │   ├── formatter.ts         # rows → { columns, rows, markdown, truncated }
│   │   └── adapters/
│   │       ├── postgres.ts
│   │       └── mysql.ts
│   └── tools/                   # one thin file per MCP tool (calls core)
│       ├── listConnections.ts
│       ├── getSchema.ts
│       ├── listTables.ts
│       ├── describeTable.ts
│       ├── explainQuery.ts
│       └── runQuery.ts
├── .claude-plugin/              # Claude Code plugin + marketplace manifests
│   ├── plugin.json
│   └── marketplace.json
├── test/                        # vitest: unit + testcontainers integration
├── package.json                 # bin: database-mcp; prepare build; publish-ready
└── README.md
```

Each `tools/*` file is thin (arg schema + a call into core) so the logic under
test lives in `core/`.

## The DatabaseAdapter Interface (extensibility seam)

Defined at the altitude of "translate intent → validate → execute read-only →
return rows" rather than literally "run this SQL string", so future non-SQL
engines can implement it.

```ts
interface DatabaseAdapter {
  engine: "postgres" | "mysql";        // extend as adapters are added
  connect(): Promise<void>;
  close(): Promise<void>;
  introspectSchema(): Promise<SchemaSnapshot>;   // powers get_schema
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<TableDetail>;
  explain(sql: string): Promise<ExplainResult>;  // no data returned
  execute(sql: string, opts: ExecuteOptions): Promise<QueryResult>; // read-only
}
```

Adding an engine = one new adapter + register its dialect with the parser + pass
the shared adapter contract test suite. No rewrite.

## MCP Tools (6, all read-only)

Small, composable tools the client LLM chains together. Each validates args with
zod. Every tool takes `connection` — a **name** by default, or a raw connection
string as the escape hatch.

1. **`list_connections`** — In: none. Out: `[{ name, engine, description }]`.
   Never returns credentials.
2. **`get_schema`** ⭐ — In: `{ connection }`. Out: compact whole-DB overview
   (tables + columns + key relationships, condensed). The default first call;
   cached. Biggest lever for keeping questions to ~2 round-trips.
3. **`list_tables`** — In: `{ connection, schema? }`.
   Out: `[{ schema, table, type, approx_rows? }]`. Backed by `information_schema`.
4. **`describe_table`** — In: `{ connection, table, schema? }`.
   Out: columns `[{ name, type, nullable, default, is_primary_key }]`, foreign
   keys, indexes. For zooming into one table when the schema is too big to fit.
5. **`explain_query`** (dry-run) — In: `{ connection, sql }`.
   Out: query plan (`EXPLAIN`, not `EXPLAIN ANALYZE` — nothing executes) + parsed
   summary + safety warnings (e.g. "no LIMIT", "sequential scan"). Runs through
   the validator first.
6. **`run_query`** (main) — In: `{ connection, sql, limit?, preview? }`.
   Out: `{ columns, rows, row_count, truncated, markdown_table }`.
   `preview: true` → only a handful of rows (sanity-check before a big run).
   Always passes the full defense-in-depth validator, applies default/max
   `LIMIT`, runs under a read-only transaction with a statement timeout.

The client LLM turns `run_query` rows into the natural-language answer; the
`markdown_table` gives the table form. No `ask()` tool — reasoning is client-side.

Tool descriptions instruct the efficient path: "call `get_schema` first; only use
`describe_table` to zoom into one table."

## Defense-in-Depth Safety

Four independent layers — a bug in one is still caught by the next.

1. **Statement allowlist (parse, not regex).** Parse every `sql` with
   `node-sql-parser` for the connection's dialect. Allow only read statement
   types: `SELECT`, `WITH…SELECT`, `EXPLAIN`, `SHOW`, `DESCRIBE`. Reject
   `INSERT/UPDATE/DELETE/MERGE`, all DDL, `GRANT`, `CALL`, etc. Parsing defeats
   comment-smuggling and casing tricks.
2. **Single-statement enforcement.** Parser must yield exactly one statement —
   kills stacked queries (`SELECT 1; DROP TABLE users`).
3. **Read-only transaction backstop (engine level).** Postgres
   `BEGIN TRANSACTION READ ONLY`; MySQL `START TRANSACTION READ ONLY`; then
   rollback. A parser miss still cannot write — the engine errors.
4. **Blast-radius limits.** Statement timeout (`statement_timeout` /
   `MAX_EXECUTION_TIME`); auto-`LIMIT` on unbounded SELECTs (default + hard max,
   `truncated` flagged); row/response caps so we never serialize huge results.

**Recommended companion (ops, not code):** connect with a **read-only DB user** —
a free fifth layer. README documents creating one for Postgres and MySQL. Layers
1–4 stand alone; we don't depend on it.

**Call-time connection strings:** never logged, never echoed in output, still run
through all four layers.

## Error Handling

Errors return structured, model-readable results (not thrown stacks) so the LLM
can recover autonomously. No error path leaks a connection string or credentials.

| Situation | Returned |
|---|---|
| Unknown connection name | `error: "unknown_connection"` + valid names |
| Blocked write / DDL | `error: "not_read_only"` + rejected statement type |
| SQL syntax / parse error | `error: "parse_error"` + parser message |
| Statement timeout | `error: "timeout"` + hint to add filters/LIMIT |
| Connection/DB down | `error: "connection_failed"` (message sanitized) |
| Result too large | rows truncated to cap, `truncated: true`, `row_count` |

## Configuration

- Named connections loaded at startup from env vars (zod-validated), e.g.
  `PROD_PG`, `ANALYTICS_MYSQL`, each a connection string, with optional
  descriptions.
- Tunables (with sane defaults): default `LIMIT`, max `LIMIT`, statement timeout,
  schema-cache TTL, max response rows.

## Distribution & Install

Packaging supports all paths at once (nearly free):

- **GitHub via `npx`** (default documented path):
  `npx -y github:<you>/database-mcp` — enabled by a `bin` field + a `prepare`
  build script so it builds on install.
- **GitHub clone + build**: `git clone … && npm install && npm run build`, point
  client config at `dist/index.js`.
- **`claude mcp add`** (Claude Code CLI one-liner):
  `claude mcp add database-mcp -e PROD_PG=… -- npx -y github:<you>/database-mcp`.
- **Claude Code plugin + marketplace**: ship `.claude-plugin/plugin.json` (refs
  the MCP server) and `marketplace.json`; install via
  `/plugin marketplace add <you>/database-mcp` then `/plugin install database-mcp`.
- **Optional/additive**: publish to **npm** (`npx -y database-mcp`); build a
  Claude **Desktop Extension** (`.mcpb`) for one-click desktop install.

Example client config (stdio):

```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "npx",
      "args": ["-y", "github:<you>/database-mcp"],
      "env": { "PROD_PG": "postgres://readonly@host/db" }
    }
  }
}
```

## Testing Strategy (vitest)

- **Unit — SafetyValidator (crown jewel):** large table of malicious/edge inputs
  that must all be rejected (stacked queries, comment-smuggled DDL, writes hidden
  in CTEs, casing tricks, `pg_sleep` abuse) plus valid SELECT/CTE/EXPLAIN that
  must pass.
- **Unit — ResultFormatter, ConnectionRegistry, config loader**, including
  "credentials never appear in output".
- **Integration — real engines via `testcontainers`:** throwaway Postgres + MySQL
  in Docker, seeded schema; assert `get_schema` shape, that a real `UPDATE` is
  refused at both the validator and the read-only-transaction layers, auto-LIMIT
  works, timeout fires.
- **Adapter contract tests:** one shared suite run against every adapter, so a
  future SQLite/Mongo adapter must clear the same bar.

## Future Extensions (out of scope for v1, enabled by the design)

- HTTP / streamable transport (core is transport-agnostic).
- More SQL engines (SQLite, SQL Server, BigQuery) — one adapter each.
- MongoDB / NoSQL as a "Text-to-Query" adapter with its own non-SQL validator
  (blocks `$out`, `$merge`, updates, `$function`, `mapReduce`; schema inferred by
  sampling).
- npm publish and Claude Desktop `.mcpb` bundle.
