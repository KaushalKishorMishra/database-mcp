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
