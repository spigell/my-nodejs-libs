export class CircularBuffer<T> {
  private buf: T[] = [];

  constructor(private readonly maxSize: number) {}

  /** Add an item, dropping oldest if full */
  add(item: T): void {
    if (this.buf.length >= this.maxSize) {
      this.buf.shift();
    }
    this.buf.push(item);
  }

  /** Get up to the last `n` items (defaults to full buffer) */
  getLast(n: number = this.maxSize): T[] {
    return this.buf.slice(-n);
  }

  /** Clear the buffer entirely */
  clear(): void {
    this.buf = [];
  }

  /** Current number of items */
  size(): number {
    return this.buf.length;
  }
}
