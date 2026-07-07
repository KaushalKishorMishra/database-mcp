import mysql from "mysql2/promise";
import type {
  DatabaseAdapter, ExecuteOptions, ExplainResult, QueryResult,
  SchemaSnapshot, TableDetail, TableInfo,
} from "../adapter.js";
import { validateReadOnly, ensureLimit } from "../safety.js";

export class MysqlAdapter implements DatabaseAdapter {
  readonly engine = "mysql" as const;
  private pool: mysql.Pool;

  constructor(connectionString: string) {
    this.pool = mysql.createPool({ uri: connectionString, connectionLimit: 3 });
  }

  async connect(): Promise<void> {
    const c = await this.pool.getConnection();
    c.release();
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async introspectSchema(): Promise<SchemaSnapshot> {
    // NOTE: information_schema columns come back from mysql2 using their
    // native (uppercase) names unless explicitly aliased — MySQL does not
    // respect the query's casing for these system views the way user tables
    // do. Every information_schema SELECT below aliases columns to the
    // lowercase names this file expects.
    const [cols] = await this.pool.query<mysql.RowDataPacket[]>(`
      SELECT table_schema AS table_schema, table_name AS table_name,
             column_name AS column_name, data_type AS data_type
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
      ORDER BY table_name, ordinal_position`);
    const [fks] = await this.pool.query<mysql.RowDataPacket[]>(`
      SELECT table_name AS src_table, column_name AS src_col,
             referenced_table_name AS ref_table, referenced_column_name AS ref_col
      FROM information_schema.key_column_usage
      WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`);

    const byTable = new Map<string, { schema: string; table: string; columns: { name: string; type: string }[] }>();
    for (const r of cols) {
      const key = `${r.table_schema}.${r.table_name}`;
      if (!byTable.has(key)) {
        byTable.set(key, { schema: r.table_schema, table: r.table_name, columns: [] });
      }
      byTable.get(key)!.columns.push({ name: r.column_name, type: r.data_type });
    }
    return {
      engine: this.engine,
      tables: [...byTable.values()],
      relationships: fks.map(
        (r) => `${r.src_table}.${r.src_col} -> ${r.ref_table}.${r.ref_col}`,
      ),
    };
  }

  async listTables(schema?: string): Promise<TableInfo[]> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT table_schema AS table_schema, table_name AS table_name,
              table_type AS table_type, table_rows AS table_rows
       FROM information_schema.tables
       WHERE table_schema = COALESCE(?, DATABASE())
       ORDER BY table_name`,
      [schema ?? null],
    );
    return rows.map((r) => ({
      schema: r.table_schema,
      table: r.table_name,
      type: r.table_type === "VIEW" ? "view" : "table",
      approxRows: r.table_rows ?? undefined,
    }));
  }

  async describeTable(table: string, schema?: string): Promise<TableDetail> {
    const [cols] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS column_name, data_type AS data_type,
              is_nullable AS is_nullable, column_default AS column_default,
              column_key AS column_key
       FROM information_schema.columns
       WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
       ORDER BY ordinal_position`,
      [schema ?? null, table],
    );
    const [fks] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT column_name AS src_col, referenced_table_name AS ref_table,
              referenced_column_name AS ref_col
       FROM information_schema.key_column_usage
       WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
         AND referenced_table_name IS NOT NULL`,
      [schema ?? null, table],
    );
    const [idx] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT index_name AS name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols,
              MIN(non_unique) AS non_unique
       FROM information_schema.statistics
       WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
       GROUP BY index_name`,
      [schema ?? null, table],
    );
    return {
      schema: schema ?? "",
      table,
      columns: cols.map((r) => ({
        name: r.column_name,
        type: r.data_type,
        nullable: r.is_nullable === "YES",
        default: r.column_default,
        isPrimaryKey: r.column_key === "PRI",
      })),
      foreignKeys: fks.map((r) => ({
        column: r.src_col, referencesTable: r.ref_table, referencesColumn: r.ref_col,
      })),
      indexes: idx.map((r) => ({
        name: r.name,
        columns: String(r.cols ?? "").split(","),
        unique: r.non_unique === 0,
      })),
    };
  }

  async explain(sql: string): Promise<ExplainResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v;
    const bare = sql.trim().replace(/^explain\s+/i, "");
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(`EXPLAIN ${bare}`);
    const plan = rows.map((r) => JSON.stringify(r)).join("\n");
    const warnings: string[] = [];
    if (rows.some((r) => r.type === "ALL")) warnings.push("Full table scan detected — consider a WHERE clause on an indexed column.");
    if (!v.hasLimit) warnings.push("Query has no LIMIT — a default limit will be applied on execution.");
    return { plan, warnings };
  }

  async execute(sql: string, opts: ExecuteOptions): Promise<QueryResult> {
    const v = validateReadOnly(sql, this.engine);
    if (!v.ok) throw v;
    // Fetch one extra row beyond maxRows so we can distinguish an exact-fit
    // result (rowCount === maxRows, not truncated) from a truly truncated one.
    const finalSql = v.statementType === "select" ? ensureLimit(sql, opts.maxRows + 1) : sql;

    const conn = await this.pool.getConnection();
    try {
      // max_execution_time only throttles SELECT statements in MySQL; that is
      // acceptable here because all mutating statements are already rejected
      // upstream by validateReadOnly, so every statement reaching this point
      // that could run long is itself a SELECT.
      await conn.query(`SET SESSION max_execution_time = ${Math.floor(opts.timeoutMs)}`);
      await conn.query("START TRANSACTION READ ONLY");
      const [rows, fields] = await conn.query({ sql: finalSql, rowsAsArray: true });
      const all = rows as unknown[][];
      const resultRows = all.slice(0, opts.maxRows);
      return {
        columns: (fields ?? []).map((f) => f.name),
        rows: resultRows,
        rowCount: resultRows.length,
        truncated: all.length > opts.maxRows,
      };
    } finally {
      try {
        await conn.query("ROLLBACK");
        conn.release();
      } catch {
        // Transaction state is unknown after a failed ROLLBACK — mysql2 has
        // no release(true) equivalent, so destroy the connection outright
        // instead of returning a possibly-dirty one to the pool.
        conn.destroy();
      }
    }
  }
}
