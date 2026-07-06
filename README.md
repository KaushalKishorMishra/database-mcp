# database-mcp

Read-only Text-to-SQL over PostgreSQL and MySQL, as an MCP (Model Context
Protocol) server. Ask a question in natural language in your MCP client (e.g.
Claude Code); the client's LLM turns it into SQL and calls this server's
tools to inspect the schema and run the query. **No SQL generation happens
inside this server** — it only exposes safe, structured primitives (schema
introspection, query execution) over stdio, and enforces that whatever SQL
arrives is provably read-only before it ever touches your database.

That read-only guarantee is enforced in four independent layers, so that no
single bug (in the client LLM, in this server, or in the database driver) can
turn a "question" into a write:

1. **Parse-based statement allowlist** — every query is parsed with
   `node-sql-parser` and only `SELECT` (including CTEs), `EXPLAIN`, `SHOW`,
   and `DESCRIBE` are permitted. `SELECT ... INTO` and `INTO OUTFILE` (which
   write data despite looking like a `SELECT`) are rejected, as is
   `EXPLAIN ANALYZE` in both its plain and parenthesized (`EXPLAIN (ANALYZE)`)
   forms, because it actually executes the query.
2. **Single-statement enforcement** — stacked queries (`SELECT 1; DROP TABLE
   users;`) are rejected outright, so a semicolon can't smuggle in a second,
   unvalidated statement.
3. **Engine-level read-only transactions** — every query additionally runs
   inside `BEGIN`/`START TRANSACTION READ ONLY`, so even a parser miss can't
   result in a write; the database itself refuses.
4. **Timeouts and row caps** — every query has a statement timeout, and an
   automatic `LIMIT` is applied and truncation is detected (by fetching one
   row past the limit), preventing runaway or oversized result sets.

Errors returned by the server are structured (`{ error, message }`) and
credential-sanitized: connection strings and passwords are never echoed back,
even in raw driver error messages.

## Tools

| Tool | Description |
| --- | --- |
| `list_connections` | List the configured database connections (name, engine, description). Never returns credentials. |
| `get_schema` | Compact, cached overview of an entire database: tables, columns, and foreign-key relationships. |
| `list_tables` | List tables and views in a database, optionally filtered by schema. |
| `describe_table` | Full detail for one table: columns, foreign keys, and indexes. |
| `explain_query` | Dry-run a SQL query (`EXPLAIN`, nothing executes) and get warnings such as missing `LIMIT` or sequential scans. |
| `run_query` | Execute a read-only SQL query and get back columns, rows, row count, a `truncated` flag, and a ready-to-display markdown table. |

## Install

### Option A: npx from GitHub (any MCP client)

Add this to your MCP client's config (e.g. `claude_desktop_config.json`, or
Claude Code's `.mcp.json`):

```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "npx",
      "args": ["-y", "github:REPLACE_GH_USER/database-mcp"],
      "env": {
        "DBMCP_PROD_PG": "postgres://mcp_readonly:password@host:5432/mydb"
      }
    }
  }
}
```

### Option B: `claude mcp add` (Claude Code CLI)

```bash
claude mcp add database-mcp -e DBMCP_PROD_PG=postgres://mcp_readonly:password@host:5432/mydb -- npx -y github:REPLACE_GH_USER/database-mcp
```

### Option C: Claude Code plugin

```
/plugin marketplace add REPLACE_GH_USER/database-mcp
/plugin install database-mcp
```

Then set your `DBMCP_<NAME>` connection env vars (see Configuration below)
in your shell or client environment before starting Claude Code.

### Option D: Clone and build

```bash
git clone https://github.com/REPLACE_GH_USER/database-mcp.git
cd database-mcp
bun install
bun run build
```

Then point your MCP client at the built server:

```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/database-mcp/dist/index.js"],
      "env": {
        "DBMCP_PROD_PG": "postgres://mcp_readonly:password@host:5432/mydb"
      }
    }
  }
}
```

## Configuration

### Connections

Each database connection is declared as an environment variable named
`DBMCP_<NAME>`, where `<NAME>` becomes the connection's identifier (lowercased)
that you pass to tools as the `connection` argument. The value is a standard
connection URL; the scheme determines the engine:

| Scheme | Engine |
| --- | --- |
| `postgres://` or `postgresql://` | PostgreSQL |
| `mysql://` | MySQL |

