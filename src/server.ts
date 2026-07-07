import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ConnectionRegistry } from "./core/registry.js";
import type { SchemaCache } from "./core/schemaCache.js";
import type { Settings } from "./config.js";
import type { DatabaseAdapter, ToolError } from "./core/adapter.js";
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
  // Adapters may throw a ValidationFail-shaped object ({ok:false, error, message});
  // strip any `ok` field so it never leaks into the client-facing payload.
  const { ok: _ok, ...rest } = e as ToolError & { ok?: unknown };
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(rest) }],
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
    fn: (adapter: DatabaseAdapter) => Promise<T>,
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
