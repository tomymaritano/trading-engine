import { Strategy } from "../strategy-base.js";
import { RingBuffer } from "../../utils/ring-buffer.js";
import { ema, stddev, clamp, linearSlope } from "../../utils/math.js";
import type { FeatureVector, TradingSignal, MarketRegime } from "../../types/signals.js";
import type { StrategyConfig } from "../../config/index.js";

/**
 * Volatility Regime Strategy
 *
 * Core thesis: volatility itself is mean-reverting and predictable.
 * By detecting regime transitions early, we can:
 * 1. Enter positions before vol expansion (buy breakouts)
 * 2. Fade moves during vol compression (mean reversion)
 * 3. Adjust strategy mix based on current regime
 *
 * Key insight: vol-of-vol (the volatility of volatility) is the
 * leading indicator. When vol-of-vol spikes, a regime change is
 * imminent — we just don't know which direction yet.
 *
 * Implementation:
 * - Track realized vol at multiple timescales (10s, 30s, 60s, 5m)
 * - Compute vol term structure: if short-term vol >> long-term vol, expanding
 * - Vol-of-vol as regime change predictor
 * - Combine with order flow for direction
 */
export class VolatilityRegimeStrategy extends Strategy {
  readonly name = "volatility_regime";

  private volHistory = new RingBuffer<{ ts: number; vol10s: number; vol60s: number; vov: number }>(200);
  private regimeHistory = new RingBuffer<MarketRegime>(50);
  private lastSignalTs = 0;

  private readonly volExpansionThreshold: number;
  private readonly vovSpikeThreshold: number;
  private readonly cooldownMs: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.volExpansionThreshold = (config.params.volExpansionThreshold as number) ?? 1.5;
    this.vovSpikeThreshold = (config.params.vovSpikeThreshold as number) ?? 2.0;
    this.cooldownMs = (config.params.cooldownMs as number) ?? 20_000;
  }

  evaluate(f: FeatureVector): TradingSignal | null {
    const now = f.ts;

    this.volHistory.push({
      ts: now,
      vol10s: f.realizedVol,
      vol60s: f.parkinsonVol,
      vov: f.volOfVol,
    });
    this.regimeHistory.push(f.regime);

    if (this.volHistory.size < 30) return null;
    if (now - this.lastSignalTs < this.cooldownMs) return null;

    const history = this.volHistory.toArray();
    const recentVovs = history.slice(-10).map((h) => h.vov);
    const olderVovs = history.slice(-30, -10).map((h) => h.vov);

    const recentVovMean = recentVovs.reduce((a, b) => a + b, 0) / recentVovs.length;
    const olderVovMean = olderVovs.reduce((a, b) => a + b, 0) / (olderVovs.length || 1);
    const olderVovSd = stddev(olderVovs);

    // ── Vol expansion detection ──────────────────────────────
    // Short-term vol significantly exceeds long-term vol
    const volTermStructure = f.parkinsonVol > 0 ? f.realizedVol / f.parkinsonVol : 1;
    const isExpanding = volTermStructure > this.volExpansionThreshold;

    // ── Vol-of-vol spike ─────────────────────────────────────
    // Leading indicator of regime change
    const vovZScore = olderVovSd > 0 ? (recentVovMean - olderVovMean) / olderVovSd : 0;
    const vovSpike = vovZScore > this.vovSpikeThreshold;

    // ── Regime transition signals ────────────────────────────
    const regimes = this.regimeHistory.toArray();
    const prevRegime = regimes[regimes.length - 2];
    const currentRegime = f.regime;

    // Strategy 1: Vol compression → expansion (breakout)
    if (isExpanding && prevRegime === "low_vol" && currentRegime !== "low_vol") {
      // Direction from order flow
      const direction = f.tradeImbalance > 0.1 ? "long" : f.tradeImbalance < -0.1 ? "short" : null;
      if (!direction) return null;

      const confidence = clamp(
        0.5 + (volTermStructure - 1) * 0.2 + Math.abs(f.tradeImbalance) * 0.3,
        0.4,
        0.85,
      );

      this.lastSignalTs = now;
      return {
        ts: now,
        symbol: f.symbol,
        exchange: "binance",
        direction,
        confidence,
        expectedReturn: f.realizedVol * 0.1, // fraction of vol as expected move
        horizon: 60,
        strategy: this.name,
        features: {
          realizedVol: f.realizedVol,
          volOfVol: f.volOfVol,
          regime: f.regime,
          tradeImbalance: f.tradeImbalance,
        },
        metadata: { phase: "vol_expansion", volTermStructure, vovZScore },
      };
    }

    // Strategy 2: Vol-of-vol spike (upcoming regime change)
    if (vovSpike && !isExpanding) {
      // VoV spike without expansion = something is brewing
      // Prepare for breakout by tightening stops, not entering yet
      // But if book imbalance is extreme, take a small position
      if (Math.abs(f.bookImbalanceTop5) > 0.5) {
        const direction = f.bookImbalanceTop5 > 0 ? "long" : "short";
        const confidence = clamp(0.4 + vovZScore * 0.1, 0.35, 0.65);

        this.lastSignalTs = now;
        return {
          ts: now,
          symbol: f.symbol,
          exchange: "binance",
          direction,
          confidence,
          expectedReturn: f.realizedVol * 0.05,
          horizon: 45,
          strategy: this.name,
          features: {
            realizedVol: f.realizedVol,
            volOfVol: f.volOfVol,
            bookImbalanceTop5: f.bookImbalanceTop5,
          },
          metadata: { phase: "vov_spike_anticipation", vovZScore },
        };
      }
    }

    // Strategy 3: Mean reversion in low-vol (fade extremes)
    if (currentRegime === "low_vol" && f.regimeConfidence > 0.6) {
      // In low vol, large price moves tend to revert
      if (Math.abs(f.tradeImbalance) > 0.4) {
        const direction = f.tradeImbalance > 0 ? "short" : "long"; // counter-trade
        const confidence = clamp(
          0.45 + Math.abs(f.tradeImbalance) * 0.3 - f.realizedVol * 5,
          0.35,
          0.7,
        );

        this.lastSignalTs = now;
        return {
          ts: now,
          symbol: f.symbol,
          exchange: "binance",
          direction,
          confidence,
          expectedReturn: 0.0005,
          horizon: 30,
          strategy: this.name,
          features: {
            realizedVol: f.realizedVol,
            regime: f.regime,
            tradeImbalance: f.tradeImbalance,
          },
          metadata: { phase: "low_vol_mean_reversion" },
        };
      }
    }

    return null;
  }

  reset(): void {
    this.volHistory.clear();
    this.regimeHistory.clear();
    this.lastSignalTs = 0;
  }

  isActiveInRegime(_regime: string): boolean {
    // This strategy adapts to all regimes
    return true;
  }
}
