import pg from "pg";
import type {
  DatabaseAdapter, ExecuteOptions, ExplainResult, QueryResult,
  SchemaSnapshot, TableDetail, TableInfo,
} from "../adapter.js";
import { validateReadOnly, ensureLimit } from "../safety.js";

export class PostgresAdapter implements DatabaseAdapter {
  readonly engine = "postgres" as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 3 });
  }

  async connect(): Promise<void> {
    const c = await this.pool.connect();
    c.release();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async introspectSchema(): Promise<SchemaSnapshot> {
    const cols = await this.pool.query(`
      SELECT table_schema, table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name, ordinal_position`);
    const fks = await this.pool.query(`
      SELECT tc.table_name AS src_table, kcu.column_name AS src_col,
             ccu.table_name AS ref_table, ccu.column_name AS ref_col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'`);

    const byTable = new Map<string, { schema: string; table: string; columns: { name: string; type: string }[] }>();
    for (const r of cols.rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!byTable.has(key)) {
        byTable.set(key, { schema: r.table_schema, table: r.table_name, columns: [] });
      }
      byTable.get(key)!.columns.push({ name: r.column_name, type: r.data_type });
    }
    return {
      engine: this.engine,
      tables: [...byTable.values()],
      relationships: fks.rows.map(
        (r) => `${r.src_table}.${r.src_col} -> ${r.ref_table}.${r.ref_col}`,
      ),
    };
  }

  async listTables(schema = "public"): Promise<TableInfo[]> {
    const res = await this.pool.query(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables WHERE table_schema = $1
       ORDER BY table_name`,
      [schema],
    );
    return res.rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      type: r.table_type === "VIEW" ? "view" : "table",
    }));
  }

  async describeTable(table: string, schema = "public"): Promise<TableDetail> {
    const cols = await this.pool.query(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
              EXISTS (
                SELECT 1 FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND tc.table_schema = c.table_schema AND tc.table_name = c.table_name
                  AND kcu.column_name = c.column_name
              ) AS is_pk
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table],
    );
    const fks = await this.pool.query(
      `SELECT kcu.column_name AS src_col, ccu.table_name AS ref_table, ccu.column_name AS ref_col
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1 AND tc.table_name = $2`,
      [schema, table],
    );
    const idx = await this.pool.query(
      `SELECT indexname AS name, indexdef FROM pg_indexes
       WHERE schemaname = $1 AND tablename = $2`,
      [schema, table],
    );
    return {
      schema,
      table,
      columns: cols.rows.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default,
        isPrimaryKey: r.is_pk,
      })),
      foreignKeys: fks.rows.map((r) => ({
        column: r.src_col, referencesTable: r.ref_table, referencesColumn: r.ref_col,
      })),
      indexes: idx.rows.map((r) => ({
        name: r.name,
        columns: [], // parsing indexdef is not worth it for v1; name + unique flag suffice
        unique: /UNIQUE/i.test(r.indexdef),
      })),
    };
  }

  async explain(sql: string): Promise<ExplainResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v; // tools layer converts ToolError-shaped throws
    const bare = sql.trim().replace(/^explain\s+/i, "");
    const res = await this.pool.query(`EXPLAIN ${bare}`);
    const plan = res.rows.map((r) => r["QUERY PLAN"]).join("\n");
    const warnings: string[] = [];
    if (/Seq Scan/i.test(plan)) warnings.push("Sequential scan detected — consider adding a WHERE clause on an indexed column.");
    if (!v.hasLimit) warnings.push("Query has no LIMIT — a default limit will be applied on execution.");
    return { plan, warnings };
  }

  async execute(sql: string, opts: ExecuteOptions): Promise<QueryResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v;
    const finalSql = v.statementType === "select" ? ensureLimit(sql, opts.maxRows) : sql;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(opts.timeoutMs)}`);
      const res = await client.query({ text: finalSql, rowMode: "array" });
      const rows = (res.rows as unknown[][]).slice(0, opts.maxRows);
      return {
        columns: res.fields.map((f) => f.name),
        rows,
        rowCount: rows.length,
        truncated: (res.rows as unknown[][]).length > opts.maxRows ||
          rows.length === opts.maxRows,
      };
    } finally {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      client.release();
    }
  }
}
