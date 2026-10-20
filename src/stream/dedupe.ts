/**
 * Remembers the last `capacity` keys. A transaction that touches both pump
 * programs (e.g. a graduation) arrives once per subscription; we play it once.
 */
export class RecentSet {
  private readonly items = new Set<string>();

  constructor(private readonly capacity: number) {}

  /** Returns true if the key is new (and records it). */
  add(key: string): boolean {
    if (this.items.has(key)) return false;
    this.items.add(key);
    if (this.items.size > this.capacity) {
      const oldest = this.items.values().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.items.size;
  }
}
