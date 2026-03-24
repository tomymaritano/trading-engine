import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";
import { LocalBook } from "../../src/stream/order-book-manager.js";

function d(val: number): Decimal {
  return new Decimal(val);
}

describe("LocalBook", () => {
  it("computes correct mid price", () => {
    const book = new LocalBook("binance", "BTC-USDT");
    book.bids = [{ price: d(40000), qty: d(1) }];
    book.asks = [{ price: d(40010), qty: d(1) }];
    book.updateCachedMetrics();

    expect(book.cachedMidPrice).toBe(40005);
    expect(book.cachedSpread).toBe(10);
    expect(book.cachedSpreadBps).toBeCloseTo(2.5, 1); // 10/40005 * 10000
  });

  it("computes weighted mid that shifts toward heavy side", () => {
    const book = new LocalBook("binance", "BTC-USDT");
    book.bids = [{ price: d(100), qty: d(10) }]; // heavy bid
    book.asks = [{ price: d(102), qty: d(2) }];   // light ask
    book.updateCachedMetrics();

    // Weighted mid: (100*2 + 102*10) / 12 = 1220/12 ≈ 101.67
    // Shifts toward ask because bid has more depth
    expect(book.cachedWeightedMid).toBeCloseTo(101.67, 1);
  });

  it("computes positive imbalance when bids dominate", () => {
    const book = new LocalBook("binance", "BTC-USDT");
    book.bids = [
      { price: d(100), qty: d(10) },
      { price: d(99), qty: d(10) },
      { price: d(98), qty: d(10) },
      { price: d(97), qty: d(10) },
      { price: d(96), qty: d(10) },
    ];
    book.asks = [
      { price: d(101), qty: d(2) },
      { price: d(102), qty: d(2) },
      { price: d(103), qty: d(2) },
      { price: d(104), qty: d(2) },
      { price: d(105), qty: d(2) },
    ];
    book.updateCachedMetrics();

    // bidQty = 50, askQty = 10, imbalance = (50-10)/(50+10) = 0.667
    expect(book.cachedImbalanceTop5).toBeCloseTo(0.667, 2);
  });

  it("merges delta updates correctly — upsert", () => {
    const book = new LocalBook("binance", "BTC-USDT");
    book.bids = [
      { price: d(100), qty: d(5) },
      { price: d(99), qty: d(3) },
    ];

    // Update: change qty at 100, add new level at 99.5
    book.mergeLevels(book.bids, [
      { price: d(100), qty: d(8) },
      { price: d(99.5), qty: d(4) },
    ], "desc");

    expect(book.bids).toHaveLength(3);
    expect(book.bids[0].price.toNumber()).toBe(100);
    expect(book.bids[0].qty.toNumber()).toBe(8);
    expect(book.bids[1].price.toNumber()).toBe(99.5);
    expect(book.bids[2].price.toNumber()).toBe(99);
  });

  it("merges delta updates correctly — remove", () => {
    const book = new LocalBook("binance", "BTC-USDT");
    book.bids = [
      { price: d(100), qty: d(5) },
      { price: d(99), qty: d(3) },
    ];

    // qty = 0 means remove
    book.mergeLevels(book.bids, [{ price: d(100), qty: d(0) }], "desc");

    expect(book.bids).toHaveLength(1);
    expect(book.bids[0].price.toNumber()).toBe(99);
  });

  it("computes depth at distance", () => {
    const book = new LocalBook("binance", "BTC-USDT");
    book.bids = [
      { price: d(100), qty: d(5) },   // 500 notional
      { price: d(99), qty: d(10) },    // 990 notional
      { price: d(98), qty: d(20) },    // 1960 notional
    ];
    book.asks = [{ price: d(101), qty: d(1) }];
    book.updateCachedMetrics();

    // At 150 bps from mid (100.5), bid threshold = 100.5 * (1 - 0.015) ≈ 98.99
    // So levels 100 and 99 are within range: 500 + 990 = 1490
    const depth = book.depthAtDistance("bid", 150);
    expect(depth).toBeCloseTo(1490, -1);
  });
});
