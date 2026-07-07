export type Engine = "postgres" | "mysql";

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  schema: string;
  table: string;
  type: "table" | "view";
  approxRows?: number;
}

export interface ForeignKey {
  column: string;
  referencesTable: string;
  referencesColumn: string;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableDetail {
  schema: string;
  table: string;
  columns: ColumnInfo[];
  foreignKeys: ForeignKey[];
  indexes: IndexInfo[];
}

/** Compact whole-DB overview powering get_schema (token-efficient). */
export interface SchemaSnapshot {
  engine: Engine;
  tables: Array<{
    schema: string;
    table: string;
    columns: Array<{ name: string; type: string }>;
  }>;
  /** e.g. "orders.customer_id -> customers.id" */
  relationships: string[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export interface ExecuteOptions {
  /** Hard cap on rows returned (post auto-LIMIT). */
  maxRows: number;
  timeoutMs: number;
}

export interface ExplainResult {
  plan: string;
  warnings: string[];
}

export interface DatabaseAdapter {
  readonly engine: Engine;
  connect(): Promise<void>;
  close(): Promise<void>;
  introspectSchema(): Promise<SchemaSnapshot>;
  listTables(schema?: string): Promise<TableInfo[]>;
  describeTable(table: string, schema?: string): Promise<TableDetail>;
  explain(sql: string): Promise<ExplainResult>;
  execute(sql: string, opts: ExecuteOptions): Promise<QueryResult>;
}

export type ErrorCode =
  | "unknown_connection"
  | "not_read_only"
  | "multiple_statements"
  | "parse_error"
  | "timeout"
  | "connection_failed";

export interface ToolError {
  error: ErrorCode;
  message: string;
  [key: string]: unknown;
}

export function err(
  code: ErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): ToolError {
  return { error: code, message, ...extra };
}
