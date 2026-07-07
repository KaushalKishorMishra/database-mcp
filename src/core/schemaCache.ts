import type { SchemaSnapshot } from "./adapter.js";

export class SchemaCache {
  private entries = new Map<string, { snapshot: SchemaSnapshot; expiresAt: number }>();

  constructor(
    private ttlMs: number,
    private now: () => number = Date.now,
  ) {}

  get(key: string): SchemaSnapshot | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() > e.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return e.snapshot;
  }

  set(key: string, snapshot: SchemaSnapshot): void {
    this.entries.set(key, { snapshot, expiresAt: this.now() + this.ttlMs });
  }

  invalidate(key: string): void {
    this.entries.delete(key);
  }
}
