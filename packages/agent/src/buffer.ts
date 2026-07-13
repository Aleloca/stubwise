/**
 * A bounded FIFO ring buffer. New items append at the tail; when the buffer is
 * over `maxItems` the OLDEST items (at the head) are dropped. Used by the main
 * loop to hold pending metric samples and check results between ingest pushes,
 * so a server outage grows the buffer only up to a cap (2h of samples) instead
 * of unbounded memory.
 */
export class RingBuffer<T> {
  private items: T[] = [];
  private maxItems: number;

  constructor(maxItems: number) {
    // At least one slot: a zero/negative cap would make every push a no-op.
    this.maxItems = Math.max(1, Math.floor(maxItems));
  }

  get size(): number {
    return this.items.length;
  }

  /** Append one item; drop the oldest if this pushes past the cap. */
  push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  /** Return every buffered item (oldest → newest) and empty the buffer. */
  takeAll(): T[] {
    const out = this.items;
    this.items = [];
    return out;
  }

  /**
   * Put `items` back at the HEAD (they are older than whatever arrived since).
   * Used to return a failed batch to the buffer for the next retry. Respects the
   * cap by dropping the OLDEST items if the combined length overflows.
   */
  restore(items: T[]): void {
    this.items = [...items, ...this.items];
    this.trim();
  }

  /**
   * Adjust the cap (the sampling interval changed, so 2h holds a different number
   * of samples). Shrinking drops the oldest items to fit immediately.
   */
  setMaxItems(maxItems: number): void {
    this.maxItems = Math.max(1, Math.floor(maxItems));
    this.trim();
  }

  private trim(): void {
    if (this.items.length > this.maxItems) {
      this.items.splice(0, this.items.length - this.maxItems);
    }
  }
}
