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
