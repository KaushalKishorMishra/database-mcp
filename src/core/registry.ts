import type { DatabaseAdapter, Engine, ToolError } from "./adapter.js";
import { err } from "./adapter.js";
import type { NamedConnection } from "../config.js";
import { engineFromUrl } from "../config.js";

export type AdapterFactory = (
  engine: Engine,
  connectionString: string,
) => DatabaseAdapter;

export class ConnectionRegistry {
  private byName = new Map<string, NamedConnection>();
  private adapters = new Map<string, DatabaseAdapter>();

  constructor(
    connections: NamedConnection[],
    private factory: AdapterFactory,
  ) {
    for (const c of connections) this.byName.set(c.name, c);
  }

  list(): Array<{ name: string; engine: Engine; description?: string }> {
    return [...this.byName.values()].map(({ name, engine, description }) => ({
      name,
      engine,
      description,
    }));
  }

  resolve(connection: string): { adapter: DatabaseAdapter; engine: Engine } | ToolError {
    const named = this.byName.get(connection);
    if (named) {
      let adapter = this.adapters.get(connection);
      if (!adapter) {
        adapter = this.factory(named.engine, named.connectionString);
        this.adapters.set(connection, adapter);
      }
      return { adapter, engine: named.engine };
    }
    // Call-time connection-string escape hatch.
    if (connection.includes("://")) {
      const engine = engineFromUrl(connection);
      if (!engine) {
        return err(
          "unknown_connection",
          "Connection string scheme not supported. Supported: postgres://, postgresql://, mysql://.",
        );
      }
      let adapter = this.adapters.get(connection);
      if (!adapter) {
        adapter = this.factory(engine, connection);
        this.adapters.set(connection, adapter);
      }
      return { adapter, engine };
    }
    return err("unknown_connection", `No connection named '${connection}'.`, {
      valid_connections: [...this.byName.keys()],
    });
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((a) => a.close()));
    this.adapters.clear();
  }
}
