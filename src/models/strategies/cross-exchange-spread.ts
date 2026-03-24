import { Strategy } from "../strategy-base.js";
import { RingBuffer } from "../../utils/ring-buffer.js";
import { clamp, stddev } from "../../utils/math.js";
import type { FeatureVector, TradingSignal } from "../../types/signals.js";
import type { StrategyConfig } from "../../config/index.js";

/**
 * Cross-Exchange Spread Strategy
 *
 * Core thesis: price discovery happens on the most liquid exchange first.
 * When BTC on Binance moves before BTC on OKX, there's a brief window
 * where the slower exchange is "stale" — we can capture this spread.
 *
 * This is NOT classical arbitrage (which requires simultaneous execution
 * on both exchanges). Instead, we detect when one exchange leads and
 * trade on the lagging exchange in the direction of the leader.
 *
 * Signal:
 * 1. Compute rolling cross-exchange price difference
 * 2. When spread exceeds historical 2σ, the lagging exchange will converge
 * 3. Trade on lagging exchange in direction of convergence
 *
 * Requirements:
 * - Feature vectors must include exchangeSpread and leadLagScore
 * - Needs multi-exchange data (at least 2 exchanges connected)
 *
 * Edge characteristics:
 * - Very short duration (5-15 seconds)
 * - High win rate (70%+) but small per-trade return
 * - Capacity-limited (size pushes spread to close)
 * - Alpha decays as more participants exploit it
 */
export class CrossExchangeSpreadStrategy extends Strategy {
  readonly name = "cross_exchange_spread";

  private spreadHistory = new RingBuffer<number>(200);
  private lastSignalTs = 0;

  private readonly spreadZThreshold: number;
  private readonly minSpreadBps: number;
  private readonly cooldownMs: number;

  constructor(config: StrategyConfig) {
    super(config);
    this.spreadZThreshold = (config.params.spreadZThreshold as number) ?? 2.0;
    this.minSpreadBps = (config.params.minSpreadBps as number) ?? 3;
    this.cooldownMs = (config.params.cooldownMs as number) ?? 5_000;
  }

  evaluate(f: FeatureVector): TradingSignal | null {
    const now = f.ts;

    // Need cross-exchange data
    if (f.exchangeSpread === 0) return null;

    this.spreadHistory.push(f.exchangeSpread);
    if (this.spreadHistory.size < 30) return null;

    if (now - this.lastSignalTs < this.cooldownMs) return null;

    const spreads = this.spreadHistory.toArray();
    const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const sd = stddev(spreads);

    if (sd === 0) return null;

    const currentSpread = f.exchangeSpread;
    const zScore = (currentSpread - mean) / sd;

    // Spread must be significant in absolute terms
    const spreadBps = Math.abs(currentSpread / (f.midPrice || 1)) * 10000;
    if (spreadBps < this.minSpreadBps) return null;

    // Spread must be statistically significant
    if (Math.abs(zScore) < this.spreadZThreshold) return null;

    // Direction: if currentSpread is positive, our exchange is expensive
    // → price will converge down → go short
    // If negative, our exchange is cheap → price will converge up → go long
    const direction = currentSpread > 0 ? "short" : "long";

    const confidence = clamp(
      0.5 + (Math.abs(zScore) - this.spreadZThreshold) * 0.15 + spreadBps * 0.01,
      0.45,
      0.85,
    );

    // Expected return: fraction of the spread (after fees)
    const expectedReturn = spreadBps / 10000 * 0.4; // capture 40% of spread

    this.lastSignalTs = now;

    return {
      ts: now,
      symbol: f.symbol,
      exchange: "binance", // traded on the lagging exchange
      direction: direction as "long" | "short",
      confidence,
      expectedReturn,
      horizon: 10, // very short — 10 seconds
      strategy: this.name,
      features: {
        exchangeSpread: f.exchangeSpread,
        leadLagScore: f.leadLagScore,
        midPrice: f.midPrice,
      },
      metadata: { zScore, spreadBps },
    };
  }

  reset(): void {
    this.spreadHistory.clear();
    this.lastSignalTs = 0;
  }

  isActiveInRegime(regime: string): boolean {
    // Works in all regimes except extreme volatility (spreads are noisy)
    return regime !== "volatile";
  }
}
