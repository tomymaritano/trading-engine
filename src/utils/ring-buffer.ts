/**
 * Fixed-size ring buffer for time-series windows.
 *
 * Used throughout the feature engine to maintain rolling windows
 * of trades, prices, and computed metrics without allocating.
 * O(1) push, O(1) access by index, zero GC pressure once full.
 */
export class RingBuffer<T> {
  private _buf: (T | undefined)[];
  private _head = 0;
  private _size = 0;
  private readonly _capacity: number;

  constructor(capacity: number) {
    this._capacity = capacity;
    this._buf = new Array(capacity);
  }

  push(item: T): void {
    this._buf[this._head] = item;
    this._head = (this._head + 1) % this._capacity;
    if (this._size < this._capacity) this._size++;
  }

  /** Get item by age: 0 = most recent, 1 = second most recent, etc. */
  get(age: number): T | undefined {
    if (age >= this._size) return undefined;
    const idx = (this._head - 1 - age + this._capacity) % this._capacity;
    return this._buf[idx];
  }

  /** Most recent item */
  latest(): T | undefined {
    return this.get(0);
  }

  /** Oldest item in the buffer */
  oldest(): T | undefined {
    return this.get(this._size - 1);
  }

  get size(): number {
    return this._size;
  }

  get capacity(): number {
    return this._capacity;
  }

  get full(): boolean {
    return this._size === this._capacity;
  }

  /** Iterate from oldest to newest */
  *[Symbol.iterator](): Generator<T> {
    for (let i = this._size - 1; i >= 0; i--) {
      const item = this.get(i);
      if (item !== undefined) yield item;
    }
  }

  /** Convert to array (oldest first) */
  toArray(): T[] {
    return [...this];
  }

  clear(): void {
    this._buf = new Array(this._capacity);
    this._head = 0;
    this._size = 0;
  }
}
