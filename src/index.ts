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
