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
  // Bypass the validator deliberately to prove layer 3 stands alone.
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