Example:

```bash
export DBMCP_PROD_PG="postgres://mcp_readonly:password@prod-db.example.com:5432/mydb"
export DBMCP_ANALYTICS_MYSQL="mysql://mcp_readonly:password@analytics-db.example.com:3306/warehouse"
```

`DBMCP_PROD_PG` and `DBMCP_ANALYTICS_MYSQL` above would appear as connections
named `prod_pg` and `analytics_mysql` respectively. Any `DBMCP_*` variable
whose value isn't a recognized connection URL (and isn't one of the settings
below) is skipped silently.

### Settings

| Env var | Default | Meaning |
| --- | --- | --- |
| `DBMCP_DEFAULT_LIMIT` | `100` | Rows returned by `run_query` when no `limit` is given. |
| `DBMCP_MAX_LIMIT` | `1000` | Hard cap on `limit`, regardless of what's requested. |
| `DBMCP_TIMEOUT_MS` | `15000` | Statement timeout for every query, in milliseconds. |
| `DBMCP_SCHEMA_CACHE_TTL_MS` | `300000` | How long `get_schema` results are cached per connection, in milliseconds. |
| `DBMCP_PREVIEW_ROWS` | `5` | Rows returned by `run_query` when `preview: true` is set. |

## Safety model

**1. Parse-based statement allowlist.** Every incoming SQL string is parsed
with `node-sql-parser` (dialect-aware for Postgres/MySQL) into an AST, and
only `SELECT` statements (including CTEs), `EXPLAIN`, `SHOW`, and `DESCRIBE`
are allowed through. The AST is walked recursively so writes hidden inside
subqueries, UNION members, or CTEs are also caught — not just the top-level
statement type. `SELECT ... INTO` and `INTO OUTFILE`/`DUMPFILE` are
specifically rejected because they write despite parsing as a `SELECT`, and
`EXPLAIN ANALYZE` (including the parenthesized `EXPLAIN (ANALYZE)` form) is
rejected because it actually executes the underlying query.

**2. Single-statement enforcement.** Only one SQL statement is permitted per
call. Stacked/batched statements (`SELECT 1; DELETE FROM users;`) are
rejected before execution, closing off the classic SQL-injection-via-semicolon
path even if the first statement alone would have passed the allowlist.

**3. Engine-level read-only transactions.** Independent of the parser, every
query is executed inside a database-enforced read-only transaction
(`BEGIN`/`START TRANSACTION READ ONLY` on Postgres, the MySQL equivalent on
MySQL). This means that even if the parser has a bug or blind spot, the
database itself will refuse to commit a write.

**4. Timeouts and row caps.** Every query runs under a statement timeout
(`DBMCP_TIMEOUT_MS`) so a runaway query can't hang the connection, and result
sets are capped by `limit`/`DBMCP_MAX_LIMIT`. Truncation is detected by
fetching one row past the limit, so `run_query` can tell you honestly whether
`truncated: true` and more rows exist.

### Strongly recommended: use a dedicated read-only database user

Even with all four layers above, defense in depth means the database
credentials you give this server should themselves only be able to read.
Create a role that can `SELECT` but nothing else:

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

## Example session

```
User: What were our top 5 customers by total order value last month?

Assistant: [calls list_connections]
           → [{ "name": "prod_pg", "engine": "postgres", ... }]

Assistant: [calls get_schema { connection: "prod_pg" }]
           → tables: customers(id, name, ...), orders(id, customer_id, total, created_at, ...)

Assistant: [calls run_query {
             connection: "prod_pg",
             sql: "SELECT c.name, SUM(o.total) AS total_value
                   FROM orders o JOIN customers c ON c.id = o.customer_id
                   WHERE o.created_at >= date_trunc('month', now()) - interval '1 month'
                     AND o.created_at < date_trunc('month', now())
                   GROUP BY c.name
                   ORDER BY total_value DESC
                   LIMIT 5",
             preview: true
           }]
           → { columns: ["name","total_value"], rows: [...], row_count: 5, truncated: false, markdown_table: "..." }

Assistant: Your top 5 customers by order value last month were:
           1. Acme Corp — $42,150
           2. Globex Inc — $38,920
           ...
```

## Development

```bash
bun install
bun run test
bun run test:integration   # needs Docker (or podman) for testcontainers
```
