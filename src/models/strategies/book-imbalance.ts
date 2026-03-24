import { Strategy } from "../strategy-base.js";
import { RingBuffer } from "../../utils/ring-buffer.js";
import { ema, clamp } from "../../utils/math.js";
import type { FeatureVector, TradingSignal, MarketRegime } from "../../types/signals.js";
import type { StrategyConfig } from "../../config/index.js";

/**
 * Order Book Imbalance Strategy
 *
 * Core thesis: when buy-side depth significantly exceeds sell-side
 * at the top of the book, price tends to move up in the next 30-60s.
 * This is because:
 * 1. Large limit orders signal informed buying intent
 * 2. Thin ask side means less resistance to upward movement
 * 3. Market makers widen asks and tighten bids in response
 *
 * Signal generation:
 * - Compute rolling EMA of book imbalance (fast: 5 ticks, slow: 20 ticks)
 * - When fast EMA crosses above threshold AND trade flow confirms → long
 * - Confidence scales with: imbalance magnitude × trade flow alignment × vol regime
 *
 * Filters:
 * - Minimum liquidity score (avoid illiquid garbage)
 * - Spread must be reasonable (< 10 bps)
 * - Not active in volatile regime (imbalance is noise in high vol)
 */
export class BookImbalanceStrategy extends Strategy {
  readonly name = "book_imbalance";

  private imbalanceHistory = new RingBuffer<number>(50);
  private signalCooldownMs: number;
  private lastSignalTs = 0;

  // Configurable thresholds
  private readonly imbalanceThreshold: number;
  private readonly tradeFlowConfirmation: number;
  private readonly maxSpreadBps: number;
  private readonly minLiquidity: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.imbalanceThreshold = (config.params.imbalanceThreshold as number) ?? 0.35;
    this.tradeFlowConfirmation = (config.params.tradeFlowConfirmation as number) ?? 0.15;
    this.maxSpreadBps = (config.params.maxSpreadBps as number) ?? 10;
    this.minLiquidity = (config.params.minLiquidity as number) ?? 0.3;
    this.signalCooldownMs = (config.params.signalCooldownMs as number) ?? 15_000;
  }

  evaluate(f: FeatureVector): TradingSignal | null {
    // ── Pre-filters ──────────────────────────────────────────
    if (f.liquidityScore < this.minLiquidity) return null;
    if (f.bidAskSpread > 0 && f.midPrice > 0) {
      const spreadBps = (f.bidAskSpread / f.midPrice) * 10000;
      if (spreadBps > this.maxSpreadBps) return null;
    }

    // Cooldown: don't spam signals
    if (f.ts - this.lastSignalTs < this.signalCooldownMs) return null;

    // ── Compute signal ───────────────────────────────────────
    this.imbalanceHistory.push(f.bookImbalanceTop5);
    if (this.imbalanceHistory.size < 10) return null;

    const values = this.imbalanceHistory.toArray();
    const fastEma = ema(values.slice(-5), 0.4);
    const slowEma = ema(values.slice(-20), 0.1);

    // Directional imbalance
    const imbalanceDelta = fastEma - slowEma;

    // Check if imbalance exceeds threshold
    if (Math.abs(imbalanceDelta) < this.imbalanceThreshold) return null;

    const direction = imbalanceDelta > 0 ? "long" : "short";

    // ── Trade flow confirmation ──────────────────────────────
    // The trade imbalance should agree with the book imbalance
    const tradeFlowAligned =
      (direction === "long" && f.tradeImbalance > this.tradeFlowConfirmation) ||
      (direction === "short" && f.tradeImbalance < -this.tradeFlowConfirmation);

    if (!tradeFlowAligned) return null;

    // ── Confidence scoring ───────────────────────────────────
    // Base confidence from imbalance magnitude
    let confidence = clamp(Math.abs(imbalanceDelta) * 1.5, 0.3, 0.95);

    // Boost if trade flow strongly confirms
    confidence *= 1 + clamp(Math.abs(f.tradeImbalance), 0, 0.3);

    // Penalize in high-vol regimes (imbalance less reliable)
    if (f.regime === "volatile") confidence *= 0.6;

    // Boost in trending regimes if aligned
    if (
      (f.regime === "trending_up" && direction === "long") ||
      (f.regime === "trending_down" && direction === "short")
    ) {
      confidence *= 1.15;
    }

    // Penalize large trades (could be spoofing)
    if (f.largeTradeRatio > 0.3) confidence *= 0.7;

    confidence = clamp(confidence, 0, 0.95);

    if (confidence < this.config.minConfidence) return null;

    // ── Expected return estimate ─────────────────────────────
    // Rough model: imbalance × spread × regime_factor
    const spreadReturn = f.bidAskSpread > 0 ? f.bidAskSpread / f.midPrice : 0.0001;
    const expectedReturn = Math.abs(imbalanceDelta) * spreadReturn * 2;

    this.lastSignalTs = f.ts;

    return {
      ts: f.ts,
      symbol: f.symbol,
      exchange: "binance", // Will be overridden by orchestrator
      direction: direction as "long" | "short",
      confidence,
      expectedReturn,
      horizon: 30, // 30 seconds
      strategy: this.name,
      features: {
        midPrice: f.midPrice,
        bookImbalanceTop5: f.bookImbalanceTop5,
        tradeImbalance: f.tradeImbalance,
        liquidityScore: f.liquidityScore,
        regime: f.regime,
      },
    };
  }

  reset(): void {
    this.imbalanceHistory.clear();
    this.lastSignalTs = 0;
  }

  isActiveInRegime(regime: string): boolean {
    // Don't trade in extreme volatility or breakout (imbalance is noise)
    return regime !== "volatile" && regime !== "breakout";
  }
}
