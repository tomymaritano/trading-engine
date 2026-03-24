import type { FeatureVector, TradingSignal } from "../types/signals.js";
import type { StrategyConfig } from "../config/index.js";

/**
 * Base class for all trading strategies.
 *
 * Strategies receive feature vectors and produce trading signals.
 * They should be:
 * - Stateless or use minimal state (for backtesting reproducibility)
 * - Fast: <1ms per evaluate() call
 * - Honest: confidence should be well-calibrated
 */
export abstract class Strategy {
  abstract readonly name: string;

  constructor(protected config: StrategyConfig) {}

  /** Evaluate features and optionally produce a signal */
  abstract evaluate(features: FeatureVector): TradingSignal | null;

  /** Reset any internal state (for backtesting between runs) */
  abstract reset(): void;

  /** Whether this strategy should run in the current regime */
  abstract isActiveInRegime(regime: string): boolean;
}
