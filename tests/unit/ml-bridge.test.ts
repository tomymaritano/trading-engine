import { describe, it, expect } from "vitest";
import { MLBridge } from "../../src/models/ml-bridge.js";
import type { FeatureVector, MarketRegime } from "../../src/types/signals.js";

function makeFeatures(): FeatureVector {
  return {
    ts: Date.now(), symbol: "BTC-USDT",
    bidAskSpread: 0.5, midPrice: 42000, weightedMidPrice: 42000,
    bookImbalance: 0.3, bookImbalanceTop5: 0.4, bookImbalanceTop20: 0.2,
    bookDepthBid: 500000, bookDepthAsk: 400000, bidAskSlope: 0,
    tradeImbalance: 0.25, vwap: 42000, volumeAcceleration: 0,
    largeTradeRatio: 0.05, buyPressure: 100, aggTradeIntensity: 10,
    realizedVol: 0.3, volOfVol: 0.05, returnSkew: 0, returnKurtosis: 0,
    parkinsonVol: 0.25, liquidityScore: 0.7, spreadVolatility: 1,
    depthResilience: 0.5, exchangeSpread: 0, leadLagScore: 0,
    regime: "mean_reverting" as MarketRegime, regimeConfidence: 0.6,
    fundingRate: 0, liquidationPressure: 0, openInterestDelta: 0,
  };
}

describe("MLBridge", () => {
  it("reports unavailable when service is down", () => {
    const bridge = new MLBridge("http://localhost:99999");
    expect(bridge.isAvailable).toBe(false);
  });

  it("returns null prediction when unavailable", async () => {
    const bridge = new MLBridge("http://localhost:99999");
    const result = await bridge.predict(makeFeatures());
    expect(result).toBeNull();
  });

  it("returns null batch predictions when unavailable", async () => {
    const bridge = new MLBridge("http://localhost:99999");
    const results = await bridge.batchPredict([makeFeatures(), makeFeatures()]);
    expect(results).toEqual([null, null]);
  });
});
