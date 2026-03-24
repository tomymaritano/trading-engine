import Decimal from "decimal.js";
import { bus } from "../utils/event-bus.js";
import type { Exchange, Symbol, PriceLevel, OrderBookDelta, OrderBookSnapshot } from "../types/market.js";

/**
 * Maintains a local order book from delta updates.
 *
 * The book is stored as sorted arrays of price levels.
 * On each delta, we merge levels: qty=0 means remove, otherwise upsert.
 *
 * For latency-sensitive feature computation, we cache the top-N
 * aggregates (bid depth, ask depth, imbalance) on every update
 * rather than recomputing on demand.
 */
export class OrderBookManager {
  private books = new Map<string, LocalBook>();

  constructor() {
    bus.on("market:book_delta", (delta) => this.applyDelta(delta));
    bus.on("market:book_snapshot", (snap) => this.applySnapshot(snap));
  }

  getBook(exchange: Exchange, symbol: Symbol): LocalBook | undefined {
    return this.books.get(`${exchange}:${symbol}`);
  }

  private applySnapshot(snap: OrderBookSnapshot): void {
    const key = `${snap.exchange}:${snap.symbol}`;
    const book = new LocalBook(snap.exchange, snap.symbol);
    book.bids = [...snap.bids];
    book.asks = [...snap.asks];
    book.lastSeq = snap.seq;
    book.lastUpdateTs = snap.ts;
    book.updateCachedMetrics();
    this.books.set(key, book);
  }

  private applyDelta(delta: OrderBookDelta): void {
    const key = `${delta.exchange}:${delta.symbol}`;
    let book = this.books.get(key);

    if (!book) {
      book = new LocalBook(delta.exchange, delta.symbol);
      this.books.set(key, book);
    }

    // Gap detection: if we skip sequence numbers, request a snapshot
    if (book.lastSeq > 0 && delta.seq > book.lastSeq + 1) {
      bus.emit("feature:anomaly", {
        symbol: delta.symbol,
        type: "book_gap",
        severity: 0.7,
        details: `Sequence gap: expected ${book.lastSeq + 1}, got ${delta.seq}`,
      });
    }

    book.mergeLevels(book.bids, delta.bids, "desc");
    book.mergeLevels(book.asks, delta.asks, "asc");
    book.lastSeq = delta.seq;
    book.lastUpdateTs = delta.ts;
    book.updateCachedMetrics();
  }
}

export class LocalBook {
  bids: PriceLevel[] = [];
  asks: PriceLevel[] = [];
  lastSeq = 0;
  lastUpdateTs = 0;

  // Cached metrics (updated on every delta)
  cachedMidPrice = 0;
  cachedWeightedMid = 0;
  cachedSpread = 0;
  cachedSpreadBps = 0;
  cachedImbalanceTop5 = 0;
  cachedImbalanceTop20 = 0;
  cachedBidDepth = 0;
  cachedAskDepth = 0;

  constructor(
    readonly exchange: Exchange,
    readonly symbol: Symbol,
  ) {}

  get bestBid(): PriceLevel | undefined {
    return this.bids[0];
  }

  get bestAsk(): PriceLevel | undefined {
    return this.asks[0];
  }

  /**
   * Merge delta levels into existing book side.
   * qty = 0 → remove level. Otherwise upsert.
   */
  mergeLevels(
    existing: PriceLevel[],
    updates: PriceLevel[],
    sort: "asc" | "desc",
  ): void {
    for (const update of updates) {
      const idx = existing.findIndex((l) => l.price.eq(update.price));

      if (update.qty.isZero()) {
        // Remove level
        if (idx >= 0) existing.splice(idx, 1);
      } else if (idx >= 0) {
        // Update existing level
        existing[idx] = update;
      } else {
        // Insert new level in sorted position
        const insertIdx = existing.findIndex((l) =>
          sort === "desc"
            ? l.price.lt(update.price)
            : l.price.gt(update.price),
        );
        if (insertIdx === -1) {
          existing.push(update);
        } else {
          existing.splice(insertIdx, 0, update);
        }
      }
    }
  }

  updateCachedMetrics(): void {
    const bb = this.bestBid;
    const ba = this.bestAsk;
    if (!bb || !ba) return;

    const bidP = bb.price.toNumber();
    const askP = ba.price.toNumber();
    this.cachedMidPrice = (bidP + askP) / 2;
    this.cachedSpread = askP - bidP;
    this.cachedSpreadBps = this.cachedMidPrice > 0
      ? (this.cachedSpread / this.cachedMidPrice) * 10000
      : 0;

    // Weighted mid: inversely weighted by depth at top of book
    const bidQ = bb.qty.toNumber();
    const askQ = ba.qty.toNumber();
    const totalQ = bidQ + askQ;
    this.cachedWeightedMid = totalQ > 0
      ? (bidP * askQ + askP * bidQ) / totalQ
      : this.cachedMidPrice;

    // Imbalance top 5
    this.cachedImbalanceTop5 = this.computeImbalance(5);
    this.cachedImbalanceTop20 = this.computeImbalance(20);

    // Total depth
    this.cachedBidDepth = this.bids
      .slice(0, 20)
      .reduce((sum, l) => sum + l.price.toNumber() * l.qty.toNumber(), 0);
    this.cachedAskDepth = this.asks
      .slice(0, 20)
      .reduce((sum, l) => sum + l.price.toNumber() * l.qty.toNumber(), 0);
  }

  private computeImbalance(levels: number): number {
    let bidQty = 0;
    let askQty = 0;
    for (let i = 0; i < Math.min(levels, this.bids.length); i++) {
      bidQty += this.bids[i].qty.toNumber();
    }
    for (let i = 0; i < Math.min(levels, this.asks.length); i++) {
      askQty += this.asks[i].qty.toNumber();
    }
    const total = bidQty + askQty;
    return total > 0 ? (bidQty - askQty) / total : 0;
  }

  /** Cumulative depth at a given price distance from mid (in bps) */
  depthAtDistance(side: "bid" | "ask", distanceBps: number): number {
    const mid = this.cachedMidPrice;
    if (mid === 0) return 0;

    const threshold = side === "bid"
      ? mid * (1 - distanceBps / 10000)
      : mid * (1 + distanceBps / 10000);

    const levels = side === "bid" ? this.bids : this.asks;
    let depth = 0;
    for (const l of levels) {
      const p = l.price.toNumber();
      if (side === "bid" && p < threshold) break;
      if (side === "ask" && p > threshold) break;
      depth += l.qty.toNumber() * p;
    }
    return depth;
  }
}

/** Singleton instance */
export const orderBookManager = new OrderBookManager();
