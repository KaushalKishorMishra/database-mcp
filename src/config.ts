import { z } from "zod";
import type { Engine } from "./core/adapter.js";

export interface NamedConnection {
  name: string;
  engine: Engine;
  connectionString: string;
  description?: string;
}

const settingsSchema = z.object({
  defaultLimit: z.coerce.number().int().positive().default(100),
  maxLimit: z.coerce.number().int().positive().default(1000),
  timeoutMs: z.coerce.number().int().positive().default(15000),
  schemaCacheTtlMs: z.coerce.number().int().positive().default(300000),
  previewRows: z.coerce.number().int().positive().default(5),
});
export type Settings = z.infer<typeof settingsSchema>;

export function engineFromUrl(url: string): Engine | null {
  if (/^postgres(ql)?:\/\//i.test(url)) return "postgres";
  if (/^mysql:\/\//i.test(url)) return "mysql";
  return null;
}

const SETTING_KEYS = new Set([
  "DBMCP_DEFAULT_LIMIT", "DBMCP_MAX_LIMIT", "DBMCP_TIMEOUT_MS",
  "DBMCP_SCHEMA_CACHE_TTL_MS", "DBMCP_PREVIEW_ROWS",
]);

export function loadConfig(env: NodeJS.ProcessEnv): {
  connections: NamedConnection[];
  settings: Settings;
} {
  const connections: NamedConnection[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("DBMCP_") || SETTING_KEYS.has(key) || !value) continue;
    const engine = engineFromUrl(value);
    if (!engine) continue; // unsupported scheme — skip silently
    connections.push({
      name: key.slice("DBMCP_".length).toLowerCase(),
      engine,
      connectionString: value,
    });
  }
  const settings = settingsSchema.parse({
    defaultLimit: env.DBMCP_DEFAULT_LIMIT,
    maxLimit: env.DBMCP_MAX_LIMIT,
    timeoutMs: env.DBMCP_TIMEOUT_MS,
    schemaCacheTtlMs: env.DBMCP_SCHEMA_CACHE_TTL_MS,
    previewRows: env.DBMCP_PREVIEW_ROWS,
  });
  return { connections, settings };
}
