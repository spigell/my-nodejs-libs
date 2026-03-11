export class CircularBuffer<T> {
  private readonly buf: (T | undefined)[];
  private start = 0;
  private length = 0;

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) {
      throw new Error('CircularBuffer maxSize must be at least 1.');
    }
    this.buf = new Array<T | undefined>(maxSize);
  }

  /** Add an item, dropping oldest if full */
  add(item: T): void {
    const writeIndex = (this.start + this.length) % this.maxSize;
    this.buf[writeIndex] = item;

    if (this.length < this.maxSize) {
      this.length++;
      return;
    }

    this.start = (this.start + 1) % this.maxSize;
  }

  /** Get up to the last `n` items (defaults to full buffer) */
  getLast(n: number = this.maxSize): T[] {
    const itemsToRead = Math.min(Math.max(n, 0), this.length);
    const offset = this.length - itemsToRead;
    const result: T[] = [];

    for (let index = 0; index < itemsToRead; index++) {
      const bufferIndex = (this.start + offset + index) % this.maxSize;
      const item = this.buf[bufferIndex];
      if (item !== undefined) {
        result.push(item);
      }
    }

    return result;
  }

  /** Clear the buffer entirely */
  clear(): void {
    this.buf.fill(undefined);
    this.start = 0;
    this.length = 0;
  }

  /** Current number of items */
  size(): number {
    return this.length;
  }
}
