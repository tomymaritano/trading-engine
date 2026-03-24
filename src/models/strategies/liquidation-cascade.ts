import { Strategy } from "../strategy-base.js";
import { RingBuffer } from "../../utils/ring-buffer.js";
import { clamp, stddev } from "../../utils/math.js";
import type { FeatureVector, TradingSignal } from "../../types/signals.js";
import type { StrategyConfig } from "../../config/index.js";

/**
 * Liquidation Cascade Strategy
 *
 * Core thesis: large liquidation events create cascading price moves.
 * When leveraged positions get liquidated, the exchange market-sells
 * the collateral, which pushes price further, triggering more liquidations.
 *
 * Detection:
 * 1. Monitor liquidation volume over rolling windows (10s, 30s, 60s)
 * 2. Detect "cluster" events: liquidation volume > 3σ above mean
 * 3. After a cascade starts, predict continuation vs. exhaustion
 *
 * Entry logic:
 * - During initial cascade: trade WITH the cascade (momentum)
 * - After cascade exhaustion: counter-trade (mean reversion bounce)
 *
 * Cascade exhaustion signals:
 * - Liquidation rate declining (negative acceleration)
 * - Book depth refilling on the exhausted side
 * - Funding rate normalizing
 */
export class LiquidationCascadeStrategy extends Strategy {
  readonly name = "liquidation_cascade";

  private liqVolumeHistory = new RingBuffer<{ ts: number; volume: number; side: "long" | "short" }>(200);
  private cascadeActive = false;
  private cascadeSide: "long" | "short" = "long";
  private cascadeStartTs = 0;
  private lastSignalTs = 0;

  private readonly volumeThresholdSigma: number;
  private readonly cascadeMaxDurationMs: number;
  private readonly cooldownMs: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.volumeThresholdSigma = (config.params.volumeThresholdSigma as number) ?? 3;
    this.cascadeMaxDurationMs = (config.params.cascadeMaxDurationMs as number) ?? 60_000;
    this.cooldownMs = (config.params.cooldownMs as number) ?? 30_000;
  }

  evaluate(f: FeatureVector): TradingSignal | null {
    const now = f.ts;

    // Need liquidation pressure data
    if (f.liquidationPressure === 0) return null;

    // Track liquidation volume
    this.liqVolumeHistory.push({
      ts: now,
      volume: f.liquidationPressure,
      side: f.liquidationPressure > 0 ? "long" : "short", // positive = longs getting liquidated
    });

    if (this.liqVolumeHistory.size < 20) return null;

    // Cooldown
    if (now - this.lastSignalTs < this.cooldownMs) return null;

    const volumes = this.liqVolumeHistory.toArray().map((v) => Math.abs(v.volume));
    const meanVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const sdVol = stddev(volumes);

    const currentVol = Math.abs(f.liquidationPressure);
    const zScore = sdVol > 0 ? (currentVol - meanVol) / sdVol : 0;

    // ── Cascade detection ────────────────────────────────────
    if (!this.cascadeActive && zScore > this.volumeThresholdSigma) {
      // New cascade detected
      this.cascadeActive = true;
      this.cascadeSide = f.liquidationPressure > 0 ? "long" : "short";
      this.cascadeStartTs = now;

      // Trade WITH the cascade: longs liquidated → price dropping → go short
      const direction = this.cascadeSide === "long" ? "short" : "long";

      const confidence = clamp(zScore / 5, 0.5, 0.85);

      this.lastSignalTs = now;

      return {
        ts: now,
        symbol: f.symbol,
        exchange: "binance",
        direction,
        confidence,
        expectedReturn: 0.002 * zScore, // scale with cascade severity
        horizon: 30,
        strategy: this.name,
        features: {
          liquidationPressure: f.liquidationPressure,
          realizedVol: f.realizedVol,
          bookImbalance: f.bookImbalance,
        },
        metadata: { phase: "cascade_momentum", zScore },
      };
    }

    // ── Cascade exhaustion → counter-trade ───────────────────
    if (this.cascadeActive) {
      const cascadeDuration = now - this.cascadeStartTs;

      // Check for exhaustion
      const recentVols = this.liqVolumeHistory.toArray().slice(-5).map((v) => Math.abs(v.volume));
      const olderVols = this.liqVolumeHistory.toArray().slice(-15, -5).map((v) => Math.abs(v.volume));
      const recentAvg = recentVols.reduce((a, b) => a + b, 0) / (recentVols.length || 1);
      const olderAvg = olderVols.reduce((a, b) => a + b, 0) / (olderVols.length || 1);

      const isDecelerating = recentAvg < olderAvg * 0.5; // liq volume halved
      const bookRefilling =
        (this.cascadeSide === "long" && f.bookImbalance > 0.1) ||
        (this.cascadeSide === "short" && f.bookImbalance < -0.1);

      if (
        (cascadeDuration > this.cascadeMaxDurationMs || isDecelerating) &&
        bookRefilling
      ) {
        this.cascadeActive = false;

        // Counter-trade: bounce after exhaustion
        const direction = this.cascadeSide === "long" ? "long" : "short";
        const confidence = clamp(0.5 + (isDecelerating ? 0.15 : 0) + (bookRefilling ? 0.1 : 0), 0.4, 0.8);

        this.lastSignalTs = now;

        return {
          ts: now,
          symbol: f.symbol,
          exchange: "binance",
          direction,
          confidence,
          expectedReturn: 0.001,
          horizon: 60,
          strategy: this.name,
          features: {
            liquidationPressure: f.liquidationPressure,
            bookImbalance: f.bookImbalance,
          },
          metadata: { phase: "cascade_exhaustion", cascadeDurationMs: cascadeDuration },
        };
      }

      // Auto-expire cascade after max duration
      if (cascadeDuration > this.cascadeMaxDurationMs * 2) {
        this.cascadeActive = false;
      }
    }

    return null;
  }

  reset(): void {
    this.liqVolumeHistory.clear();
    this.cascadeActive = false;
    this.lastSignalTs = 0;
  }

  isActiveInRegime(regime: string): boolean {
    // This strategy specifically targets volatile / breakout regimes
    return regime === "volatile" || regime === "breakout" || regime === "trending_up" || regime === "trending_down";
  }
}
