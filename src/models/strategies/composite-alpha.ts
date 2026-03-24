import { Strategy } from "../strategy-base.js";
import { RingBuffer } from "../../utils/ring-buffer.js";
import { ema, stddev, clamp, linearSlope } from "../../utils/math.js";
import type { FeatureVector, TradingSignal, MarketRegime } from "../../types/signals.js";
import type { StrategyConfig } from "../../config/index.js";

/**
 * Composite Alpha Strategy
 *
 * This is the "real" strategy — it doesn't rely on any single signal.
 * Instead, it combines multiple orthogonal alpha sources into a
 * weighted ensemble score. Each source is independently weak, but
 * combined they're stronger than any individual strategy.
 *
 * Alpha sources (scored -1 to +1 each):
 *
 * 1. ORDER FLOW IMBALANCE (weight: 0.25)
 *    Book imbalance × trade imbalance agreement.
 *    Only fires when both agree (both positive or both negative).
 *    Disagreement → score = 0 (no signal, not negative).
 *
 * 2. VOLUME PROFILE (weight: 0.20)
 *    Volume acceleration + large trade ratio.
 *    Increasing volume with large trades = institutional activity.
 *    Score = direction of volume-weighted pressure.
 *
 * 3. VOLATILITY SURFACE (weight: 0.15)
 *    Vol term structure (short/long) + vol-of-vol.
 *    Expanding vol = breakout likely → momentum.
 *    Compressing vol = reversion likely → fade.
 *
 * 4. MICROSTRUCTURE QUALITY (weight: 0.15)
 *    Spread behavior + depth resilience.
 *    Tightening spread = confidence, widening = uncertainty.
 *    Used as a confidence multiplier, not direction signal.
 *
 * 5. FUNDING/SENTIMENT (weight: 0.10)
 *    Funding rate bias + liquidation pressure.
 *    Extreme funding → contrarian signal.
 *    Liquidation cascade → momentum signal.
 *
 * 6. REGIME ALIGNMENT (weight: 0.15)
 *    Adjust alpha sources based on current regime.
 *    Trending → boost momentum signals.
 *    Mean-reverting → boost contrarian signals.
 *    Volatile → reduce all weights, increase threshold.
 *
 * Signal generation:
 *   compositeScore = Σ(source_i × weight_i × regime_modifier_i)
 *   if |compositeScore| > dynamic_threshold → emit signal
 *
 * The threshold adapts to recent signal accuracy (feedback loop).
 */
export class CompositeAlphaStrategy extends Strategy {
  readonly name = "composite_alpha";

  private scoreHistory = new RingBuffer<{ ts: number; score: number; outcome?: number }>(500);
  private featureHistory = new RingBuffer<FeatureVector>(200);
  private lastSignalTs = 0;
  private dynamicThreshold = 0.35;

  // Track signal outcomes for threshold adaptation
  private recentOutcomes = new RingBuffer<{ predicted: number; actual: number }>(100);

  // Alpha source weights (tunable)
  private weights = {
    orderFlow: 0.25,
    volumeProfile: 0.20,
    volatilitySurface: 0.15,
    microstructure: 0.15,
    fundingSentiment: 0.10,
    regimeAlignment: 0.15,
  };

