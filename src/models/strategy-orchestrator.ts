import { bus } from "../utils/event-bus.js";
import { createChildLogger } from "../utils/logger.js";
import { Strategy } from "./strategy-base.js";
import { BookImbalanceStrategy } from "./strategies/book-imbalance.js";
import { LiquidationCascadeStrategy } from "./strategies/liquidation-cascade.js";
import { VolatilityRegimeStrategy } from "./strategies/volatility-regime.js";
import { CrossExchangeSpreadStrategy } from "./strategies/cross-exchange-spread.js";
import { CompositeAlphaStrategy } from "./strategies/composite-alpha.js";
import { DebateAgent } from "./debate-agent.js";
import type { FeatureVector, TradingSignal } from "../types/signals.js";
import type { AppConfig, StrategyConfig } from "../config/index.js";

const log = createChildLogger("strategy-orchestrator");

/**
 * Strategy Orchestrator — manages multiple strategies and merges signals.
 *
 * Responsibilities:
 * 1. Register and lifecycle-manage strategies
 * 2. Route feature vectors to active strategies
 * 3. Filter by regime (don't run mean-reversion strategies in trending markets)
 * 4. Merge conflicting signals (e.g., one says long, another says short)
 * 5. Emit final signals to the risk engine
 *
 * Signal merging logic:
 * - Concordant signals (same direction) → boost confidence
 * - Conflicting signals → take the higher confidence one IF delta > 0.2
 * - Otherwise → flat (no signal)
 */
export class StrategyOrchestrator {
  private strategies: Strategy[] = [];
  private disabledStrategies = new Set<string>();
  private signalCount = 0;
  private debateAgent = new DebateAgent();

  constructor(private config: AppConfig) {
    this.registerDefaultStrategies();
  }

  private registerDefaultStrategies(): void {
    const defaultConfig: StrategyConfig = {
      name: "",
      enabled: true,
      symbols: this.config.symbols,
      timeframe: 30,
      minConfidence: 0.5,
      maxPositions: 3,
      params: {},
    };

    this.strategies.push(
      new CompositeAlphaStrategy({ ...defaultConfig, name: "composite_alpha", minConfidence: 0.4 }),
      new BookImbalanceStrategy({ ...defaultConfig, name: "book_imbalance" }),
      new LiquidationCascadeStrategy({ ...defaultConfig, name: "liquidation_cascade" }),
      new VolatilityRegimeStrategy({ ...defaultConfig, name: "volatility_regime" }),
      new CrossExchangeSpreadStrategy({ ...defaultConfig, name: "cross_exchange_spread" }),
    );

    // Register custom strategies from config
    for (const sc of this.config.strategies) {
      if (sc.enabled) {
        log.info({ strategy: sc.name }, "Custom strategy registered (stub)");
      }
    }
  }

  start(): void {
    bus.on("feature:vector", (features) => this.onFeatures(features));
    log.info({ strategies: this.strategies.map((s) => s.name) }, "Strategy orchestrator started");
  }

  stop(): void {
    // Strategies are stateless listeners; nothing to clean up
  }

  private onFeatures(features: FeatureVector): void {
    const signals: TradingSignal[] = [];

    for (const strategy of this.strategies) {
      // Skip disabled strategies
      if (this.disabledStrategies.has(strategy.name)) continue;
      // Skip strategies that shouldn't run in current regime
      if (!strategy.isActiveInRegime(features.regime)) continue;

      try {
        const signal = strategy.evaluate(features);
        if (signal) {
          signals.push(signal);
        }
      } catch (err) {
        log.error({ strategy: strategy.name, err }, "Strategy evaluation error");
      }
    }

    if (signals.length === 0) return;

    // Merge signals
    const merged = this.mergeSignals(signals);
    if (merged) {
      // Ensure midPrice is always present (strategies may omit it)
      if (!merged.features.midPrice && features.midPrice > 0) {
        merged.features.midPrice = features.midPrice;
      }

      // Bull/Bear Debate (async, non-blocking)
      if (this.debateAgent.isEnabled) {
        this.debateAgent.debate(merged, features).then((debated) => {
          if (debated) {
            this.signalCount++;
            bus.emit("signal:new", debated);
          }
        }).catch(() => {
          // On debate error, emit original signal
          this.signalCount++;
          bus.emit("signal:new", merged);
        });
      } else {
        this.signalCount++;
        bus.emit("signal:new", merged);
      }

      log.debug(
        {
          symbol: merged.symbol,
          direction: merged.direction,
          confidence: merged.confidence.toFixed(3),
          strategy: merged.strategy,
        },
        "Signal emitted",
      );
    }
  }

  /**
   * Merge multiple strategy signals into a single actionable signal.
   *
   * This is where alpha from multiple strategies compounds.
   * Two independent signals pointing the same direction is much
   * stronger than either alone (assuming strategies are uncorrelated).
   */
  private mergeSignals(signals: TradingSignal[]): TradingSignal | null {
    if (signals.length === 1) return signals[0];

    // Group by direction
    const longs = signals.filter((s) => s.direction === "long");
    const shorts = signals.filter((s) => s.direction === "short");

    const longScore = longs.reduce((sum, s) => sum + s.confidence, 0);
    const shortScore = shorts.reduce((sum, s) => sum + s.confidence, 0);

    // If conflicting and close, no signal
    if (longs.length > 0 && shorts.length > 0) {
      const scoreDelta = Math.abs(longScore - shortScore);
      if (scoreDelta < 0.2) return null; // conflicting, skip
    }

    // Take the dominant direction
    const dominant = longScore >= shortScore ? longs : shorts;
    if (dominant.length === 0) return null;

    // Highest-confidence signal becomes the base
    dominant.sort((a, b) => b.confidence - a.confidence);
    const base = { ...dominant[0] };

    // Boost confidence for concordant signals (diminishing returns)
    if (dominant.length > 1) {
      const boostFactor = 1 + 0.1 * (dominant.length - 1);
      base.confidence = Math.min(0.95, base.confidence * boostFactor);
      base.strategy = dominant.map((s) => s.strategy).join("+");
    }

    return base;
  }

  /** Toggle a strategy on/off at runtime */
  toggleStrategy(name: string, enabled: boolean): void {
    if (enabled) {
      this.disabledStrategies.delete(name);
    } else {
      this.disabledStrategies.add(name);
    }
    log.info({ strategy: name, enabled }, "Strategy toggled");
  }

  /** Get list of strategies with enabled state */
  getStrategies(): Array<{ name: string; enabled: boolean }> {
    return this.strategies.map((s) => ({
      name: s.name,
      enabled: !this.disabledStrategies.has(s.name),
    }));
  }

  get stats() {
    return {
      strategies: this.strategies.map((s) => s.name),
      signalCount: this.signalCount,
    };
  }
}
