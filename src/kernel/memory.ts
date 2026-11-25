import { InsufficientMemoryError } from './errors';

export interface CacheStats {
  name: string;
  entries: number;
  bytes: number;
  peakBytes: number;
  budgetBytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

interface Entry<V> {
  value: V;
  bytes: number;
  stamp: number;
}

/**
 * Byte-budgeted LRU. Every cached tile is charged against a fixed budget; the
 * cache evicts least-recently-used entries before admitting a new one, and
 * refuses (rather than silently overrunning) when a single item cannot fit.
 * Nothing about a canvas is ever allocated eagerly; only touched tiles exist.
 */
export class BudgetedLru<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly stats: CacheStats;
  private clock = 0;

  constructor(name: string, budgetBytes: number) {
    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) throw new RangeError('budgetBytes must be >= 0');
    this.stats = {
      name,
      entries: 0,
      bytes: 0,
      peakBytes: 0,
      budgetBytes,
      hits: 0,
      misses: 0,
      evictions: 0,
    };
  }

  get budgetBytes(): number {
    return this.stats.budgetBytes;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.stats.bytes;
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  peek(key: string): V | undefined {
    return this.map.get(key)?.value;
  }

  touch(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) {
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    e.stamp = ++this.clock;
    return e.value;
  }

  /** Insert/replace, charging `bytes`. Evicts LRU entries until it fits. */
  set(key: string, value: V, bytes: number): void {
    if (bytes < 0) throw new RangeError('bytes must be >= 0');
    if (bytes > this.stats.budgetBytes) {
      throw new InsufficientMemoryError(bytes, this.stats.budgetBytes - this.stats.bytes);
    }
    const existing = this.map.get(key);
    if (existing) {
      this.stats.bytes -= existing.bytes;
      this.map.delete(key);
    }
    this.evictUntil(bytes);
    this.map.set(key, { value, bytes, stamp: ++this.clock });
    this.stats.bytes += bytes;
    this.stats.entries = this.map.size;
    if (this.stats.bytes > this.stats.peakBytes) this.stats.peakBytes = this.stats.bytes;
  }

  delete(key: string): boolean {
    const e = this.map.get(key);
    if (!e) return false;
    this.map.delete(key);
    this.stats.bytes -= e.bytes;
    this.stats.entries = this.map.size;
    return true;
  }

  /** Drop every entry matching a predicate. */
  deleteWhere(pred: (key: string, value: V) => boolean): number {
    let removed = 0;
    for (const [k, e] of [...this.map]) {
      if (pred(k, e.value)) {
        this.map.delete(k);
        this.stats.bytes -= e.bytes;
        removed++;
      }
    }
    this.stats.entries = this.map.size;
    return removed;
  }

  clear(resetPeak = false): void {
    this.map.clear();
    this.stats.bytes = 0;
    this.stats.entries = 0;
    if (resetPeak) this.stats.peakBytes = 0;
  }

  /** Change the budget, evicting LRU entries until the new cap holds. */
  setBudget(budgetBytes: number): void {
    if (!Number.isFinite(budgetBytes) || budgetBytes < 0) throw new RangeError('budgetBytes must be >= 0');
    this.stats.budgetBytes = budgetBytes;
    this.evictUntil(0);
  }

  private evictUntil(incoming: number): void {
    while (this.stats.bytes + incoming > this.stats.budgetBytes && this.map.size > 0) {
      let oldestKey: string | null = null;
      let oldestStamp = Infinity;
      for (const [k, e] of this.map) {
        if (e.stamp < oldestStamp) {
          oldestStamp = e.stamp;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      const e = this.map.get(oldestKey)!;
      this.map.delete(oldestKey);
      this.stats.bytes -= e.bytes;
      this.stats.evictions++;
    }
    this.stats.entries = this.map.size;
  }

  snapshot(): CacheStats {
    return { ...this.stats };
  }
}

export function tileBytes(w: number, h: number): number {
  return w * h * 4;
}
