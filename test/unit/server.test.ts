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

  it("sanitize redacts URLs from connection errors", async () => {
    (adapter.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('connection to server at "postgres://admin:s3cretpw@db.host:5432/prod" failed')
    );
    const res = await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "SELECT 1" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const p = payload(res);
    expect(p.error).toBe("connection_failed");
    expect(p.message).toContain("[redacted]");
    const fullText = JSON.stringify(res);
    expect(fullText).not.toContain("s3cretpw");
    expect(fullText).not.toContain("postgres://");
  });

  it("sanitize maps statement timeout to timeout error code", async () => {
    (adapter.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("canceling statement due to statement timeout")
    );
    const res = await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "SELECT 1" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const p = payload(res);
    expect(p.error).toBe("timeout");
    expect(p.message).toContain("Add filters or a smaller LIMIT");
  });

  it("sanitize maps MySQL max_execution_time to timeout error code", async () => {
    (adapter.execute as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Query execution was interrupted, maximum statement execution time exceeded (max_execution_time)")
    );
    const res = await client.callTool({
      name: "run_query",
      arguments: { connection: "prod_pg", sql: "SELECT 1" },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    const p = payload(res);
    expect(p.error).toBe("timeout");
  });
});
