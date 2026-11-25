/**
 * Small async mutex. Commits, undo/redo and background flushes all serialize on
 * it. Reads (rendering) never take it: they only ever see a committed manifest.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private depth = 0;
  private waiters = 0;

  get held(): boolean {
    return this.depth > 0;
  }

  get pending(): number {
    return this.waiters;
  }

  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    this.waiters++;
    const prev = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prev;
      this.waiters--;
      this.depth++;
      return await fn();
    } finally {
      if (this.depth > 0) this.depth--;
      release();
    }
  }
}
