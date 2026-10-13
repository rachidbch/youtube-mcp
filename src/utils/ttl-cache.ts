interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * TTL cache with a fixed entry limit, so a long-running server does not keep
 * every distinct key forever. When full, expired entries are dropped first,
 * then the least recently written ones.
 */
export class TTLCache<T> {
  private store = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries: number, private readonly now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    // Re-insert so Map order reflects the most recent write.
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: this.now() + ttlMs });
    if (this.store.size <= this.maxEntries) return;

    const now = this.now();
    for (const [k, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(k);
    }
    for (const k of this.store.keys()) {
      if (this.store.size <= this.maxEntries) break;
      this.store.delete(k);
    }
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}