  private readonly cooldownMs: number;
  private readonly minLiquidity: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.cooldownMs = (config.params.cooldownMs as number) ?? 10_000;
    this.minLiquidity = (config.params.minLiquidity as number) ?? 0.3;
  }

  evaluate(f: FeatureVector): TradingSignal | null {
    this.featureHistory.push(f);
    if (this.featureHistory.size < 30) return null;

    // Pre-filters
    if (f.liquidityScore < this.minLiquidity) return null;
    if (f.ts - this.lastSignalTs < this.cooldownMs) return null;

    // ── Compute alpha sources ──────────────────────────────────
    const orderFlowScore = this.computeOrderFlow(f);
    const volumeScore = this.computeVolumeProfile(f);
    const volScore = this.computeVolatilitySurface(f);
    const microScore = this.computeMicrostructure(f);
    const sentimentScore = this.computeFundingSentiment(f);
    const regimeMultipliers = this.getRegimeMultipliers(f.regime);

    // ── Weighted composite ─────────────────────────────────────
    const compositeScore =
      orderFlowScore * this.weights.orderFlow * regimeMultipliers.orderFlow +
      volumeScore * this.weights.volumeProfile * regimeMultipliers.volume +
      volScore * this.weights.volatilitySurface * regimeMultipliers.vol +
      sentimentScore * this.weights.fundingSentiment * regimeMultipliers.sentiment;

    // Microstructure is a confidence multiplier, not directional
    const confidenceMultiplier = 0.7 + microScore * 0.3; // range: 0.4 to 1.0

    const finalScore = compositeScore * confidenceMultiplier;

    this.scoreHistory.push({ ts: f.ts, score: finalScore });

    // ── Dynamic threshold ──────────────────────────────────────
    if (Math.abs(finalScore) < this.dynamicThreshold) return null;

    // ── Build signal ───────────────────────────────────────────
    const direction = finalScore > 0 ? "long" : "short";

    // Confidence from score magnitude + regime confidence
    let confidence = clamp(
      Math.abs(finalScore) * 1.2 * confidenceMultiplier,
      0.35,
      0.92,
    );

    // Penalize if regime is uncertain
    if (f.regimeConfidence < 0.5) confidence *= 0.8;

    if (confidence < this.config.minConfidence) return null;

    // Expected return: scale with vol and score
    const expectedReturn = Math.abs(finalScore) * f.realizedVol * 0.05;

    this.lastSignalTs = f.ts;

    return {
      ts: f.ts,
      symbol: f.symbol,
      exchange: "binance",
      direction,
      confidence,
      expectedReturn,
      horizon: 45, // 45 seconds
      strategy: this.name,
      features: {
        bookImbalanceTop5: f.bookImbalanceTop5,
        tradeImbalance: f.tradeImbalance,
        realizedVol: f.realizedVol,
        liquidityScore: f.liquidityScore,
        regime: f.regime,
      },
      metadata: {
        compositeScore: finalScore,
        sources: {
          orderFlow: orderFlowScore,
          volume: volumeScore,
          volatility: volScore,
          micro: microScore,
          sentiment: sentimentScore,
        },
        threshold: this.dynamicThreshold,
      },
    };
  }

  /**
   * Order flow: book imbalance × trade imbalance agreement.
   * Both must agree for a non-zero score.
   */
  private computeOrderFlow(f: FeatureVector): number {
    const bookSignal = f.bookImbalanceTop5;
    const tradeSignal = f.tradeImbalance;

    // Only signal when both agree
    if (bookSignal > 0.1 && tradeSignal > 0.1) {
      return clamp(Math.min(bookSignal, tradeSignal) * 2, 0, 1);
    }
    if (bookSignal < -0.1 && tradeSignal < -0.1) {
      return clamp(Math.max(bookSignal, tradeSignal) * 2, -1, 0);
    }
    return 0; // disagreement → no signal
  }

  /**
   * Volume profile: acceleration + institutional presence.
   */
  private computeVolumeProfile(f: FeatureVector): number {
    // Volume acceleration direction
    const accelScore = clamp(f.volumeAcceleration * 10, -1, 1);

    // Large trade ratio boost (institutional)
    const institutionalBoost = f.largeTradeRatio > 0.1 ? 1.3 : 1.0;

    // Direction from buy pressure
    const pressureDir = f.buyPressure > 0 ? 1 : f.buyPressure < 0 ? -1 : 0;

    return clamp(accelScore * pressureDir * institutionalBoost, -1, 1);
  }

  /**
   * Volatility surface: term structure + vol-of-vol.
   */
  private computeVolatilitySurface(f: FeatureVector): number {
    if (f.parkinsonVol === 0) return 0;

    const termStructure = f.realizedVol / f.parkinsonVol; // >1 = expanding

    if (termStructure > 1.5) {
      // Vol expanding → momentum signal (trade with the move)
      return clamp(f.tradeImbalance * (termStructure - 1), -0.8, 0.8);
    }

    if (termStructure < 0.7) {
      // Vol compressing → mean reversion (fade the move)
      return clamp(-f.tradeImbalance * (1 - termStructure), -0.6, 0.6);
    }

    return 0;
  }

  /**
   * Microstructure quality: spread + resilience.
   * Returns 0-1 (confidence multiplier, not direction).
   */
  private computeMicrostructure(f: FeatureVector): number {
    // Tight spread = good
    const spreadScore = clamp(1 - f.spreadVolatility / 5, 0, 1);

    // High resilience = good
    const resilienceScore = f.depthResilience;

    // High liquidity = good
    const liquidityBonus = f.liquidityScore;

    return (spreadScore * 0.3 + resilienceScore * 0.3 + liquidityBonus * 0.4);
  }

  /**
   * Funding/sentiment: contrarian at extremes, momentum at cascade.
   */
  private computeFundingSentiment(f: FeatureVector): number {
    let score = 0;

    // Extreme funding → contrarian
    if (Math.abs(f.fundingRate) > 0.0003) { // 0.03%
      score += -Math.sign(f.fundingRate) * clamp(Math.abs(f.fundingRate) * 1000, 0, 0.5);
    }

    // Liquidation cascade → momentum
    if (Math.abs(f.liquidationPressure) > 0) {
      const liqDirection = f.liquidationPressure > 0 ? -1 : 1; // long liqs = bearish
      score += liqDirection * clamp(Math.abs(f.liquidationPressure) / 100000, 0, 0.5);
    }

    return clamp(score, -1, 1);
  }

  /**
   * Regime-dependent weight multipliers.
   */
  private getRegimeMultipliers(regime: MarketRegime): {
    orderFlow: number;
    volume: number;
    vol: number;
    sentiment: number;
  } {
    switch (regime) {
      case "trending_up":
      case "trending_down":
        return { orderFlow: 1.2, volume: 1.3, vol: 0.8, sentiment: 0.9 };
      case "mean_reverting":
        return { orderFlow: 1.0, volume: 0.8, vol: 1.2, sentiment: 1.1 };
      case "volatile":
        return { orderFlow: 0.5, volume: 0.7, vol: 1.5, sentiment: 1.3 };
      case "low_vol":
        return { orderFlow: 0.9, volume: 0.6, vol: 1.3, sentiment: 0.8 };
      case "breakout":
        return { orderFlow: 1.4, volume: 1.5, vol: 1.0, sentiment: 0.7 };
      default:
        return { orderFlow: 1.0, volume: 1.0, vol: 1.0, sentiment: 1.0 };
    }
  }

  /**
   * Adapt threshold based on recent outcomes.
   * Called periodically to tune sensitivity.
   */
  adaptThreshold(): void {
    const outcomes = this.recentOutcomes.toArray();
    if (outcomes.length < 20) return;

    const accuracy = outcomes.filter((o) =>
      Math.sign(o.predicted) === Math.sign(o.actual),
    ).length / outcomes.length;

    // If accuracy < 50%, raise threshold (be more selective)
    // If accuracy > 65%, lower threshold (be more aggressive)
    if (accuracy < 0.50) {
      this.dynamicThreshold = Math.min(0.6, this.dynamicThreshold * 1.05);
    } else if (accuracy > 0.65) {
      this.dynamicThreshold = Math.max(0.2, this.dynamicThreshold * 0.95);
    }
  }

  /** Feed back the outcome of a signal for threshold adaptation */
  recordOutcome(predictedDirection: number, actualReturn: number): void {
    this.recentOutcomes.push({ predicted: predictedDirection, actual: actualReturn });
    this.adaptThreshold();
  }

  reset(): void {
    this.scoreHistory.clear();
    this.featureHistory.clear();
    this.recentOutcomes.clear();
    this.lastSignalTs = 0;
    this.dynamicThreshold = 0.35;
  }

  isActiveInRegime(_regime: string): boolean {
    return true; // adapts internally via regime multipliers
  }
}
