import { Injectable, OnModuleDestroy } from '@nestjs/common';

interface Entry {
  value: unknown;
  expires: number;
}

/**
 * Tiny in-process TTL cache — no external dependency (no Redis). Good for
 * caching hot, read-heavy aggregates (dashboard, permissions, organogram).
 *
 * Note: this is per-process. If you later run multiple workers, each keeps its
 * own copy — fine for short-TTL read caching (slightly lower hit rate, never
 * stale beyond the TTL).
 */
@Injectable()
export class MemoryCacheService implements OnModuleDestroy {
  private readonly store = new Map<string, Entry>();
  private readonly sweeper: NodeJS.Timeout;

  constructor() {
    // Drop expired entries every 5 minutes so the map can't grow unbounded.
    this.sweeper = setInterval(() => this.sweep(), 5 * 60_000);
    this.sweeper.unref?.();
  }

  get<T>(key: string): T | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expires) {
      this.store.delete(key);
      return undefined;
    }
    return e.value as T;
  }

  set(key: string, value: unknown, ttlMs: number): void {
    this.store.set(key, { value, expires: Date.now() + ttlMs });
  }

  /** Return the cached value, or compute + cache it on a miss. */
  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.get<T>(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  /** Invalidate every key starting with `prefix` (e.g. "perms:" on role change). */
  deleteByPrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, e] of this.store) {
      if (now > e.expires) this.store.delete(key);
    }
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }
}
