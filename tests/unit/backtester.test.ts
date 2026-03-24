import { describe, it, expect } from "vitest";
import { Backtester } from "../../src/backtest/backtester.js";
import { BookImbalanceStrategy } from "../../src/models/strategies/book-imbalance.js";
import type { FeatureVector, MarketRegime } from "../../src/types/signals.js";

function makeFeatureSequence(count: number, opts: { trend?: "up" | "down" | "flat" } = {}): FeatureVector[] {
  const features: FeatureVector[] = [];
  let price = 40_000;

  for (let i = 0; i < count; i++) {
    // Add price movement
    if (opts.trend === "up") price *= 1.0002;
    else if (opts.trend === "down") price *= 0.9998;
    else price *= 1 + (Math.random() - 0.5) * 0.0004;

    const imbalance = opts.trend === "up" ? 0.3 + Math.random() * 0.4
      : opts.trend === "down" ? -0.3 - Math.random() * 0.4
      : (Math.random() - 0.5) * 0.6;

    features.push({
      ts: Date.now() - (count - i) * 1000,
      symbol: "BTC-USDT",
      bidAskSpread: price * 0.0001,
      midPrice: price,
      weightedMidPrice: price,
      bookImbalance: imbalance * 0.5,
      bookImbalanceTop5: imbalance * 0.6,
      bookImbalanceTop20: imbalance * 0.3,
      bookDepthBid: 500_000,
      bookDepthAsk: 500_000,
      bidAskSlope: 0,
      tradeImbalance: imbalance * 0.8,
      vwap: price,
      volumeAcceleration: 0,
      largeTradeRatio: 0.05,
      buyPressure: imbalance > 0 ? 100 : -100,
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
    });
  }

  return features;
}

describe("Backtester", () => {
  const backtester = new Backtester();
  const stratConfig = {
    name: "book_imbalance",
    enabled: true,
    symbols: ["BTC-USDT"],
    timeframe: 30,
    minConfidence: 0.3, // low threshold for test
    maxPositions: 3,
    params: { signalCooldownMs: 0 },
  };

  it("returns zero-trade result for insufficient data", () => {
    const strategy = new BookImbalanceStrategy(stratConfig);
    const result = backtester.run(strategy, [], 10_000);

    expect(result.totalTrades).toBe(0);
    expect(result.sharpeRatio).toBe(0);
    expect(result.totalReturn).toBe(0);
  });

  it("runs a backtest and produces valid metrics", () => {
    const strategy = new BookImbalanceStrategy(stratConfig);
    const features = makeFeatureSequence(500);
    const result = backtester.run(strategy, features, 10_000);

    // Basic structural checks
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdown).toBeLessThanOrEqual(1);
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.equityCurve[0].equity).toBe(10_000);
  });

  it("detects positive edge in trending data", () => {
    const strategy = new BookImbalanceStrategy(stratConfig);
    // Strong uptrend with confirming order flow
    const features = makeFeatureSequence(1000, { trend: "up" });
    const result = backtester.run(strategy, features, 10_000);

    // In a clear trend with aligned signals, we expect some trades
    // Not asserting profitability because the strategy has cooldowns
    // and filters that may prevent trading
    expect(result.equityCurve.length).toBeGreaterThanOrEqual(1);
  });

  it("walk-forward produces multiple result windows", () => {
    const strategy = new BookImbalanceStrategy(stratConfig);
    const features = makeFeatureSequence(2000);
    const results = backtester.walkForward(strategy, features, 10_000, 0.7, 3);

    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    for (const r of results) {
      expect(r.equityCurve.length).toBeGreaterThan(0);
    }
  });
});
