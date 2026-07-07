import { describe, it, expect } from "vitest";
import { SchemaCache } from "../../src/core/schemaCache.js";
import type { SchemaSnapshot } from "../../src/core/adapter.js";

const snap: SchemaSnapshot = { engine: "postgres", tables: [], relationships: [] };

describe("SchemaCache", () => {
  it("returns cached value within TTL and expires after", () => {
    let t = 0;
    const cache = new SchemaCache(1000, () => t);
    cache.set("prod_pg", snap);
    t = 999;
    expect(cache.get("prod_pg")).toBe(snap);
    t = 1001;
    expect(cache.get("prod_pg")).toBeUndefined();
  });
  it("invalidate() removes an entry", () => {
    const cache = new SchemaCache(1000, () => 0);
    cache.set("k", snap);
    cache.invalidate("k");
    expect(cache.get("k")).toBeUndefined();
  });
});
