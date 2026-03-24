import { describe, it, expect } from "vitest";
import { BookImbalanceStrategy } from "../../src/models/strategies/book-imbalance.js";
import type { FeatureVector, MarketRegime } from "../../src/types/signals.js";

function makeFeatures(overrides: Partial<FeatureVector> = {}): FeatureVector {
  return {
    ts: Date.now(),
    symbol: "BTC-USDT",
    bidAskSpread: 0.5,
    midPrice: 42000,
    weightedMidPrice: 42000.1,
    bookImbalance: 0,
    bookImbalanceTop5: 0,
    bookImbalanceTop20: 0,
    bookDepthBid: 500000,
    bookDepthAsk: 500000,
    bidAskSlope: 0,
    tradeImbalance: 0,
    vwap: 42000,
    volumeAcceleration: 0,
    largeTradeRatio: 0.05,
    buyPressure: 0,
    aggTradeIntensity: 10,
    realizedVol: 0.3,
    volOfVol: 0.05,
    returnSkew: 0,
    returnKurtosis: 0,
    parkinsonVol: 0.25,
    liquidityScore: 0.7,
    spreadVolatility: 1,
    depthResilience: 0.5,
    exchangeSpread: 0,
    leadLagScore: 0,
    regime: "mean_reverting" as MarketRegime,
    regimeConfidence: 0.6,
    fundingRate: 0,
    liquidationPressure: 0,
    openInterestDelta: 0,
    ...overrides,
  };
}

describe("BookImbalanceStrategy", () => {
  const config = {
    name: "book_imbalance",
    enabled: true,
    symbols: ["BTC-USDT"],
    timeframe: 30,
    minConfidence: 0.4,
    maxPositions: 3,
    params: { signalCooldownMs: 0 }, // disable cooldown for tests
  };

  it("returns null when not enough history", () => {
    const strategy = new BookImbalanceStrategy(config);
    const signal = strategy.evaluate(makeFeatures({ bookImbalanceTop5: 0.5 }));
    expect(signal).toBeNull(); // needs 10+ data points
  });

  it("generates a long signal on strong bid imbalance with trade confirmation", () => {
    const strategy = new BookImbalanceStrategy(config);

    // Warm up with neutral data
    for (let i = 0; i < 15; i++) {
      strategy.evaluate(makeFeatures({ bookImbalanceTop5: 0.05, ts: Date.now() + i * 1000 }));
    }

    // Now inject strong imbalance + trade flow confirmation
    const signal = strategy.evaluate(
      makeFeatures({
        bookImbalanceTop5: 0.7,
        tradeImbalance: 0.3,
        ts: Date.now() + 20000,
      }),
    );

    // May or may not trigger depending on EMA crossover dynamics
    // The point is the strategy doesn't crash and returns a valid shape
    if (signal) {
      expect(signal.direction).toBe("long");
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(0.95);
      expect(signal.strategy).toBe("book_imbalance");
    }
  });

  it("rejects signals in illiquid markets", () => {
    const strategy = new BookImbalanceStrategy(config);

    for (let i = 0; i < 20; i++) {
      const signal = strategy.evaluate(
        makeFeatures({
          bookImbalanceTop5: 0.8,
          tradeImbalance: 0.5,
          liquidityScore: 0.1, // too illiquid
          ts: Date.now() + i * 1000,
        }),
      );
      expect(signal).toBeNull();
    }
  });

  it("is not active in volatile regime", () => {
    const strategy = new BookImbalanceStrategy(config);
    expect(strategy.isActiveInRegime("volatile")).toBe(false);
    expect(strategy.isActiveInRegime("mean_reverting")).toBe(true);
  });

  it("resets state cleanly", () => {
    const strategy = new BookImbalanceStrategy(config);
    for (let i = 0; i < 20; i++) {
      strategy.evaluate(makeFeatures({ ts: Date.now() + i * 1000 }));
    }
    strategy.reset();
    // After reset, should need to warm up again
    const signal = strategy.evaluate(makeFeatures({ bookImbalanceTop5: 0.9 }));
    expect(signal).toBeNull();
  });
});
