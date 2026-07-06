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
