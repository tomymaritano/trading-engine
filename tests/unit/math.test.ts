import { describe, it, expect } from "vitest";
import {
  ema, stddev, skewness, kurtosis, parkinsonVolatility,
  weightedMidPrice, bookImbalance, vwap, linearSlope, clamp,
} from "../../src/utils/math.js";

describe("ema", () => {
  it("returns the single value for length-1 input", () => {
    expect(ema([42], 0.5)).toBe(42);
  });

  it("applies exponential weighting", () => {
    const result = ema([10, 20, 30], 0.5);
    // Manual: start=10, then 0.5*20 + 0.5*10 = 15, then 0.5*30 + 0.5*15 = 22.5
    expect(result).toBe(22.5);
  });
});

describe("stddev", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(stddev([5])).toBe(0);
  });

  it("computes population standard deviation", () => {
    const sd = stddev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(sd).toBeCloseTo(2.0, 1);
  });
});

describe("skewness", () => {
  it("returns 0 for symmetric distributions", () => {
    const symmetric = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(Math.abs(skewness(symmetric))).toBeLessThan(0.1);
  });
});

describe("kurtosis", () => {
  it("returns near 0 for normal-like distributions", () => {
    // A uniform distribution has negative excess kurtosis
    const uniform = Array.from({ length: 100 }, (_, i) => i);
    const k = kurtosis(uniform);
    expect(k).toBeLessThan(0); // uniform has kurtosis < 0 (platykurtic)
  });
});

describe("parkinsonVolatility", () => {
  it("returns 0 for empty input", () => {
    expect(parkinsonVolatility([])).toBe(0);
  });

  it("computes volatility from high-low ranges", () => {
    const bars = [
      { high: 105, low: 95 },
      { high: 108, low: 92 },
      { high: 103, low: 97 },
    ];
    const vol = parkinsonVolatility(bars);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(1);
  });
});

describe("weightedMidPrice", () => {
  it("returns simple mid when quantities are equal", () => {
    expect(weightedMidPrice(100, 10, 102, 10)).toBe(101);
  });

  it("shifts toward the side with more depth", () => {
    // Weighted mid: bidPrice * askQty + askPrice * bidQty / total
    // More ask depth → mid shifts toward bid price (heavier ask side weighs bid)
    const mid = weightedMidPrice(100, 5, 102, 20);
    expect(mid).toBeLessThan(101); // shifted toward bid because ask has more depth
    expect(mid).toBeCloseTo(100.4, 1);
  });
});

describe("bookImbalance", () => {
  it("returns 0 when balanced", () => {
    expect(bookImbalance(50, 50)).toBe(0);
  });

  it("returns +1 when all bids", () => {
    expect(bookImbalance(100, 0)).toBe(1);
  });

  it("returns -1 when all asks", () => {
    expect(bookImbalance(0, 100)).toBe(-1);
  });
});

describe("vwap", () => {
  it("computes volume-weighted average price", () => {
    const trades = [
      { price: 100, qty: 10 },
      { price: 102, qty: 20 },
    ];
    // (100*10 + 102*20) / 30 = 3040/30 ≈ 101.33
    expect(vwap(trades)).toBeCloseTo(101.33, 1);
  });
});

describe("linearSlope", () => {
  it("returns positive slope for ascending data", () => {
    expect(linearSlope([1, 2, 3, 4, 5])).toBeCloseTo(1, 5);
  });

  it("returns 0 for flat data", () => {
    expect(linearSlope([5, 5, 5, 5])).toBe(0);
  });
});

describe("clamp", () => {
  it("clamps values to range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});
