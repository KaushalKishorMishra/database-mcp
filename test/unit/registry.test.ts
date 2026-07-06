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
